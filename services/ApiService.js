const axios = require('axios');
const Pusher = require('pusher-js');

/** How often we pull pending jobs when Pusher is unavailable or misses an event */
const PRINT_JOB_POLL_MS = 1000;

/**
 * After a Pusher signal the job is normally ready at once (the server announces it in the
 * same request as the order); a short burst of pulls covers a row that lands a moment later.
 */
const PUSH_PULL_BURST_MS = 250;
const PUSH_PULL_BURST_ATTEMPTS = 12;

/**
 * This many pulls failing in a row means the network or the server went away. When pulls
 * work again we re-test the connection so Pusher is subscribed afresh (its socket may be dead).
 */
const CONNECTION_LOST_AFTER_FAILURES = 5;

/** Outcomes kept in memory for the "Recent prints" list. */
const JOB_LOG_LIMIT = 100;

const PUSHER_EVENT = 'print-job.created';

/** Sent with every request; the server skips the browser screenshot for apps that print HTML. */
const APP_VERSION = (() => {
    try {
        return require('../package.json').version;
    } catch {
        return '0.0.0';
    }
})();

function branchApiHeaders(apiKey, appVersion) {
    return {
        'X-TABLETRACK-KEY': apiKey,
        'X-Restify-App-Version': appVersion,
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
}

/** Paper width in mm for a server print format (`thermal80mm` -> 80). Unknown -> 80. */
function widthFromFormat(format) {
    const match = /(\d+)\s*mm/i.exec(String(format || ''));
    const width = match ? parseInt(match[1], 10) : NaN;
    return Number.isFinite(width) && width > 0 ? width : 80;
}

/**
 * The job handed to `printerService.printJob` for a pulled job and its mapping. HTML jobs come
 * from servers that know this app version; image/PDF jobs from older servers keep working.
 */
function buildPrintJob(job, mapping) {
    const fileName = String(job.image_filename || job.image_path || '');
    const isPdf = /\.pdf(\?.*)?$/i.test(fileName);
    return {
        html: job.html || null,
        // The server names an image file for every job, but only uploads one for jobs
        // without HTML: the URL would be a 404 for an HTML job.
        imageUrl: !isPdf && !job.html ? (job.image_path || null) : null,
        pdfUrl: isPdf ? job.image_path : null,
        widthMm: job.width_mm || widthFromFormat(job.printer?.print_format || mapping.printFormat),
        copies: Math.max(1, parseInt(mapping.copies || job.copies || 1, 10) || 1),
        engine: mapping.engine || 'auto',
        printerName: mapping.localPrinterName,
    };
}

/** Last N job outcomes, newest first. Shared between pulled jobs and test prints. */
class JobLog {
    constructor(limit = JOB_LOG_LIMIT) {
        this.limit = limit;
        this.entries = [];
    }

    add(entry) {
        const record = { at: new Date().toISOString(), ...entry };
        this.entries.unshift(record);
        if (this.entries.length > this.limit) {
            this.entries.length = this.limit;
        }
        return record;
    }

    all() {
        return this.entries.slice();
    }
}

class ApiService {
    /**
     * @param {object} [options]
     * @param {string} [options.appVersion] version sent as X-Restify-App-Version
     * @param {JobLog} [options.jobLog] shared outcome log
     * @param {{info,warn,error}} [options.logger] defaults to console
     */
    constructor(domainUrl, apiKey, options = {}) {
        this.appVersion = options.appVersion || APP_VERSION;
        this.jobLog = options.jobLog || new JobLog();
        this.logger = options.logger || console;
        this.pollingInterval = null;
        this.pusher = null;
        this.channel = null;
        this.pulling = false;
        this.unacknowledged = new Map();
        this.signalHandler = null;
        this.consecutiveFailures = 0;
        this.connectionLost = false;
        this.lastServerInfo = null;

        this.updateConfig(domainUrl, apiKey);
    }

    updateConfig(domainUrl, apiKey) {
        this.domainUrl = String(domainUrl || '').replace(/\/+$/, '');
        this.apiKey = apiKey;

        this.axiosInstance = axios.create({
            baseURL: `${this.domainUrl}/api`,
            headers: branchApiHeaders(apiKey, this.appVersion),
            timeout: 30000,
        });
    }

    isPolling() {
        return this.pollingInterval !== null;
    }

    /** True while a pull (and the prints it carries) is in progress. */
    isBusy() {
        return this.pulling;
    }

    getJobLog() {
        return this.jobLog.all();
    }

    async testConnection() {
        try {
            const response = await this.axiosInstance.get('/test-connection');
            const data = response.data || {};

            if (data.status === 'success') {
                this.lastServerInfo = {
                    serverVersion: data.server_version || null,
                    supportsHtml: Boolean(data.supports_html),
                    pusherEnabled: Boolean(data.pusher_enabled),
                };

                // (Re)subscribe Pusher: the channel name is per branch and comes from the server.
                if (data.pusher_enabled && data.pusher_config) {
                    this.initializePusher(data.pusher_config);
                }

                return {
                    success: true,
                    message: 'Connection successful',
                    pusherEnabled: Boolean(data.pusher_enabled),
                    pusherConnected: Boolean(this.channel),
                    serverVersion: data.server_version || null,
                    supportsHtml: Boolean(data.supports_html),
                };
            }

            return { success: false, message: data.message || 'Connection failed' };
        } catch (error) {
            this.logger.error(`Connection test failed: ${error.message}`);
            const data = error.response?.data;
            const base = data?.message || error.message || 'Connection failed';
            const hint = data?.hint ? ` ${data.hint}` : '';
            return {
                success: false,
                status: error.response?.status || null,
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
                encrypted: true,
            });

            this.channel = this.pusher.subscribe(config.channel);
            this.pusherEvent = config.event || PUSHER_EVENT;

            // A fresh channel has no bindings; keep listening if the service is already running.
            if (this.signalHandler) {
                this.bindChannel();
            }

            this.logger.info(`Pusher subscribed to ${config.channel}`);
        } catch (error) {
            this.logger.error(`Failed to initialize Pusher: ${error.message}`);
        }
    }

    bindChannel() {
        if (!this.channel || !this.signalHandler) {
            return;
        }
        const event = this.pusherEvent || PUSHER_EVENT;
        this.channel.unbind(event);
        this.channel.bind(event, this.signalHandler);
    }

    async getPrinters() {
        try {
            const response = await this.axiosInstance.get('/printer-details');
            return {
                success: true,
                printers: Array.isArray(response.data) ? response.data : (response.data?.printers || []),
            };
        } catch (error) {
            this.logger.error(`Failed to get printers: ${error.message}`);
            return {
                success: false,
                message: error.response?.data?.message || error.message,
            };
        }
    }

    async getPrintJobs() {
        try {
            const response = await this.axiosInstance.get('/print-jobs/pull-multiple');
            return {
                success: true,
                jobs: Array.isArray(response.data) ? response.data : [],
            };
        } catch (error) {
            return {
                success: false,
                jobs: [],
                message: error.response?.data?.message || error.message,
            };
        }
    }

    async updatePrintJob(jobId, status, error = null, printer = null, printedAt = null) {
        const body = {
            status: status,
            printed_at: printedAt || new Date().toISOString(),
            error: error,
            printer: printer,
        };
        try {
            await this.axiosInstance.patch(`/print-jobs/${jobId}`, body);
            return { success: true };
        } catch (err) {
            this.logger.error(`Failed to update print job #${jobId}: ${err.message} (will retry)`);
            // A 4xx means the server refused it for good; anything else is retried later.
            const code = err.response?.status;
            if (!(code >= 400 && code < 500)) {
                this.unacknowledged.set(String(jobId), body);
            }
            return { success: false };
        }
    }

    /** Resend outcomes the server never received (called after a successful pull). */
    async flushUnacknowledged() {
        for (const [jobId, body] of [...this.unacknowledged]) {
            this.unacknowledged.delete(jobId);
            await this.updatePrintJob(jobId, body.status, body.error, body.printer, body.printed_at);
        }
    }

    async pullBurstAfterSignal(printerService, printerMappings, statusCallback) {
        for (let i = 0; i < PUSH_PULL_BURST_ATTEMPTS; i++) {
            const printed = await this.pullAndProcessJobs(printerService, printerMappings, statusCallback);
            if (printed > 0) {
                return;
            }
            await new Promise((r) => setTimeout(r, PUSH_PULL_BURST_MS));
        }
    }

    /** One pull; resolves the number of jobs handled. Pulls never overlap (one printer queue). */
    async pullAndProcessJobs(printerService, printerMappings, statusCallback) {
        if (this.pulling) {
            return 0;
        }
        this.pulling = true;
        try {
            const result = await this.getPrintJobs();
            if (!result.success) {
                this.notePullFailure(result.message, statusCallback);
                return 0;
            }
            await this.notePullSuccess(statusCallback);
            for (const job of result.jobs) {
                await this.processPrintJob(job, printerService, printerMappings, statusCallback);
            }
            return result.jobs.length;
        } catch (error) {
            this.logger.error(`Polling error: ${error.message}`);
            statusCallback({
                type: 'error',
                message: 'Polling error: ' + error.message,
            });
            return 0;
        } finally {
            this.pulling = false;
        }
    }

    notePullFailure(message, statusCallback) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures === CONNECTION_LOST_AFTER_FAILURES && !this.connectionLost) {
            this.connectionLost = true;
            this.logger.warn(`Connection lost: ${message}`);
            statusCallback({
                type: 'connection',
                ok: false,
                message: `Connection lost: ${message}`,
            });
        }
    }

    async notePullSuccess(statusCallback) {
        this.consecutiveFailures = 0;
        if (this.unacknowledged.size > 0) {
            await this.flushUnacknowledged();
        }
        if (!this.connectionLost) {
            return;
        }
        this.connectionLost = false;
        // Pusher's socket may not have survived the outage: subscribe again.
        const result = await this.testConnection();
        this.logger.info(`Connection restored (pusher ${result.pusherConnected ? 'on' : 'off'})`);
        statusCallback({
            type: 'connection',
            ok: true,
            message: 'Connection restored',
            pusherConnected: Boolean(result.pusherConnected),
            serverVersion: result.serverVersion || null,
        });
    }

    startPolling(printerService, printerMappings, statusCallback) {
        // Clear existing interval
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }

        this.consecutiveFailures = 0;
        this.connectionLost = false;

        // Pusher payload is not guaranteed to match pull-multiple shape. Pull from the API
        // (with a short burst) so we get full rows.
        this.signalHandler = (data) => {
            this.logger.info(`Print job signal via Pusher: ${JSON.stringify(data ?? null)}`);
            void this.pullBurstAfterSignal(printerService, printerMappings, statusCallback);
        };
        this.bindChannel();

        // Start the print engines now so the first ticket does not pay their start-up time.
        if (typeof printerService.warmUp === 'function') {
            void printerService.warmUp();
        }

        // Don't wait a full interval after starting: pull once immediately
        void this.pullAndProcessJobs(printerService, printerMappings, statusCallback);

        // Polling fallback while Pusher is down or events are delayed
        this.pollingInterval = setInterval(() => {
            void this.pullAndProcessJobs(printerService, printerMappings, statusCallback);
        }, PRINT_JOB_POLL_MS);

        statusCallback({
            type: 'success',
            message: 'Printing service started',
        });
    }

    async processPrintJob(job, printerService, printerMappings, statusCallback) {
        const jobId = job.id ?? job.print_job_id;
        const startedAt = Date.now();
        let mapping = null;
        try {
            if (jobId == null) {
                this.logger.error(`Print job missing id: ${JSON.stringify(job)}`);
                return;
            }

            mapping = printerMappings.find((m) => m.remotePrinterId === job.printer_id);

            if (!mapping) {
                const message = 'No printer mapping found';
                this.logger.warn(`Job #${jobId}: no mapping for printer ${job.printer_id}`);
                await this.updatePrintJob(jobId, 'failed', message);
                this.recordJob(statusCallback, {
                    id: jobId,
                    printer: job.printer?.name || `printer ${job.printer_id}`,
                    engine: null,
                    ms: Date.now() - startedAt,
                    status: 'failed',
                    error: message,
                });
                return;
            }

            statusCallback({
                type: 'info',
                message: `Printing job #${jobId} to ${mapping.localPrinterName}...`,
            });

            const printResult = await printerService.printJob(buildPrintJob(job, mapping));
            const ms = Date.now() - startedAt;

            if (printResult.success) {
                await this.updatePrintJob(jobId, 'done', null, mapping.localPrinterName);
                this.recordJob(statusCallback, {
                    id: jobId,
                    printer: mapping.localPrinterName,
                    engine: printResult.engine || null,
                    fallback: printResult.fallback || null,
                    reason: printResult.reason || null,
                    ms,
                    status: 'done',
                    error: null,
                });
            } else {
                await this.updatePrintJob(jobId, 'failed', printResult.error, mapping.localPrinterName);
                this.recordJob(statusCallback, {
                    id: jobId,
                    printer: mapping.localPrinterName,
                    engine: printResult.engine || null,
                    ms,
                    status: 'failed',
                    error: printResult.error || 'Print failed',
                });
            }
        } catch (error) {
            this.logger.error(`Error processing print job #${jobId}: ${error.message}`);
            if (jobId != null) {
                await this.updatePrintJob(jobId, 'failed', error.message, mapping?.localPrinterName || null);
            }
            this.recordJob(statusCallback, {
                id: jobId,
                printer: mapping?.localPrinterName || null,
                engine: null,
                ms: Date.now() - startedAt,
                status: 'failed',
                error: error.message,
            });
        }
    }

    /** Keep the outcome and tell the window; one place so every job ends up in the log. */
    recordJob(statusCallback, entry) {
        const record = this.jobLog.add(entry);
        const label = record.id === 'test' ? 'Test print' : `Job #${record.id}`;
        const message = record.status === 'done'
            ? `${label} printed on ${record.printer} (${record.engine || 'n/a'}, ${record.ms} ms)`
            : `${label} failed: ${record.error}`;
        this.logger[record.status === 'done' ? 'info' : 'error'](message);
        statusCallback({
            type: 'job',
            job: record,
            message,
        });
        return record;
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        this.signalHandler = null;

        if (this.channel) {
            this.channel.unbind_all();
            this.channel = null;
        }

        if (this.pusher) {
            this.pusher.disconnect();
            this.pusher = null;
        }
    }
}

module.exports = ApiService;
module.exports.JobLog = JobLog;
module.exports.buildPrintJob = buildPrintJob;
module.exports.widthFromFormat = widthFromFormat;
module.exports.APP_VERSION = APP_VERSION;
module.exports.CONNECTION_LOST_AFTER_FAILURES = CONNECTION_LOST_AFTER_FAILURES;
