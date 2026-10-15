/**
 * Prints ticket HTML silently through Electron's Chromium: the same engine and CSS as the
 * browser pop-up print, so the paper looks identical, and no screenshot or PowerShell on the way.
 *
 * One hidden BrowserWindow per printer name, reused for every job of that printer. A window can
 * render only one document at a time, so jobs for the same printer run one after the other
 * while different printers print in parallel. The window created by warmUp() is claimed by the
 * first printer that prints; idle windows are closed after a while, one is always kept warm.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

/** `require('electron')` gives a string (the binary path) outside the Electron main process. */
let electron = null;
try {
    const mod = require('electron');
    if (mod && typeof mod === 'object' && typeof mod.BrowserWindow === 'function') {
        electron = mod;
    }
} catch (_) {
    electron = null;
}

const CSS_PX_PER_INCH = 96;
const MICRONS_PER_INCH = 25400;
const MICRONS_PER_MM = 1000;

/** Paper length limits: Windows drivers reject tiny custom forms, and a roll is not endless. */
const MIN_PAGE_HEIGHT_MICRONS = 130 * MICRONS_PER_MM;
const MAX_PAGE_HEIGHT_MICRONS = 5000 * MICRONS_PER_MM;
/** Fed after the last line so the cut does not go through the footer. */
const BOTTOM_MARGIN_MICRONS = 4 * MICRONS_PER_MM;

const DEFAULT_WIDTH_MM = 80;
const LOAD_TIMEOUT_MS = 20_000;
const MEASURE_TIMEOUT_MS = 6_000;
/** Spooling to a stopped printer can hang: the job is failed rather than blocking the queue. */
const PRINT_TIMEOUT_MS = 60_000;
/** Chromium's navigation URL limit is 2 MB; bigger documents go through a temp file. */
const MAX_DATA_URL_CHARS = 1_500_000;
const IDLE_WINDOW_MS = 15 * 60_000;
const IDLE_SWEEP_MS = 5 * 60_000;

/**
 * Put at the top of <head> so it runs before any script of the ticket: a ticket that calls
 * window.print() on load would otherwise open the system print dialog from the hidden window.
 */
const GUARD_SCRIPT =
    '<script>window.print=function(){};window.close=function(){};window.open=function(){return null};</script>';

/**
 * Runs in the page after load: waits for fonts and images (capped, a missing logo must not
 * block the ticket) and measures the document, plus any explicit @page size the CSS defines.
 */
const MEASURE_SCRIPT = `(async () => {
    const cap = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
    try { await cap(document.fonts.ready, 3000); } catch (_) {}
    const imgs = Array.from(document.images);
    const settle = (img) => new Promise((res) => {
        if (img.complete) return res();
        img.addEventListener('load', () => res(), { once: true });
        img.addEventListener('error', () => res(), { once: true });
    }).then(() => (img.decode ? img.decode().catch(() => {}) : null));
    try { await cap(Promise.all(imgs.map(settle)), 3000); } catch (_) {}
    await new Promise((r) => requestAnimationFrame(() => r()));

    let pageSize = null;
    const walk = (rules) => {
        for (const rule of rules) {
            if (rule.cssRules && !(rule instanceof CSSPageRule)) { walk(rule.cssRules); continue; }
            if (rule instanceof CSSPageRule) {
                const m = /(?:^|[\\s;{])size\\s*:\\s*([^;}]+)/i.exec(rule.cssText || '');
                if (m) pageSize = m[1].trim();
            }
        }
    };
    for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (_) { continue; }
        try { walk(rules); } catch (_) {}
    }
    const de = document.documentElement;
    const body = document.body;
    const heightPx = Math.max(
        de ? de.scrollHeight : 0,
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0
    );
    return { heightPx: Math.ceil(heightPx), widthPx: de ? Math.ceil(de.scrollWidth) : 0, pageSize };
})()`;

/** One CSS length ("150mm", "5.5in", "600px") to microns, or null. */
function cssLengthToMicrons(value) {
    const m = /^\s*(-?\d*\.?\d+)\s*(mm|cm|in|px|pt|q)?\s*$/i.exec(String(value || ''));
    if (!m) return null;
    const n = parseFloat(m[1]);
    const perUnit = {
        mm: MICRONS_PER_MM,
        cm: 10 * MICRONS_PER_MM,
        in: MICRONS_PER_INCH,
        px: MICRONS_PER_INCH / CSS_PX_PER_INCH,
        pt: MICRONS_PER_INCH / 72,
        q: MICRONS_PER_MM / 4,
    }[(m[2] || 'px').toLowerCase()];
    const microns = Math.round(n * perUnit);
    return microns > 0 ? microns : null;
}

/** The explicit height of an `@page { size: ... }` value ("80mm 150mm" → 150 mm), or null. */
function pageRuleHeightMicrons(size) {
    if (!size) return null;
    const parts = String(size).trim().split(/\s+/).filter((p) => !/^(portrait|landscape)$/i.test(p));
    if (parts.length === 2) return cssLengthToMicrons(parts[1]);
    if (parts.length === 1 && /^[\d.]/.test(parts[0])) return cssLengthToMicrons(parts[0]);
    return null; // auto, a named size, or garbage: the paper we pass decides
}

function cssPxToMicrons(px) {
    return Math.round((px * MICRONS_PER_INCH) / CSS_PX_PER_INCH);
}

/**
 * Paper length for one job: the measured content (print media) plus a bottom margin, never
 * shorter than an explicit @page height (Chromium would scale the page down to fit), clamped.
 * Continuous roll paper gets one tall page, never a second sheet.
 */
function computePageHeightMicrons(measure) {
    const heightPx = Number(measure && measure.heightPx) || 0;
    let microns = cssPxToMicrons(heightPx) + BOTTOM_MARGIN_MICRONS;
    const ruleHeight = pageRuleHeightMicrons(measure && measure.pageSize);
    if (ruleHeight) microns = Math.max(microns, ruleHeight);
    return Math.min(MAX_PAGE_HEIGHT_MICRONS, Math.max(MIN_PAGE_HEIGHT_MICRONS, microns));
}

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function injectGuard(html) {
    const text = String(html);
    if (/<head[^>]*>/i.test(text)) return text.replace(/<head[^>]*>/i, (m) => m + GUARD_SCRIPT);
    if (/<html[^>]*>/i.test(text)) return text.replace(/<html[^>]*>/i, (m) => m + GUARD_SCRIPT);
    return GUARD_SCRIPT + text;
}

class ChromiumPrinter {
    constructor() {
        /** printer name → { win, lastUsed }; '' is the spare window made by warmUp(). */
        this.windows = new Map();
        /** printer name → promise of the last queued job, so jobs of one printer run in order. */
        this.queues = new Map();
        this.sweeper = null;
    }

    get available() {
        return electron !== null;
    }

    /** Create the first hidden window early: the first ticket must not pay for it. */
    async warmUp() {
        if (!electron) return false;
        try {
            await this.windowFor('');
            return true;
        } catch (e) {
            console.warn('Chromium print window could not be created:', e.message);
            return false;
        }
    }

    /**
     * @param {{ html: string, printerName?: string, widthMm?: number, copies?: number, dpi?: {horizontal:number, vertical:number} }} job
     * @returns {Promise<{ success: boolean, error?: string, heightMm?: number, durationMs?: number }>}
     */
    printHtml(job) {
        if (!electron) {
            return Promise.resolve({ success: false, error: 'Chromium printing needs the Electron main process' });
        }
        if (!job || typeof job.html !== 'string' || !job.html.trim()) {
            return Promise.resolve({ success: false, error: 'No HTML to print' });
        }
        const key = String(job.printerName || '');
        const previous = this.queues.get(key) || Promise.resolve();
        const run = previous
            .catch(() => {})
            .then(() => this.runJob(key, job))
            .catch((e) => ({ success: false, error: e.message || String(e) }));
        this.queues.set(key, run);
        run.finally(() => {
            if (this.queues.get(key) === run) this.queues.delete(key);
        });
        return run;
    }

    async runJob(printerName, job) {
        const started = Date.now();
        const widthMm = Number(job.widthMm) > 0 ? Number(job.widthMm) : DEFAULT_WIDTH_MM;
        const copies = Math.max(1, Math.min(20, parseInt(job.copies, 10) || 1));

        const win = await this.windowFor(printerName);
        const wc = win.webContents;
        this.resize(win, widthMm);

        const onDomReady = () => {
            // Belt and braces next to the guard script: with contextIsolation only this reaches the page's window.
            wc.executeJavaScript('window.print=function(){};window.close=function(){};true').catch(() => {});
        };
        wc.once('dom-ready', onDomReady);
        let tempFile = null;
        try {
            const html = injectGuard(job.html);
            const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
            if (dataUrl.length <= MAX_DATA_URL_CHARS) {
                await withTimeout(win.loadURL(dataUrl), LOAD_TIMEOUT_MS, 'ticket HTML did not load in time');
            } else {
                tempFile = path.join(os.tmpdir(), `restify-ticket-${process.pid}-${Date.now()}.html`);
                await fs.promises.writeFile(tempFile, html, 'utf8');
                await withTimeout(win.loadFile(tempFile), LOAD_TIMEOUT_MS, 'ticket HTML did not load in time');
            }
        } finally {
            wc.removeListener('dom-ready', onDomReady);
            if (tempFile) fs.promises.unlink(tempFile).catch(() => {});
        }

        await this.emulatePrintMedia(wc);
        let measure = { heightPx: 0, pageSize: null };
        try {
            measure = await withTimeout(wc.executeJavaScript(MEASURE_SCRIPT, true), MEASURE_TIMEOUT_MS, 'measure timed out');
        } catch (e) {
            console.warn('Ticket could not be measured, printing on the minimum length:', e.message);
        }
        const heightMicrons = computePageHeightMicrons(measure);

        const options = {
            silent: true,
            printBackground: true,
            color: false,
            margins: { marginType: 'none' },
            landscape: false,
            copies,
            pageSize: { width: Math.round(widthMm * MICRONS_PER_MM), height: heightMicrons },
        };
        if (printerName) options.deviceName = printerName; // exactly as getPrintersAsync() names it
        if (job.dpi && Number(job.dpi.horizontal) > 0 && Number(job.dpi.vertical) > 0) {
            options.dpi = { horizontal: Number(job.dpi.horizontal), vertical: Number(job.dpi.vertical) };
        }

        try {
            await withTimeout(
                new Promise((resolve, reject) => {
                    try {
                        wc.print(options, (success, failureReason) => {
                            if (success) resolve();
                            else reject(new Error(failureReason || 'print failed'));
                        });
                    } catch (e) {
                        reject(e);
                    }
                }),
                PRINT_TIMEOUT_MS,
                'printer did not answer within 60 s'
            );
        } catch (e) {
            if (/did not answer/.test(e.message)) this.dropWindow(printerName); // a stuck print job stays with the old window
            throw e;
        }

        const entry = this.windows.get(printerName);
        if (entry) entry.lastUsed = Date.now();
        return {
            success: true,
            heightMm: Math.round(heightMicrons / MICRONS_PER_MM),
            durationMs: Date.now() - started,
        };
    }

    /** Layout under print media, so the measured height is the printed height (print-only CSS included). */
    async emulatePrintMedia(wc) {
        try {
            if (!wc.debugger) return;
            if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
            await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
        } catch (e) {
            console.warn('Print media emulation unavailable, measuring as screen:', e.message);
        }
    }

    resize(win, widthMm) {
        try {
            const widthPx = Math.max(200, Math.ceil((widthMm * CSS_PX_PER_INCH) / 25.4));
            win.setContentSize(widthPx, 800);
        } catch (_) {
            /* a destroyed window is re-created on the next job */
        }
    }

    /** @returns {Promise<Array<{ name: string, displayName: string, isDefault: boolean, status: number }>>} */
    async getPrinters() {
        if (!electron) throw new Error('Chromium printing needs the Electron main process');
        let win = null;
        for (const entry of this.windows.values()) {
            if (entry.win && !entry.win.isDestroyed()) { win = entry.win; break; }
        }
        if (!win) win = await this.windowFor('');
        const list = await win.webContents.getPrintersAsync();
        return (list || []).map((p) => ({
            name: p.name,
            displayName: p.displayName || p.name,
            isDefault: !!p.isDefault,
            status: p.status,
        }));
    }

    /** The hidden window of a printer; the spare one from warmUp() is claimed first. */
    async windowFor(printerName) {
        const live = this.windows.get(printerName);
        if (live && live.win && !live.win.isDestroyed()) return live.win;
        this.windows.delete(printerName);

        if (printerName !== '') {
            const spare = this.windows.get('');
            if (spare && spare.win && !spare.win.isDestroyed()) {
                this.windows.delete('');
                this.windows.set(printerName, spare);
                return spare.win;
            }
            this.windows.delete('');
        }

        const win = await this.createWindow();
        this.windows.set(printerName, { win, lastUsed: Date.now() });
        win.on('closed', () => {
            const entry = this.windows.get(printerName);
            if (entry && entry.win === win) this.windows.delete(printerName);
        });
        this.startSweeper();
        return win;
    }

    dropWindow(printerName) {
        const entry = this.windows.get(printerName);
        this.windows.delete(printerName);
        try {
            if (entry && entry.win && !entry.win.isDestroyed()) entry.win.destroy();
        } catch (_) {
            /* ignore */
        }
    }

    async createWindow() {
        const { app, BrowserWindow } = electron;
        if (app && typeof app.isReady === 'function' && !app.isReady()) await app.whenReady();
        const win = new BrowserWindow({
            show: false,
            width: 302,
            height: 800,
            frame: false,
            skipTaskbar: true,
            focusable: false,
            webPreferences: {
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                javascript: true,
                preload: path.join(__dirname, 'print-preload.js'),
                backgroundThrottling: false, // hidden window: image loads and timers must not be slowed
            },
        });
        const wc = win.webContents;
        if (typeof wc.setWindowOpenHandler === 'function') wc.setWindowOpenHandler(() => ({ action: 'deny' }));
        if (typeof wc.setAudioMuted === 'function') wc.setAudioMuted(true);
        wc.on('will-navigate', (event) => event.preventDefault()); // loadURL/loadFile bypass this; page links do not
        return win;
    }

    startSweeper() {
        if (this.sweeper) return;
        this.sweeper = setInterval(() => this.closeIdleWindows(), IDLE_SWEEP_MS);
        if (typeof this.sweeper.unref === 'function') this.sweeper.unref();
    }

    /** Memory back when a printer has been quiet for a while; one window stays warm. */
    closeIdleWindows() {
        const now = Date.now();
        const entries = [...this.windows.entries()];
        if (entries.length <= 1) return;
        entries.sort((a, b) => b[1].lastUsed - a[1].lastUsed);
        for (const [name, entry] of entries.slice(1)) {
            if (now - entry.lastUsed < IDLE_WINDOW_MS || this.queues.has(name)) continue;
            this.windows.delete(name);
            try { entry.win.destroy(); } catch (_) { /* ignore */ }
        }
    }

    /** Closes every hidden window; the next job or warmUp() creates them again. */
    shutdown() {
        if (this.sweeper) {
            clearInterval(this.sweeper);
            this.sweeper = null;
        }
        for (const [, entry] of this.windows) {
            try {
                if (entry.win && !entry.win.isDestroyed()) entry.win.destroy();
            } catch (_) {
                /* ignore */
            }
        }
        this.windows.clear();
    }
}

module.exports = new ChromiumPrinter();
module.exports.ChromiumPrinter = ChromiumPrinter;
module.exports.computePageHeightMicrons = computePageHeightMicrons;
module.exports.pageRuleHeightMicrons = pageRuleHeightMicrons;
module.exports.injectGuard = injectGuard;
module.exports.MIN_PAGE_HEIGHT_MICRONS = MIN_PAGE_HEIGHT_MICRONS;
module.exports.MAX_PAGE_HEIGHT_MICRONS = MAX_PAGE_HEIGHT_MICRONS;
