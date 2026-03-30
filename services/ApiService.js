const axios = require('axios');
const Pusher = require('pusher-js');

class ApiService {
    constructor(domainUrl, apiKey) {
        this.domainUrl = domainUrl;
        this.apiKey = apiKey;
        this.pollingInterval = null;
        this.pusher = null;
        this.channel = null;
        
        this.axiosInstance = axios.create({
            baseURL: `${domainUrl}/api`,
            headers: {
                'X-RestiFy-KEY': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
    }

    updateConfig(domainUrl, apiKey) {
        this.domainUrl = domainUrl;
        this.apiKey = apiKey;
        
        this.axiosInstance = axios.create({
            baseURL: `${domainUrl}/api`,
            headers: {
                'X-RestiFy-KEY': apiKey,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            timeout: 30000
        });
    }

    async testConnection() {
        try {
            const response = await this.axiosInstance.get('/test-connection');
            
            if (response.data.status === 'success') {
                // Initialize Pusher if enabled
                if (response.data.pusher_enabled && response.data.pusher_config) {
                    this.initializePusher(response.data.pusher_config);
                }
                
                return {
                    success: true,
                    message: 'Connection successful',
                    pusherEnabled: response.data.pusher_enabled
                };
            }
            
            return { success: false, message: 'Connection failed' };
        } catch (error) {
            console.error('Connection test failed:', error);
            return {
                success: false,
                message: error.response?.data?.message || error.message || 'Connection failed'
            };
        }
    }

    initializePusher(config) {
        try {
            if (this.pusher) {
                this.pusher.disconnect();
            }

            this.pusher = new Pusher(config.key, {
                cluster: config.cluster,
                encrypted: true
            });

            this.channel = this.pusher.subscribe(config.channel);
            
            console.log('Pusher initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Pusher:', error);
        }
    }

    async getPrinters() {
        try {
            const response = await this.axiosInstance.get('/printer-details');
            return {
                success: true,
                printers: response.data
            };
        } catch (error) {
            console.error('Failed to get printers:', error);
            return {
                success: false,
                message: error.response?.data?.message || error.message
            };
        }
    }

    async getPrintJobs() {
        try {
            const response = await this.axiosInstance.get('/print-jobs/pull-multiple');
            return {
                success: true,
                jobs: response.data || []
            };
        } catch (error) {
            console.error('Failed to get print jobs:', error);
            return {
                success: false,
                jobs: []
            };
        }
    }

    async updatePrintJob(jobId, status, error = null, printer = null) {
        try {
            await this.axiosInstance.patch(`/print-jobs/${jobId}`, {
                status: status,
                printed_at: new Date().toISOString(),
                error: error,
                printer: printer
            });
            return { success: true };
        } catch (error) {
            console.error('Failed to update print job:', error);
            return { success: false };
        }
    }

    startPolling(printerService, printerMappings, statusCallback) {
        // Clear existing interval
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }

        // Setup Pusher real-time listener if available
        if (this.channel) {
            this.channel.bind('print-job.created', async (data) => {
                console.log('New print job received via Pusher:', data);
                await this.processPrintJob(data, printerService, printerMappings, statusCallback);
            });
        }

        // Polling fallback (every 5 seconds)
        this.pollingInterval = setInterval(async () => {
            try {
                const result = await this.getPrintJobs();
                
                if (result.success && result.jobs.length > 0) {
                    for (const job of result.jobs) {
                        await this.processPrintJob(job, printerService, printerMappings, statusCallback);
                    }
                }
            } catch (error) {
                console.error('Polling error:', error);
                statusCallback({
                    type: 'error',
                    message: 'Polling error: ' + error.message
                });
            }
        }, 5000);

        statusCallback({
            type: 'success',
            message: 'Printing service started'
        });
    }

    async processPrintJob(job, printerService, printerMappings, statusCallback) {
        try {
            // Find printer mapping
            const mapping = printerMappings.find(m => m.remotePrinterId === job.printer_id);
            
            if (!mapping) {
                console.log('No mapping found for printer:', job.printer_id);
                await this.updatePrintJob(job.id, 'failed', 'No printer mapping found');
                return;
            }

            statusCallback({
                type: 'info',
                message: `Printing job #${job.id} to ${mapping.localPrinterName}...`
            });

            // Print the job
            const printResult = await printerService.print(
                mapping.localPrinterName,
                job.image_path || job.payload,
                mapping.printType || 'image',
                mapping.printFormat || 'thermal80mm'
            );

            if (printResult.success) {
                await this.updatePrintJob(job.id, 'done', null, mapping.localPrinterName);
                statusCallback({
                    type: 'success',
                    message: `✓ Job #${job.id} printed successfully`
                });
            } else {
                await this.updatePrintJob(job.id, 'failed', printResult.error);
                statusCallback({
                    type: 'error',
                    message: `✗ Job #${job.id} failed: ${printResult.error}`
                });
            }
        } catch (error) {
            console.error('Error processing print job:', error);
            await this.updatePrintJob(job.id, 'failed', error.message);
            statusCallback({
                type: 'error',
                message: `Error: ${error.message}`
            });
        }
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        if (this.channel) {
            this.channel.unbind_all();
        }

        if (this.pusher) {
            this.pusher.disconnect();
        }
    }
}

module.exports = ApiService;
