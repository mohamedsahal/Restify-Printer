const axios = require('axios');
const Pusher = require('pusher-js');

/** How often we pull pending jobs when Pusher is unavailable or misses an event */
const PRINT_JOB_POLL_MS = 1500;

/** After a Pusher signal, image file may land a moment later — short burst of pulls */
const PUSH_PULL_BURST_MS = 350;
const PUSH_PULL_BURST_ATTEMPTS = 15;

function branchApiHeaders(apiKey) {
    return {
        'X-TABLETRACK-KEY': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
}

class ApiService {
    constructor(domainUrl, apiKey) {
        this.domainUrl = domainUrl;
        this.apiKey = apiKey;
        this.pollingInterval = null;
        this.pusher = null;
        this.channel = null;
        
        this.axiosInstance = axios.create({
            baseURL: `${domainUrl}/api`,
            headers: branchApiHeaders(apiKey),
            timeout: 30000,
        });
    }

    updateConfig(domainUrl, apiKey) {
        this.domainUrl = domainUrl;
        this.apiKey = apiKey;

        this.axiosInstance = axios.create({
            baseURL: `${domainUrl}/api`,
            headers: branchApiHeaders(apiKey),
            timeout: 30000,
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
            const data = error.response?.data;
            const base = data?.message || error.message || 'Connection failed';
            const hint = data?.hint ? ` ${data.hint}` : '';
            return {
                success: false,
                message: `${base}${hint}`.trim(),
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

    async pullBurstAfterSignal(printerService, printerMappings, statusCallback) {
        for (let i = 0; i < PUSH_PULL_BURST_ATTEMPTS; i++) {
            await this.pullAndProcessJobs(printerService, printerMappings, statusCallback);
            await new Promise((r) => setTimeout(r, PUSH_PULL_BURST_MS));
        }
    }

    async pullAndProcessJobs(printerService, printerMappings, statusCallback) {
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
    }

    startPolling(printerService, printerMappings, statusCallback) {
        // Clear existing interval
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }

        // Pusher payload is not guaranteed to match pull-multiple shape; the image file
        // may not exist yet. Pull from API (with a short burst) so we get full rows + file-ready jobs.
        if (this.channel) {
            this.channel.bind('print-job.created', (data) => {
                console.log('New print job signal via Pusher:', data);
                void this.pullBurstAfterSignal(printerService, printerMappings, statusCallback);
            });
        }

        // Don't wait a full interval after starting — pull once immediately
        void this.pullAndProcessJobs(printerService, printerMappings, statusCallback);

        // Polling fallback while Pusher is down or events are delayed
        this.pollingInterval = setInterval(() => {
            void this.pullAndProcessJobs(printerService, printerMappings, statusCallback);
        }, PRINT_JOB_POLL_MS);

        statusCallback({
            type: 'success',
            message: 'Printing service started'
        });
    }

    async processPrintJob(job, printerService, printerMappings, statusCallback) {
        const jobId = job.id ?? job.print_job_id;
        try {
            if (jobId == null) {
                console.error('Print job missing id:', job);
                return;
            }

            // Find printer mapping
            const mapping = printerMappings.find(m => m.remotePrinterId === job.printer_id);
            
            if (!mapping) {
                console.log('No mapping found for printer:', job.printer_id);
                await this.updatePrintJob(jobId, 'failed', 'No printer mapping found');
                return;
            }

            statusCallback({
                type: 'info',
                message: `Printing job #${jobId} to ${mapping.localPrinterName}...`
            });

            // Print the job
            const printResult = await printerService.print(
                mapping.localPrinterName,
                job.image_path || job.payload,
                mapping.printType || 'image',
                mapping.printFormat || 'thermal80mm'
            );

            if (printResult.success) {
                await this.updatePrintJob(jobId, 'done', null, mapping.localPrinterName);
                statusCallback({
                    type: 'success',
                    message: `✓ Job #${jobId} printed successfully`
                });
            } else {
                await this.updatePrintJob(jobId, 'failed', printResult.error);
                statusCallback({
                    type: 'error',
                    message: `✗ Job #${jobId} failed: ${printResult.error}`
                });
            }
        } catch (error) {
            console.error('Error processing print job:', error);
            if (jobId != null) {
                await this.updatePrintJob(jobId, 'failed', error.message);
            }
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
