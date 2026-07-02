const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

function tryRequirePdfToPrinterPrint() {
    try {
        const mod = require('pdf-to-printer');
        return typeof mod.print === 'function' ? mod.print : mod.default?.print;
    } catch {
        return null;
    }
}

/** SumatraPDF is used by pdf-to-printer; npm package does not ship the .exe — check common locations. */
function resolveSumatraExecutable() {
    const envPath = process.env.RESTIFY_SUMATRA_PATH;
    if (envPath && fs.existsSync(envPath)) {
        return envPath;
    }
    const candidates = [];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'vendor', 'SumatraPDF', 'SumatraPDF.exe'));
    }
    candidates.push(path.join(__dirname, '..', 'vendor', 'SumatraPDF', 'SumatraPDF.exe'));
    candidates.push(
        path.join(__dirname, '..', 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe')
    );
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(path.join(pf, 'SumatraPDF', 'SumatraPDF.exe'));
    candidates.push(path.join(pf86, 'SumatraPDF', 'SumatraPDF.exe'));
    for (const p of candidates) {
        if (p && fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

function resolveAcroRd32() {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
        path.join(pf, 'Adobe', 'Acrobat Reader DC', 'Reader', 'AcroRd32.exe'),
        path.join(pf86, 'Adobe', 'Acrobat Reader DC', 'Reader', 'AcroRd32.exe'),
        path.join(pf, 'Adobe', 'Acrobat DC', 'Acrobat', 'Acrobat.exe'),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnFileAsync(exePath, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(exePath, args, {
            windowsHide: true,
            stdio: 'ignore',
            ...options,
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${path.basename(exePath)} exited with code ${code}`));
            }
        });
    });
}

/** Written to %TEMP% at runtime so printing works inside packaged ASAR. */
const WINDOWS_THERMAL_PRINT_PS1 = String.raw`#requires -Version 5.0
param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string]$PrinterName
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $ImagePath)) {
    Write-Error "Image not found: $ImagePath"
    exit 1
}
Add-Type -AssemblyName System.Drawing
$img = $null
$pd = $null
try {
    $img = [System.Drawing.Image]::FromFile($ImagePath)
    $pd = New-Object System.Drawing.Printing.PrintDocument
    $pd.PrinterSettings.PrinterName = $PrinterName
    if (-not $pd.PrinterSettings.IsValid) {
        Write-Error "Printer not found or invalid: $PrinterName"
        exit 2
    }
    $pd.PrinterSettings.DefaultPageSettings.Landscape = $false
    $pd.DefaultPageSettings.Landscape = $false
    $pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
    try { $pd.DefaultPageSettings.Color = $false } catch { }

    # For thermal printers, try to use a large paper size to avoid pagination.
    # Receipts are continuous roll paper - we want one long virtual page.
    $paperSizes = $pd.PrinterSettings.PaperSizes
    $customSize = $null
    if ($paperSizes) {
        # Prefer 'Roll' or 'Custom' or the tallest paper size available
        foreach ($size in $paperSizes) {
            if ($size.Kind -eq [System.Drawing.Printing.PaperKind]::Roll -or
                $size.Kind -eq [System.Drawing.Printing.PaperKind]::Custom) {
                $customSize = $size
                break
            }
        }
        if (-not $customSize) {
            # Pick the tallest paper size (most likely to accommodate long receipts)
            $maxHeight = 0
            foreach ($size in $paperSizes) {
                if ($size.Height -gt $maxHeight) {
                    $maxHeight = $size.Height
                    $customSize = $size
                }
            }
        }
        if ($customSize) {
            $pd.DefaultPageSettings.PaperSize = $customSize
        }
    }

    $script:srcY = 0
    $script:scale = 0.0
    $script:chunkSrcH = 0

    $pd.add_PrintPage({
        param($sender, $e)
        $g = $e.Graphics
        $g.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $m = $e.MarginBounds
        $dpiX = $g.DpiX
        $dpiY = $g.DpiY
        # MarginBounds are in hundredths of an inch; convert to pixels for consistent scaling
        $mw = [int][Math]::Max(1, [Math]::Round($m.Width * $dpiX / 100.0))
        $mh = [int][Math]::Max(1, [Math]::Round($m.Height * $dpiY / 100.0))
        # Thermal drivers often use a "landscape" GDI box (mw > mh). Receipt PNGs are tall; roll width is the SHORT edge.
        $rollPx = [Math]::Min($mw, $mh)
        $feedPx = [Math]::Max($mw, $mh)
        if ($script:scale -eq 0.0) {
            $script:scale = [double]$rollPx / [double]$img.Width
            if ($script:scale -le 0) { $script:scale = 1.0 }
            $script:chunkSrcH = [int][Math]::Floor($feedPx / $script:scale)
            if ($script:chunkSrcH -lt 1) { $script:chunkSrcH = 1 }
        }
        $remaining = $img.Height - $script:srcY
        if ($remaining -le 0) {
            $e.HasMorePages = $false
            return
        }
        $take = [Math]::Min($script:chunkSrcH, $remaining)
        $destH = [int][Math]::Max(1, [Math]::Round($take * $script:scale))
        $srcRect = New-Object System.Drawing.Rectangle(0, $script:srcY, $img.Width, $take)
        $destRect = New-Object System.Drawing.Rectangle(0, 0, $rollPx, $destH)
        $g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        $script:srcY += $take
        $e.HasMorePages = ($script:srcY -lt $img.Height)
    })
    $pd.Print()
} finally {
    if ($null -ne $img) { $img.Dispose() }
    if ($null -ne $pd) { $pd.Dispose() }
}
`;

function spawnPromise(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: 'ignore',
            windowsHide: true,
            ...options,
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} exited with code ${code}`));
            }
        });
    });
}

class PrinterService {
    constructor() {
        this.printers = [];
    }

    async getSystemPrinters() {
        try {
            const platform = os.platform();
            let printers = [];

            if (platform === 'win32') {
                printers = await this.getWindowsPrinters();
            } else if (platform === 'darwin') {
                printers = await this.getMacPrinters();
            } else if (platform === 'linux') {
                printers = await this.getLinuxPrinters();
            }

            this.printers = printers;
            return printers;
        } catch (error) {
            console.error('Failed to get system printers:', error);
            return [];
        }
    }

    async getWindowsPrinters() {
        try {
            const { stdout } = await execPromise('wmic printer get name');
            const lines = stdout.split('\n').filter(line => line.trim() && line.trim() !== 'Name');
            
            return lines.map(name => ({
                name: name.trim(),
                type: 'windows'
            }));
        } catch (error) {
            console.error('Failed to get Windows printers:', error);
            return [];
        }
    }

    async getMacPrinters() {
        try {
            const { stdout } = await execPromise('lpstat -p');
            const lines = stdout.split('\n').filter(line => line.startsWith('printer'));
            
            return lines.map(line => {
                const name = line.split(' ')[1];
                return {
                    name: name,
                    type: 'mac'
                };
            });
        } catch (error) {
            console.error('Failed to get Mac printers:', error);
            return [];
        }
    }

    async getLinuxPrinters() {
        try {
            const { stdout } = await execPromise('lpstat -p');
            const lines = stdout.split('\n').filter(line => line.startsWith('printer'));
            
            return lines.map(line => {
                const name = line.split(' ')[1];
                return {
                    name: name,
                    type: 'linux'
                };
            });
        } catch (error) {
            console.error('Failed to get Linux printers:', error);
            return [];
        }
    }

    /**
     * Portrait thermal-friendly print via SumatraPDF (pdf-to-printer). Returns false if Sumatra not available.
     * @param {'noscale'|'shrink'|'fit'} scale
     */
    async printFileWindowsSumatra(filePath, printerName, scale = 'noscale') {
        const printFn = tryRequirePdfToPrinterPrint();
        const sumatra = resolveSumatraExecutable();
        if (!printFn || !sumatra) {
            return false;
        }
        await printFn(filePath, {
            printer: printerName,
            silent: true,
            orientation: 'portrait',
            scale,
            monochrome: true,
            sumatraPdfPath: sumatra,
        });
        return true;
    }

    async printPdfWindows(tempFile, printerName) {
        try {
            if (await this.printFileWindowsSumatra(tempFile, printerName, 'fit')) {
                return;
            }
        } catch (e) {
            console.warn('Sumatra PDF print (fit) failed:', e.message);
        }
        try {
            if (await this.printFileWindowsSumatra(tempFile, printerName, 'noscale')) {
                return;
            }
        } catch (e) {
            console.warn('Sumatra PDF print (noscale) failed:', e.message);
        }
        const acro = resolveAcroRd32();
        if (acro) {
            try {
                await spawnFileAsync(acro, ['/t', tempFile, printerName]);
                await delay(10_000);
                return;
            } catch (e) {
                console.warn('Adobe /t PDF print failed:', e.message);
            }
        }
        throw new Error(
            'PDF direct print needs SumatraPDF or Adobe Reader. Install one of them, or copy SumatraPDF.exe to ' +
                'vendor/SumatraPDF/ next to the app (see README there). The old method did not use your mapped printer.'
        );
    }

    async printImageWindowsGdi(imagePath, printerName) {
        const scriptPath = path.join(os.tmpdir(), 'restify-print-image-thermal.ps1');
        await fs.promises.writeFile(scriptPath, WINDOWS_THERMAL_PRINT_PS1, 'utf8');
        return new Promise((resolve, reject) => {
            const args = [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptPath,
                '-ImagePath',
                imagePath,
                '-PrinterName',
                printerName,
            ];
            const child = spawn('powershell.exe', args, { windowsHide: true });
            let errText = '';
            if (child.stderr) {
                child.stderr.on('data', (d) => {
                    errText += d.toString();
                });
            }
            child.on('error', reject);
            child.on('close', (code) => {
                setTimeout(() => {
                    try {
                        fs.unlinkSync(scriptPath);
                    } catch (_) {
                        /* ignore */
                    }
                }, 3000);
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(errText.trim() || `PowerShell print exited with code ${code}`));
                }
            });
        });
    }

    async print(printerName, content, printType = 'image', printFormat = 'thermal80mm') {
        try {
            if (printType === 'image') {
                return await this.printImage(printerName, content, printFormat);
            } else if (printType === 'pdf') {
                return await this.printPDF(printerName, content);
            } else {
                return await this.printRaw(printerName, content, printFormat);
            }
        } catch (error) {
            console.error('Print error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async printImage(printerName, imageUrl, printFormat) {
        try {
            // Download image
            const tempDir = os.tmpdir();
            const tempFile = path.join(tempDir, `print_${Date.now()}.png`);
            
            const response = await axios({
                method: 'get',
                url: imageUrl,
                responseType: 'arraybuffer',
                timeout: 60000,
                maxRedirects: 5,
            });
            await fs.promises.writeFile(tempFile, Buffer.from(response.data));

            const platform = os.platform();

            if (platform === 'win32') {
                let done = false;
                // Skip SumatraPDF for images - it's designed for PDFs and can cause
                // landscape orientation issues with tall receipt images.
                // Go directly to GDI thermal printing which handles portrait correctly.
                try {
                    await this.printImageWindowsGdi(tempFile, printerName);
                    done = true;
                } catch (e) {
                    console.warn('GDI thermal print failed, falling back to Photo Viewer / Paint:', e.message);
                }

                if (!done) {
                    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
                    const shimgvw = path.join(systemRoot, 'System32', 'shimgvw.dll');
                    try {
                        if (fs.existsSync(shimgvw)) {
                            await spawnPromise('rundll32.exe', [
                                `${shimgvw},ImageView_PrintTo`,
                                tempFile,
                                printerName,
                            ]);
                        } else {
                            throw new Error('shimgvw.dll not found');
                        }
                    } catch (e2) {
                        console.warn('Photo Viewer print failed, using mspaint:', e2.message);
                        await execPromise(`mspaint /pt "${tempFile}" "${printerName}"`);
                    }
                }
            } else if (platform === 'darwin') {
                await execPromise(`lp -d "${printerName}" "${tempFile}"`);
            } else {
                await execPromise(`lp -d "${printerName}" "${tempFile}"`);
            }

            // Clean up temp file
            setTimeout(() => {
                try {
                    fs.unlinkSync(tempFile);
                } catch (e) {
                    console.error('Failed to delete temp file:', e);
                }
            }, 5000);

            return {
                success: true,
                message: 'Image printed successfully'
            };
        } catch (error) {
            console.error('Image print error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async printPDF(printerName, pdfUrl) {
        try {
            // Download PDF
            const tempDir = os.tmpdir();
            const tempFile = path.join(tempDir, `print_${Date.now()}.pdf`);
            
            const response = await axios({
                method: 'get',
                url: pdfUrl,
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(tempFile);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            // Print using system command
            const platform = os.platform();
            let printCommand;

            if (platform === 'win32') {
                await this.printPdfWindows(tempFile, printerName);
                printCommand = null;
            } else if (platform === 'darwin') {
                // macOS: Use lp command
                printCommand = `lp -d "${printerName}" "${tempFile}"`;
            } else {
                // Linux: Use lp command
                printCommand = `lp -d "${printerName}" "${tempFile}"`;
            }

            if (printCommand) {
                await execPromise(printCommand);
            }

            // Clean up temp file (longer delay on Windows: Adobe /t returns before spooler finishes)
            setTimeout(() => {
                try {
                    fs.unlinkSync(tempFile);
                } catch (e) {
                    console.error('Failed to delete temp file:', e);
                }
            }, platform === 'win32' ? 15_000 : 5000);

            return {
                success: true,
                message: 'PDF printed successfully'
            };
        } catch (error) {
            console.error('PDF print error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async printRaw(printerName, escPosData, printFormat) {
        try {
            // Determine printer width
            let width = 48; // default 80mm
            if (printFormat === 'thermal56mm') {
                width = 32;
            } else if (printFormat === 'thermal112mm') {
                width = 64;
            }

            // Initialize thermal printer
            const printer = new ThermalPrinter({
                type: PrinterTypes.EPSON,
                interface: `printer:${printerName}`,
                characterSet: 'PC437_USA',
                width: width,
                removeSpecialCharacters: false
            });

            // Parse ESC/POS commands from payload
            if (escPosData.text) {
                // Send raw ESC/POS data
                printer.raw(Buffer.from(escPosData.text, 'utf-8'));
            }

            // Cut paper if specified
            if (escPosData.cutPaper) {
                printer.cut();
            }

            // Execute print
            await printer.execute();

            return {
                success: true,
                message: 'Raw data printed successfully'
            };
        } catch (error) {
            console.error('Raw print error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

}

module.exports = PrinterService;
