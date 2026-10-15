const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const util = require('util');
const chromiumPrinter = require('./ChromiumPrinter');

const execPromise = util.promisify(exec);

/** Paper width of the old printFormat names, for callers that still send them. */
const PRINT_FORMAT_WIDTH_MM = {
    thermal56mm: 56,
    thermal80mm: 80,
    thermal112mm: 112,
};

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

/**
 * Written to %TEMP% at runtime (printing works inside the packaged ASAR). A long-lived
 * worker: PowerShell and System.Drawing start once, then every ticket is one JSON line on
 * stdin ({"id","imagePath","printerName"}) answered by "OK <id>" or "ERR <id> <message>".
 * Starting a PowerShell process per ticket used to cost one to three seconds each.
 */
const WINDOWS_PRINT_WORKER_PS1 = String.raw`#requires -Version 5.0
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Print-ReceiptImage([string]$ImagePath, [string]$PrinterName) {
    if (-not (Test-Path -LiteralPath $ImagePath)) {
        throw "Image not found: $ImagePath"
    }
    $script:img = $null
    $script:pd = $null
    try {
        $script:img = [System.Drawing.Image]::FromFile($ImagePath)
        $script:pd = New-Object System.Drawing.Printing.PrintDocument
        $script:pd.PrinterSettings.PrinterName = $PrinterName
        if (-not $script:pd.PrinterSettings.IsValid) {
            throw "Printer not found or invalid: $PrinterName"
        }
        $script:pd.PrintController = New-Object System.Drawing.Printing.StandardPrintController
        $script:pd.PrinterSettings.DefaultPageSettings.Landscape = $false
        $script:pd.DefaultPageSettings.Landscape = $false
        $script:pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
        try { $script:pd.DefaultPageSettings.Color = $false } catch { }

        # For thermal printers, try to use a large paper size to avoid pagination.
        # Receipts are continuous roll paper - we want one long virtual page.
        $paperSizes = $script:pd.PrinterSettings.PaperSizes
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
                $script:pd.DefaultPageSettings.PaperSize = $customSize
            }
        }

        $script:srcY = 0
        $script:scale = 0.0
        $script:chunkSrcH = 0

        $script:pd.add_PrintPage({
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
                $script:scale = [double]$rollPx / [double]$script:img.Width
                if ($script:scale -le 0) { $script:scale = 1.0 }
                $script:chunkSrcH = [int][Math]::Floor($feedPx / $script:scale)
                if ($script:chunkSrcH -lt 1) { $script:chunkSrcH = 1 }
            }
            $remaining = $script:img.Height - $script:srcY
            if ($remaining -le 0) {
                $e.HasMorePages = $false
                return
            }
            $take = [Math]::Min($script:chunkSrcH, $remaining)
            $destH = [int][Math]::Max(1, [Math]::Round($take * $script:scale))
            $srcRect = New-Object System.Drawing.Rectangle(0, $script:srcY, $script:img.Width, $take)
            $destRect = New-Object System.Drawing.Rectangle(0, 0, $rollPx, $destH)
            $g.DrawImage($script:img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
            $script:srcY += $take
            $e.HasMorePages = ($script:srcY -lt $script:img.Height)
        })
        $script:pd.Print()
    } finally {
        if ($null -ne $script:img) { $script:img.Dispose() }
        if ($null -ne $script:pd) { $script:pd.Dispose() }
    }
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    $id = ''
    try {
        $req = $line | ConvertFrom-Json
        $id = [string]$req.id
        Print-ReceiptImage ([string]$req.imagePath) ([string]$req.printerName)
        [Console]::Out.WriteLine("OK $id")
    } catch {
        $msg = ([string]$_.Exception.Message) -replace "[\r\n]+", " "
        [Console]::Out.WriteLine("ERR $id $msg")
    }
    [Console]::Out.Flush()
}
`;

/** The PowerShell to run (RESTIFY_POWERSHELL overrides it, e.g. pwsh.exe or a test stub). */
const POWERSHELL = process.env.RESTIFY_POWERSHELL || 'powershell.exe';

/** A PowerShell single-quoted string literal. */
function psLiteral(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

/** How long one ticket may take in the worker (spooling to a stopped printer can hang). */
const WORKER_PRINT_TIMEOUT_MS = 60_000;
const WORKER_START_TIMEOUT_MS = 30_000;

/**
 * Keeps one PowerShell process alive and sends it print requests one after another.
 * If the process dies, the next request starts a fresh one.
 */
class WindowsPrintWorker {
    constructor() {
        this.child = null;
        this.starting = null;
        this.pending = new Map();
        this.seq = 0;
        this.buffer = '';
    }

    start() {
        if (this.child) {
            return Promise.resolve();
        }
        if (this.starting) {
            return this.starting;
        }
        this.starting = (async () => {
            const scriptPath = path.join(os.tmpdir(), 'restify-print-worker.ps1');
            await fs.promises.writeFile(scriptPath, WINDOWS_PRINT_WORKER_PS1, 'utf8');
            const child = spawn(
                POWERSHELL,
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
                { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
            );
            let stderr = '';
            child.stderr.on('data', (d) => {
                stderr += d.toString();
                if (stderr.length > 4000) stderr = stderr.slice(-4000);
            });
            child.stdout.on('data', (d) => this.onData(d.toString()));
            child.on('error', (e) => this.onExit(e.message));
            child.on('close', (code) => this.onExit(`print worker exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`));

            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('print worker did not start in time')), WORKER_START_TIMEOUT_MS);
                this.pending.set('READY', {
                    resolve: () => { clearTimeout(timer); resolve(); },
                    reject: (e) => { clearTimeout(timer); reject(e); },
                });
            });
            this.child = child;
        })();
        return this.starting.finally(() => { this.starting = null; });
    }

    onData(text) {
        this.buffer += text;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, nl).trim();
            this.buffer = this.buffer.slice(nl + 1);
            if (!line) continue;
            if (line === 'READY') {
                this.pending.get('READY')?.resolve();
                this.pending.delete('READY');
                continue;
            }
            const m = /^(OK|ERR) (\S+)(?: (.*))?$/.exec(line);
            if (!m) {
                console.log('[print worker]', line);
                continue;
            }
            const waiter = this.pending.get(m[2]);
            this.pending.delete(m[2]);
            if (!waiter) continue;
            if (m[1] === 'OK') {
                waiter.resolve();
            } else {
                const err = new Error(m[3] || 'print failed');
                err.fromPrinter = true;
                waiter.reject(err);
            }
        }
    }

    onExit(reason) {
        this.child = null;
        const waiters = [...this.pending.values()];
        this.pending.clear();
        for (const w of waiters) w.reject(new Error(reason));
    }

    async print(imagePath, printerName) {
        await this.start();
        const id = String(++this.seq);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('print worker timed out, restarting it'));
                this.stop();
            }, WORKER_PRINT_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: () => { clearTimeout(timer); resolve(); },
                reject: (e) => { clearTimeout(timer); reject(e); },
            });
            this.child.stdin.write(JSON.stringify({ id, imagePath, printerName }) + '\n', (err) => {
                if (err) {
                    this.pending.delete(id);
                    clearTimeout(timer);
                    reject(err);
                }
            });
        });
    }

    stop() {
        const child = this.child;
        this.child = null;
        if (child) {
            try { child.stdin.end(); } catch (_) { /* ignore */ }
            try { child.kill(); } catch (_) { /* ignore */ }
        }
    }
}

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
        this.worker = os.platform() === 'win32' || process.env.RESTIFY_POWERSHELL ? new WindowsPrintWorker() : null;
        this.chromium = chromiumPrinter;
    }

    /** Start the Chromium window and the print worker before the first ticket arrives. */
    async warmUp() {
        const tasks = [];
        if (this.chromium.available) {
            tasks.push(
                this.chromium.warmUp().then((ok) => {
                    if (ok) console.log('Chromium print window ready');
                })
            );
        }
        if (this.worker) {
            tasks.push(
                this.worker.start().then(
                    () => console.log('Print worker ready'),
                    (e) => console.warn('Print worker could not start (tickets will use one-shot printing):', e.message)
                )
            );
        }
        await Promise.all(tasks);
    }

    shutdown() {
        this.worker?.stop();
        this.chromium.shutdown();
    }

    /**
     * Chromium's list first (Windows 11 no longer ships wmic); the platform commands when it is
     * not available or empty. `name` is exactly what the print engines expect as the device name.
     * @returns {Promise<Array<{ name: string, type: string, isDefault: boolean }>>}
     */
    async getSystemPrinters() {
        const platform = os.platform();
        const type = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : 'linux';
        let printers = [];

        if (this.chromium.available) {
            try {
                printers = (await this.chromium.getPrinters())
                    .filter((p) => p.name)
                    .map((p) => ({ name: p.name, type, isDefault: !!p.isDefault, displayName: p.displayName }));
            } catch (error) {
                console.warn('Chromium printer list failed, using system commands:', error.message);
                printers = [];
            }
        }

        if (printers.length === 0) {
            try {
                if (platform === 'win32') {
                    printers = await this.getWindowsPrinters();
                } else if (platform === 'darwin') {
                    printers = await this.getMacPrinters();
                } else if (platform === 'linux') {
                    printers = await this.getLinuxPrinters();
                }
            } catch (error) {
                console.error('Failed to get system printers:', error);
                printers = [];
            }
            printers = printers.map((p) => ({ isDefault: false, ...p }));
        }

        this.printers = printers;
        return printers;
    }

    /** wmic where it still exists, PowerShell's CIM query where it does not (Windows 11 24H2+). */
    async getWindowsPrinters() {
        try {
            const { stdout } = await execPromise('wmic printer get name');
            const lines = stdout.split('\n').filter(line => line.trim() && line.trim() !== 'Name');
            const printers = lines.map(name => ({
                name: name.trim(),
                type: 'windows'
            }));
            if (printers.length > 0) return printers;
        } catch (error) {
            console.warn('wmic printer list failed, trying PowerShell:', error.message);
        }
        try {
            const { stdout } = await execPromise(
                `${POWERSHELL} -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name"`,
                { windowsHide: true }
            );
            return stdout
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((name) => ({ name, type: 'windows' }));
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
        if (this.worker) {
            try {
                await this.worker.print(imagePath, printerName);
                return;
            } catch (e) {
                if (e.fromPrinter) {
                    throw e;
                }
                console.warn('Print worker unavailable, printing with a one-shot PowerShell:', e.message);
            }
        }
        return this.printImageWindowsGdiOnce(imagePath, printerName);
    }

    /** One PowerShell process for one ticket: the worker script run once (fallback). */
    async printImageWindowsGdiOnce(imagePath, printerName) {
        const scriptPath = path.join(os.tmpdir(), 'restify-print-image-once.ps1');
        const once = WINDOWS_PRINT_WORKER_PS1
            .replace("[Console]::Out.WriteLine('READY')", '')
            .replace(/while \(\$true\) \{[\s\S]*$/, '')
            + `Print-ReceiptImage ${psLiteral(imagePath)} ${psLiteral(printerName)}\n`;
        await fs.promises.writeFile(scriptPath, once, 'utf8');
        return new Promise((resolve, reject) => {
            const args = [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                scriptPath,
            ];
            const child = spawn(POWERSHELL, args, { windowsHide: true });
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

    /**
     * One print job, whatever the server sent. Chromium prints the ticket HTML (identical to the
     * pop-up print); the image and PDF engines serve jobs without HTML, mappings that force the
     * image engine, and Chromium failures when an image exists.
     *
     * @param {{ html?: string, imageUrl?: string, pdfUrl?: string, printerName: string,
     *           widthMm?: number, copies?: number, engine?: 'chromium'|'image'|'pdf'|'auto' }} job
     * @returns {Promise<{ success: boolean, error?: string, engine: 'chromium'|'image'|'pdf',
     *                     fallback?: boolean, reason?: string, heightMm?: number, durationMs?: number }>}
     */
    async printJob(job) {
        const printerName = String((job && job.printerName) || '');
        const widthMm = Number(job && job.widthMm) > 0 ? Number(job.widthMm) : 80;
        const copies = Math.max(1, parseInt(job && job.copies, 10) || 1);
        const html = job && typeof job.html === 'string' && job.html.trim() ? job.html : null;
        const imageUrl = (job && job.imageUrl) || null;
        const pdfUrl = (job && job.pdfUrl) || null;
        const forced = job && job.engine && job.engine !== 'auto' ? job.engine : null;

        if (!printerName) {
            return { success: false, error: 'No local printer name', engine: forced || (html ? 'chromium' : 'image') };
        }

        const useChromium = forced === 'chromium' || (!forced && html);
        if (useChromium) {
            if (!html) {
                return { success: false, error: 'Chromium engine needs the ticket HTML', engine: 'chromium' };
            }
            const result = await this.chromium.printHtml({ html, printerName, widthMm, copies });
            if (result.success) {
                return { ...result, engine: 'chromium' };
            }
            const reason = result.error || 'Chromium print failed';
            if (imageUrl || pdfUrl) {
                console.warn(`Chromium print failed (${reason}), falling back to the ${imageUrl ? 'image' : 'PDF'} engine`);
                const fallback = imageUrl
                    ? await this.printImageCopies(printerName, imageUrl, copies)
                    : await this.printPdfCopies(printerName, pdfUrl, copies);
                return { ...fallback, engine: imageUrl ? 'image' : 'pdf', fallback: true, reason };
            }
            return { success: false, error: reason, engine: 'chromium' };
        }

        if (forced === 'pdf' || (!imageUrl && pdfUrl)) {
            if (!pdfUrl) return { success: false, error: 'No PDF to print', engine: 'pdf' };
            return { ...(await this.printPdfCopies(printerName, pdfUrl, copies)), engine: 'pdf' };
        }
        if (!imageUrl) {
            return { success: false, error: 'Nothing to print: the job has no HTML, image or PDF', engine: 'image' };
        }
        return { ...(await this.printImageCopies(printerName, imageUrl, copies)), engine: 'image' };
    }

    /** The image engine prints one copy per call. */
    async printImageCopies(printerName, imageUrl, copies) {
        let result = { success: false, error: 'No copies requested' };
        for (let i = 0; i < copies; i++) {
            result = await this.printImage(printerName, imageUrl);
            if (!result.success) break;
        }
        return result;
    }

    async printPdfCopies(printerName, pdfUrl, copies) {
        let result = { success: false, error: 'No copies requested' };
        for (let i = 0; i < copies; i++) {
            result = await this.printPDF(printerName, pdfUrl);
            if (!result.success) break;
        }
        return result;
    }

    /** The old entry point, kept for callers from before printJob(): same engines, same results. */
    async print(printerName, content, printType = 'image', printFormat = 'thermal80mm') {
        try {
            const widthMm = PRINT_FORMAT_WIDTH_MM[printFormat] || 80;
            if (printType === 'image') {
                return await this.printJob({ imageUrl: content, printerName, widthMm, engine: 'image' });
            } else if (printType === 'pdf') {
                return await this.printJob({ pdfUrl: content, printerName, widthMm, engine: 'pdf' });
            } else if (printType === 'html' || printType === 'chromium') {
                return await this.printJob({ html: content, printerName, widthMm, engine: 'chromium' });
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
            } else if (this.worker) {
                // RESTIFY_POWERSHELL on another platform: the worker protocol (pwsh, or a test stub) prints.
                await this.worker.print(tempFile, printerName);
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

module.exports.WindowsPrintWorker = WindowsPrintWorker;
