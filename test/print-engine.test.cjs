/**
 * Print dispatch tests, no Electron or printer needed:
 *   NODE_PATH=test/stubs/node_modules node test/print-engine.test.cjs
 * `electron`, `axios`, `node-thermal-printer` and `pdf-to-printer` resolve to test/stubs; the
 * image engine's PowerShell worker is test/stubs/powershell-stub.sh (same protocol).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const stubLog = path.join(os.tmpdir(), `restify-print-stub-${process.pid}.log`);
process.env.RESTIFY_POWERSHELL = path.join(__dirname, 'stubs', 'powershell-stub.sh');
process.env.RESTIFY_PRINT_STUB_LOG = stubLog;

let electron;
try {
    electron = require('electron');
} catch (e) {
    console.error('Run with NODE_PATH=test/stubs/node_modules (stub electron not found)');
    process.exit(1);
}
if (!electron.__state) {
    console.error('The real electron package was resolved; run with NODE_PATH=test/stubs/node_modules');
    process.exit(1);
}
const state = electron.__state;

const PrinterService = require('../services/PrinterService');
const chromium = require('../services/ChromiumPrinter');
const { computePageHeightMicrons, pageRuleHeightMicrons, injectGuard, MIN_PAGE_HEIGHT_MICRONS, MAX_PAGE_HEIGHT_MICRONS } =
    chromium;

const KITCHEN = 'Kitchen POS-80';
const BAR = 'Bar XP-58';
const TICKET_HTML = '<!DOCTYPE html><html><head><style>@page{margin:0;size:auto}body{width:72mm}</style></head>' +
    '<body><h1>Order #12</h1><script>window.print()</script></body></html>';

function resetState() {
    state.prints.length = 0;
    state.activePrints = 0;
    state.maxActivePrints = 0;
    state.failDevices.clear();
    state.measure = { heightPx: 1000, widthPx: 302, pageSize: null };
}

function stubRequests() {
    try {
        return fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (_) {
        return [];
    }
}

let service;

before(async () => {
    service = new PrinterService();
    await service.warmUp();
});

after(() => {
    service.shutdown();
    try { fs.unlinkSync(stubLog); } catch (_) { /* ignore */ }
});

test('page height: content height in CSS px, bottom margin, clamps and @page rule', () => {
    // 1000 px at 96 dpi = 264.58 mm, plus 4 mm bottom margin
    assert.equal(computePageHeightMicrons({ heightPx: 1000 }), 268583);
    assert.equal(computePageHeightMicrons({ heightPx: 100 }), MIN_PAGE_HEIGHT_MICRONS);
    assert.equal(computePageHeightMicrons({ heightPx: 1_000_000 }), MAX_PAGE_HEIGHT_MICRONS);
    // an explicit @page height taller than the content wins (Chromium would shrink the page otherwise)
    assert.equal(computePageHeightMicrons({ heightPx: 1000, pageSize: '80mm 300mm' }), 300_000);
    assert.equal(computePageHeightMicrons({ heightPx: 1000, pageSize: '80mm 150mm' }), 268583);
    assert.equal(pageRuleHeightMicrons('auto'), null);
    assert.equal(pageRuleHeightMicrons('A4'), null);
    assert.equal(pageRuleHeightMicrons('80mm 150mm portrait'), 150_000);
    assert.equal(pageRuleHeightMicrons('8in'), 203_200);
});

test('the guard script lands before any page script', () => {
    const out = injectGuard(TICKET_HTML);
    assert.ok(out.indexOf('window.print=function(){}') < out.indexOf('<style>'));
    assert.ok(injectGuard('<p>no head</p>').startsWith('<script>'));
});

test('getSystemPrinters comes from Chromium with name, type and isDefault', async () => {
    const printers = await service.getSystemPrinters();
    assert.deepEqual(
        printers.map((p) => [p.name, p.type, p.isDefault]),
        [[KITCHEN, 'linux', true], [BAR, 'linux', false]]
    );
});

test('an HTML job prints through Chromium with the paper width and device name', async () => {
    resetState();
    const result = await service.printJob({ html: TICKET_HTML, printerName: KITCHEN, widthMm: 80, copies: 2 });
    assert.equal(result.success, true);
    assert.equal(result.engine, 'chromium');
    assert.equal(result.heightMm, 269);
    assert.equal(state.prints.length, 1);
    const { options } = state.prints[0];
    assert.equal(options.deviceName, KITCHEN);
    assert.equal(options.silent, true);
    assert.equal(options.printBackground, true);
    assert.equal(options.copies, 2);
    assert.deepEqual(options.margins, { marginType: 'none' });
    assert.deepEqual(options.pageSize, { width: 80000, height: 268583 });

    const win = state.windows.find((w) => w.loads.length > 0);
    assert.ok(win, 'a hidden window loaded the ticket');
    const url = win.loads[win.loads.length - 1].url;
    assert.ok(url.startsWith('data:text/html;charset=utf-8,'));
    const loaded = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    assert.ok(loaded.includes('window.print=function(){}'));
    assert.ok(loaded.includes('Order #12'));
    assert.deepEqual(win.size, [303, 800]);
    assert.ok(win.webContents.calls.some((c) => c[0] === 'cdp' && c[1] === 'Emulation.setEmulatedMedia'));
    // the warm-up window was reused, not a second one created
    assert.equal(state.windows.length, 1);
});

test('56 mm and 112 mm widths are passed in microns', async () => {
    resetState();
    await service.printJob({ html: TICKET_HTML, printerName: KITCHEN, widthMm: 56 });
    await service.printJob({ html: TICKET_HTML, printerName: KITCHEN, widthMm: 112 });
    assert.equal(state.prints[0].options.pageSize.width, 56000);
    assert.equal(state.prints[1].options.pageSize.width, 112000);
    assert.equal(state.prints[1].options.copies, 1);
});

test('two jobs for the same printer run one after the other', async () => {
    resetState();
    state.printDelayMs = 60;
    const results = await Promise.all([
        service.printJob({ html: TICKET_HTML.replace('#12', '#1'), printerName: KITCHEN, widthMm: 80 }),
        service.printJob({ html: TICKET_HTML.replace('#12', '#2'), printerName: KITCHEN, widthMm: 80 }),
    ]);
    assert.deepEqual(results.map((r) => r.success), [true, true]);
    assert.equal(state.prints.length, 2);
    assert.equal(state.maxActivePrints, 1);
    assert.ok(state.prints[1].startedAt >= state.prints[0].finishedAt, 'second print waited for the first');
    const win = state.windows.find((w) => !w.isDestroyed() && w.loads.length >= 2);
    const [first, second] = win.loads.slice(-2);
    assert.ok(decodeURIComponent(first.url).includes('Order #1<'));
    assert.ok(decodeURIComponent(second.url).includes('Order #2<'));
    assert.ok(second.at >= state.prints[0].finishedAt, 'second ticket loaded only after the first was printed');
});

test('jobs for different printers run at the same time, each in its own window', async () => {
    resetState();
    state.printDelayMs = 80;
    const results = await Promise.all([
        service.printJob({ html: TICKET_HTML, printerName: KITCHEN, widthMm: 80 }),
        service.printJob({ html: TICKET_HTML, printerName: BAR, widthMm: 56 }),
    ]);
    assert.deepEqual(results.map((r) => [r.success, r.engine]), [[true, 'chromium'], [true, 'chromium']]);
    assert.equal(state.maxActivePrints, 2, 'both printers were busy at once');
    assert.deepEqual(state.prints.map((p) => p.deviceName).sort(), [BAR, KITCHEN]);
    assert.equal(state.windows.filter((w) => !w.isDestroyed()).length, 2);
});

test('a Chromium failure falls back to the image engine when the job has an image', async () => {
    resetState();
    state.printDelayMs = 10;
    state.failDevices.add(BAR);
    const before = stubRequests().length;
    const result = await service.printJob({
        html: TICKET_HTML,
        imageUrl: 'https://example.test/tickets/12.png',
        printerName: BAR,
        widthMm: 80,
        copies: 2,
    });
    assert.equal(result.success, true);
    assert.equal(result.engine, 'image');
    assert.equal(result.fallback, true);
    assert.equal(result.reason, 'Invalid printer settings');
    const printed = stubRequests().slice(before);
    assert.equal(printed.length, 2, 'copies are honoured by the image engine');
    assert.ok(printed.every((r) => r.printerName === BAR));
    assert.ok(printed.every((r) => r.imagePath.endsWith('.png')));
});

test('a Chromium failure without an image is reported as a chromium error', async () => {
    resetState();
    state.failDevices.add(KITCHEN);
    const result = await service.printJob({ html: TICKET_HTML, printerName: KITCHEN, widthMm: 80 });
    assert.deepEqual(result, { success: false, error: 'Invalid printer settings', engine: 'chromium' });
});

test('no HTML, or engine forced to image, uses the image engine directly', async () => {
    resetState();
    const before = stubRequests().length;
    const noHtml = await service.printJob({ imageUrl: 'https://example.test/13.png', printerName: KITCHEN, widthMm: 80 });
    assert.deepEqual([noHtml.success, noHtml.engine, noHtml.fallback], [true, 'image', undefined]);
    const forced = await service.printJob({
        html: TICKET_HTML,
        imageUrl: 'https://example.test/14.png',
        printerName: KITCHEN,
        engine: 'image',
    });
    assert.deepEqual([forced.success, forced.engine], [true, 'image']);
    assert.equal(state.prints.length, 0, 'Chromium was not asked');
    assert.equal(stubRequests().length - before, 2);
});

test('the old print() signature still works', async () => {
    resetState();
    const before = stubRequests().length;
    const result = await service.print(KITCHEN, 'https://example.test/15.png', 'image', 'thermal80mm');
    assert.deepEqual([result.success, result.engine], [true, 'image']);
    assert.equal(stubRequests().length - before, 1);
    const html = await service.print(KITCHEN, TICKET_HTML, 'html', 'thermal56mm');
    assert.deepEqual([html.success, html.engine], [true, 'chromium']);
    assert.equal(state.prints[0].options.pageSize.width, 56000);
});

test('a job with nothing to print fails cleanly', async () => {
    const result = await service.printJob({ printerName: KITCHEN });
    assert.equal(result.success, false);
    assert.match(result.error, /Nothing to print/);
    const noPrinter = await service.printJob({ html: TICKET_HTML });
    assert.equal(noPrinter.success, false);
});

test('shutdown closes the hidden windows and a later job re-creates one', async () => {
    resetState();
    service.shutdown();
    assert.ok(state.windows.every((w) => w.isDestroyed()));
    const result = await service.printJob({ html: TICKET_HTML, printerName: KITCHEN, widthMm: 80 });
    assert.equal(result.success, true);
    assert.equal(state.windows.filter((w) => !w.isDestroyed()).length, 1);
});
