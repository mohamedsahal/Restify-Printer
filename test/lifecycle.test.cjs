/**
 * API client, job log and log file tests, no Electron or network needed:
 *   NODE_PATH=test/stubs/node_modules node test/lifecycle.test.cjs
 * `axios` and `pusher-js` resolve to test/stubs; the printer service is a stub object here.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

const axios = require('axios');
const Pusher = require('pusher-js');
if (typeof axios.__createConfigs === 'undefined' || !Pusher.__instances) {
    console.error('Run with NODE_PATH=test/stubs/node_modules (stub axios/pusher-js not found)');
    process.exit(1);
}

const ApiService = require('../services/ApiService');
const { JobLog, buildPrintJob, widthFromFormat, CONNECTION_LOST_AFTER_FAILURES } = ApiService;
const Logger = require('../services/Logger');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const MAPPINGS = [
    { remotePrinterId: 7, remotePrinterName: 'Kitchen', localPrinterName: 'Kitchen POS-80', printFormat: 'thermal80mm', copies: 2, engine: 'auto' },
    { remotePrinterId: 8, remotePrinterName: 'Bar', localPrinterName: 'Bar XP-58', printFormat: 'thermal56mm', engine: 'image' },
];

/** Fake PrinterService honouring the D1 contract. */
function fakePrinterService({ fail = false } = {}) {
    const calls = [];
    return {
        calls,
        warmedUp: 0,
        async warmUp() { this.warmedUp += 1; },
        async getSystemPrinters() { return [{ name: 'Kitchen POS-80', isDefault: true }]; },
        async printJob(job) {
            calls.push(job);
            if (fail) return { success: false, error: 'Printer offline', engine: 'chromium' };
            return { success: true, engine: job.html ? 'chromium' : 'image' };
        },
        shutdown() {},
    };
}

/** Routes the stub axios: GET /test-connection, GET /print-jobs/pull-multiple, PATCH /print-jobs/:id. */
function server({ jobs = [], pullFails = false, pusher = true } = {}) {
    const state = { jobs: [...jobs], patches: [], pulls: 0, tests: 0, pullFails };
    axios.__handler = async ({ method, url, data }) => {
        if (method === 'get' && url === '/test-connection') {
            state.tests += 1;
            return { data: {
                status: 'success', pusher_enabled: pusher, supports_html: true, server_version: '2.5.0',
                pusher_config: pusher ? { key: 'k', cluster: 'eu', channel: 'print-jobs.branch-3', event: 'print-job.created' } : null,
            } };
        }
        if (method === 'get' && url === '/print-jobs/pull-multiple') {
            state.pulls += 1;
            if (state.pullFails) throw new Error('ECONNREFUSED');
            const out = state.jobs.splice(0);
            return { data: out };
        }
        if (method === 'patch' && url.startsWith('/print-jobs/')) {
            state.patches.push({ id: url.split('/').pop(), ...data });
            return { data: { ok: true } };
        }
        if (method === 'get' && url === '/printer-details') {
            return { data: [{ id: 7, name: 'Kitchen', print_format: 'thermal80mm' }] };
        }
        throw new Error(`unexpected ${method} ${url}`);
    };
    return state;
}

function statusCollector() {
    const events = [];
    const cb = (s) => events.push(s);
    cb.events = events;
    cb.ofType = (type) => events.filter((e) => e.type === type);
    return cb;
}

beforeEach(() => {
    axios.__handler = null;
    axios.__requests.length = 0;
    axios.__createConfigs.length = 0;
    Pusher.__instances.length = 0;
});

test('widthFromFormat reads the paper width out of the server format', () => {
    assert.equal(widthFromFormat('thermal56mm'), 56);
    assert.equal(widthFromFormat('thermal80mm'), 80);
    assert.equal(widthFromFormat('thermal112mm'), 112);
    assert.equal(widthFromFormat(null), 80);
    assert.equal(widthFromFormat('weird'), 80);
});

test('buildPrintJob: HTML job uses the server width, mapping copies and engine', () => {
    const job = { id: 1, printer_id: 7, html: '<p>t</p>', width_mm: 80, copies: 1, image_path: null, image_filename: null, printer: { print_format: 'thermal80mm' } };
    assert.deepEqual(buildPrintJob(job, MAPPINGS[0]), {
        html: '<p>t</p>', imageUrl: null, pdfUrl: null, widthMm: 80, copies: 2, engine: 'auto', printerName: 'Kitchen POS-80',
    });
});

test('buildPrintJob: legacy image job falls back to the format width and job copies', () => {
    const job = { id: 2, printer_id: 8, html: null, width_mm: null, copies: 3, image_path: 'https://x/receipt.png', image_filename: 'receipt.png', printer: { print_format: 'thermal56mm' } };
    const built = buildPrintJob(job, MAPPINGS[1]);
    assert.equal(built.html, null);
    assert.equal(built.imageUrl, 'https://x/receipt.png');
    assert.equal(built.pdfUrl, null);
    assert.equal(built.widthMm, 56);
    assert.equal(built.copies, 3);
    assert.equal(built.engine, 'image');
});

test('buildPrintJob: a .pdf file goes through pdfUrl, width from the mapping when the job has none', () => {
    const job = { id: 3, printer_id: 7, image_path: 'https://x/r.pdf', image_filename: 'r.pdf', printer: null };
    const built = buildPrintJob(job, { localPrinterName: 'P', printFormat: 'thermal112mm' });
    assert.equal(built.pdfUrl, 'https://x/r.pdf');
    assert.equal(built.imageUrl, null);
    assert.equal(built.widthMm, 112);
    assert.equal(built.copies, 1);
    assert.equal(built.engine, 'auto');
});

test('every request carries the branch key and the app version', () => {
    const api = new ApiService('https://demo.restify.test/', 'KEY-1', { appVersion: '1.1.0', logger: quiet });
    const config = axios.__createConfigs.at(-1);
    assert.equal(config.baseURL, 'https://demo.restify.test/api');
    assert.equal(config.headers['X-TABLETRACK-KEY'], 'KEY-1');
    assert.equal(config.headers['X-Restify-App-Version'], '1.1.0');
    api.updateConfig('https://other.test', 'KEY-2');
    assert.equal(axios.__createConfigs.at(-1).headers['X-TABLETRACK-KEY'], 'KEY-2');
    assert.equal(axios.__createConfigs.at(-1).headers['X-Restify-App-Version'], '1.1.0');
    assert.equal(ApiService.APP_VERSION, require('../package.json').version);
});

test('testConnection subscribes the per-branch Pusher channel and reports the server', async () => {
    server();
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    const result = await api.testConnection();
    assert.equal(result.success, true);
    assert.equal(result.pusherEnabled, true);
    assert.equal(result.pusherConnected, true);
    assert.equal(result.serverVersion, '2.5.0');
    assert.equal(result.supportsHtml, true);
    assert.equal(Pusher.__instances.length, 1);
    assert.equal(Pusher.__instances[0].options.cluster, 'eu');
    assert.ok(Pusher.__instances[0].channels['print-jobs.branch-3']);
});

test('testConnection reports a failure with the server hint', async () => {
    axios.__handler = async () => {
        const err = new Error('Request failed with status code 403');
        err.response = { data: { message: 'Invalid branch key', hint: 'Copy it from Settings > Printer.' } };
        throw err;
    };
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    const result = await api.testConnection();
    assert.equal(result.success, false);
    assert.equal(result.message, 'Invalid branch key Copy it from Settings > Printer.');
});

test('a pulled HTML job is printed through printJob, marked done and logged', async () => {
    const srv = server({ jobs: [{ id: 41, printer_id: 7, html: '<p>order</p>', width_mm: 80, copies: 1, printer: { id: 7, name: 'Kitchen', print_format: 'thermal80mm' } }] });
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    const printer = fakePrinterService();
    const cb = statusCollector();

    const handled = await api.pullAndProcessJobs(printer, MAPPINGS, cb);
    assert.equal(handled, 1);
    assert.equal(printer.calls.length, 1);
    assert.equal(printer.calls[0].printerName, 'Kitchen POS-80');
    assert.equal(printer.calls[0].copies, 2);
    assert.deepEqual(srv.patches.map((p) => [p.id, p.status, p.printer]), [['41', 'done', 'Kitchen POS-80']]);

    const jobEvents = cb.ofType('job');
    assert.equal(jobEvents.length, 1);
    assert.equal(jobEvents[0].job.id, 41);
    assert.equal(jobEvents[0].job.status, 'done');
    assert.equal(jobEvents[0].job.engine, 'chromium');
    assert.equal(typeof jobEvents[0].job.ms, 'number');
    assert.equal(api.getJobLog().length, 1);
    assert.equal(api.getJobLog()[0].printer, 'Kitchen POS-80');
});

test('a failed print is reported to the server with the error', async () => {
    const srv = server({ jobs: [{ id: 42, printer_id: 8, image_path: 'https://x/a.png', image_filename: 'a.png', printer: { print_format: 'thermal56mm' } }] });
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    const cb = statusCollector();

    await api.pullAndProcessJobs(fakePrinterService({ fail: true }), MAPPINGS, cb);
    assert.deepEqual(srv.patches.map((p) => [p.id, p.status, p.error]), [['42', 'failed', 'Printer offline']]);
    assert.equal(cb.ofType('job')[0].job.status, 'failed');
    assert.equal(cb.ofType('job')[0].job.error, 'Printer offline');
});

test('a job for an unmapped printer is marked failed so the server does not wait for it', async () => {
    const srv = server({ jobs: [{ id: 43, printer_id: 99, html: '<p>x</p>', printer: { name: 'Patio' } }] });
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    const printer = fakePrinterService();
    const cb = statusCollector();

    await api.pullAndProcessJobs(printer, MAPPINGS, cb);
    assert.equal(printer.calls.length, 0);
    assert.deepEqual(srv.patches.map((p) => [p.id, p.status, p.error]), [['43', 'failed', 'No printer mapping found']]);
    assert.equal(cb.ofType('job')[0].job.printer, 'Patio');
});

test('a thrown printer error still marks the job failed', async () => {
    const srv = server({ jobs: [{ id: 44, printer_id: 7, html: '<p>x</p>' }] });
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    const printer = { async printJob() { throw new Error('boom'); } };
    const cb = statusCollector();
    await api.pullAndProcessJobs(printer, MAPPINGS, cb);
    assert.deepEqual(srv.patches.map((p) => [p.id, p.status, p.error]), [['44', 'failed', 'boom']]);
    assert.equal(cb.ofType('job')[0].job.status, 'failed');
});

test('pulls never overlap', async () => {
    const srv = server({ jobs: [{ id: 45, printer_id: 7, html: '<p>x</p>' }] });
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    const cb = statusCollector();
    const [a, b] = await Promise.all([
        api.pullAndProcessJobs(fakePrinterService(), MAPPINGS, cb),
        api.pullAndProcessJobs(fakePrinterService(), MAPPINGS, cb),
    ]);
    assert.deepEqual([a, b].sort(), [0, 1]);
    assert.equal(srv.pulls, 1);
});

test(`connection lost after ${CONNECTION_LOST_AFTER_FAILURES} failed pulls, re-tested and Pusher re-subscribed on recovery`, async () => {
    const srv = server({ pullFails: true });
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    await api.testConnection();
    const printer = fakePrinterService();
    const cb = statusCollector();

    // Running service: the channel is bound so the re-subscription can be checked.
    api.signalHandler = () => {};
    api.bindChannel();
    const firstPusher = Pusher.__instances[0];
    assert.equal(Object.keys(firstPusher.channels['print-jobs.branch-3'].handlers).length, 1);

    for (let i = 0; i < CONNECTION_LOST_AFTER_FAILURES - 1; i++) {
        await api.pullAndProcessJobs(printer, MAPPINGS, cb);
    }
    assert.equal(cb.ofType('connection').length, 0, 'not yet reported');
    await api.pullAndProcessJobs(printer, MAPPINGS, cb);
    assert.equal(cb.ofType('connection').length, 1);
    assert.equal(cb.ofType('connection')[0].ok, false);
    await api.pullAndProcessJobs(printer, MAPPINGS, cb);
    assert.equal(cb.ofType('connection').length, 1, 'reported once');

    srv.pullFails = false;
    const testsBefore = srv.tests;
    await api.pullAndProcessJobs(printer, MAPPINGS, cb);
    assert.equal(srv.tests, testsBefore + 1, 'connection re-tested');
    const restored = cb.ofType('connection')[1];
    assert.equal(restored.ok, true);
    assert.equal(restored.pusherConnected, true);
    assert.equal(firstPusher.disconnected, true, 'old socket dropped');
    assert.equal(Pusher.__instances.length, 2);
    const newChannel = Pusher.__instances[1].channels['print-jobs.branch-3'];
    assert.equal(newChannel.handlers['print-job.created'].length, 1, 'signal handler bound on the new channel');
});

test('startPolling binds the Pusher signal, warms the printer up and pulls at once; stopPolling tears down', async () => {
    const srv = server({ jobs: [{ id: 46, printer_id: 7, html: '<p>x</p>' }] });
    const api = new ApiService('https://demo.test', 'K', { logger: quiet });
    await api.testConnection();
    const printer = fakePrinterService();
    const cb = statusCollector();

    api.startPolling(printer, MAPPINGS, cb);
    assert.equal(api.isPolling(), true);
    assert.equal(printer.warmedUp, 1);
    assert.equal(cb.ofType('success').length, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(srv.patches.length, 1, 'immediate pull printed the job');

    srv.jobs.push({ id: 47, printer_id: 7, html: '<p>y</p>' });
    Pusher.__instances[0].channels['print-jobs.branch-3'].__emit('print-job.created', { id: 47 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(srv.patches.length, 2, 'Pusher signal triggered a pull');

    api.stopPolling();
    assert.equal(api.isPolling(), false);
    assert.equal(api.channel, null);
    assert.equal(Pusher.__instances[0].disconnected, true);
});

test('the job log keeps the newest 100 outcomes', () => {
    const log = new JobLog(100);
    for (let i = 1; i <= 120; i++) {
        log.add({ id: i, status: 'done' });
    }
    const all = log.all();
    assert.equal(all.length, 100);
    assert.equal(all[0].id, 120);
    assert.equal(all[99].id, 21);
    assert.ok(all[0].at);
    const small = new JobLog(2);
    small.add({ id: 'a' });
    small.add({ id: 'b' });
    small.add({ id: 'c' });
    assert.deepEqual(small.all().map((e) => e.id), ['c', 'b']);
});

test('the log file appends and rotates once past the size limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restify-log-'));
    const logger = new Logger(dir, { maxBytes: 300, echo: false });
    logger.info('service started', { printers: 2 });
    logger.error(new Error('bad ticket'));
    const first = fs.readFileSync(logger.path, 'utf8');
    assert.match(first, /\[info\] service started \{"printers":2\}/);
    assert.match(first, /\[error\] Error: bad ticket/);

    for (let i = 0; i < 20; i++) {
        logger.info(`line ${i} ${'x'.repeat(40)}`);
    }
    assert.ok(fs.existsSync(`${logger.path}.1`), 'old file kept');
    assert.ok(fs.statSync(logger.path).size < 300 + 100, 'current file restarted');
    assert.ok(fs.statSync(`${logger.path}.1`).size >= 300);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the log file never throws when the folder cannot be written', () => {
    const logger = new Logger(path.join(os.tmpdir(), 'restify-log-missing', 'a\0b'), { echo: false });
    assert.doesNotThrow(() => logger.info('hello'));
});
