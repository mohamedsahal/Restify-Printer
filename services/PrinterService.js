const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);

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
                // Prefer Windows Photo Viewer shell (lighter than launching full Paint).
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
                } catch (e) {
                    console.warn('Fast image print failed, using mspaint:', e.message);
                    await execPromise(`mspaint /pt "${tempFile}" "${printerName}"`);
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
                // Windows: Use Adobe Reader or default PDF viewer
                printCommand = `powershell -Command "Start-Process -FilePath '${tempFile}' -Verb Print -WindowStyle Hidden"`;
            } else if (platform === 'darwin') {
                // macOS: Use lp command
                printCommand = `lp -d "${printerName}" "${tempFile}"`;
            } else {
                // Linux: Use lp command
                printCommand = `lp -d "${printerName}" "${tempFile}"`;
            }

            await execPromise(printCommand);

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
