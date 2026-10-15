const { ipcRenderer } = require('electron');

// Every element is optional: a missing id must never stop the rest of the window from working.
const $ = (id) => document.getElementById(id);

const domainUrlInput = $('domain-url');
const apiKeyInput = $('api-key');
const testConnectionBtn = $('test-connection');
const refreshPrintersBtn = $('refresh-printers');
const saveMappingsBtn = $('save-mappings');
const startStopBtn = $('save-start-printing');
const autostartToggle = $('autostart-toggle');
const checkUpdatesBtn = $('check-updates-btn');
const installUpdateBtn = $('install-update-btn');
const openLogBtn = $('open-log-btn');
const connectionStatus = $('connection-status');
const printerMappingsContainer = $('printer-mappings');
const recentPrintsContainer = $('recent-prints');
const autostartStatus = $('autostart-status');
const statusText = $('status-text');
const appVersionSpan = $('app-version');

const RECENT_PRINTS_SHOWN = 20;
const ENGINES = [
    { value: 'auto', label: 'Auto (Chromium for HTML)' },
    { value: 'image', label: 'Image (legacy worker)' },
];

// State
let config = {};
let systemPrinters = [];
let remotePrinters = [];
let printerMappings = [];
let isConnected = false;
let serviceStatus = null;
let jobLog = [];
let mappingsDirty = false;

// ---------------------------------------------------------------------------
// Small helpers

function setText(el, text) {
    if (el) {
        el.textContent = text;
    }
}

function setHtml(el, html) {
    if (el) {
        el.innerHTML = html;
    }
}

function setButton(button, { disabled, icon, label } = {}) {
    if (!button) {
        return;
    }
    if (disabled !== undefined) {
        button.disabled = disabled;
    }
    if (icon !== undefined || label !== undefined) {
        const size = button.classList.contains('btn-pill') ? '' : ' style="font-size: 18px;"';
        button.innerHTML = `<i class="material-icons"${size}>${icon}</i><span>${label}</span>`;
    }
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function showToast(message, type = 'info') {
    const toast = $('toast');
    if (!toast) {
        return;
    }
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function widthFromFormat(format) {
    const match = /(\d+)\s*mm/i.exec(String(format || ''));
    return match ? parseInt(match[1], 10) : 80;
}

function formatTime(iso) {
    if (!iso) {
        return '';
    }
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
}

async function invoke(channel, payload) {
    try {
        return await ipcRenderer.invoke(channel, payload);
    } catch (error) {
        console.error(`${channel} failed`, error);
        return { success: false, message: error.message };
    }
}

// ---------------------------------------------------------------------------
// Init

async function init() {
    config = (await invoke('get-config')) || {};
    const version = await invoke('get-app-version');

    if (domainUrlInput) domainUrlInput.value = config.domainUrl || '';
    if (apiKeyInput) apiKeyInput.value = config.apiKey || '';
    if (typeof version === 'string') {
        setText(appVersionSpan, version);
        setText($('service-version'), `v${version}`);
    }

    updateAutostartButton(config.autoStart);
    printerMappings = Array.isArray(config.printerMappings) ? config.printerMappings : [];

    const status = await invoke('get-status');
    if (status && status.service) {
        renderServiceStatus(status);
    }
    const log = await invoke('get-job-log');
    if (Array.isArray(log)) {
        jobLog = log;
        renderRecentPrints();
    }

    // Local printers never need the server: show saved mappings right away.
    await loadSystemPrinters();
    renderPrinterMappings();

    if (config.domainUrl && config.apiKey) {
        const ok = await testConnection({ quiet: true });
        if (ok) {
            await refreshPrinters({ quiet: true });
        }
    }
}

// ---------------------------------------------------------------------------
// Launch at login

function updateAutostartButton(isActive) {
    if (!autostartToggle) {
        return;
    }
    if (isActive) {
        autostartToggle.className = 'btn-pill btn-pill-red';
        setButton(autostartToggle, { icon: 'power_off', label: 'Disable Autostart' });
    } else {
        autostartToggle.className = 'btn-pill btn-pill-green';
        setButton(autostartToggle, { icon: 'power_settings_new', label: 'Enable Autostart' });
    }
}

// ---------------------------------------------------------------------------
// Service status card

function renderServiceStatus(status) {
    serviceStatus = status;
    const svc = status.service || {};
    const dot = $('service-state');
    const stateText = $('service-state-text');
    const since = $('service-since');

    const dots = { running: 'dot-green', starting: 'dot-amber', retrying: 'dot-red', stopped: 'dot-grey' };
    if (dot) {
        dot.className = `dot ${dots[svc.state] || 'dot-grey'}`;
    }
    switch (svc.state) {
        case 'running':
            setText(stateText, 'Running');
            setText(since, `since ${formatTime(svc.since)}`);
            break;
        case 'starting':
            setText(stateText, 'Starting...');
            setText(since, '');
            break;
        case 'retrying':
            setText(stateText, 'Retrying');
            setText(since, svc.nextRetryAt ? `next try at ${formatTime(svc.nextRetryAt)}` : '');
            break;
        default:
            setText(stateText, 'Stopped');
            setText(since, status.configured ? '' : 'Set the connection and map a printer');
    }

    const conn = $('service-connection');
    const connSub = $('service-connection-sub');
    if (conn) {
        if (svc.connection && svc.connection.ok === true) {
            conn.className = 'status-value ok';
            conn.textContent = 'OK';
        } else if (svc.connection && svc.connection.ok === false) {
            conn.className = 'status-value bad';
            conn.textContent = 'Failed';
        } else {
            conn.className = 'status-value';
            conn.textContent = 'Not tested';
        }
    }
    setText(connSub, svc.connection && svc.connection.ok === false ? (svc.connection.message || '') : (svc.connection && svc.connection.at ? `checked ${formatTime(svc.connection.at)}` : ''));

    const pusher = $('service-pusher');
    if (pusher) {
        pusher.className = `status-value ${svc.pusher ? 'ok' : ''}`;
        pusher.textContent = svc.state === 'running' ? (svc.pusher ? 'On' : 'Off (polling only)') : 'Off';
    }

    if (status.version) {
        setText($('service-version'), `v${status.version}`);
        setText(appVersionSpan, status.version);
    }
    setText($('service-server-version'), svc.serverVersion ? `server ${svc.serverVersion}${svc.supportsHtml === false ? ' (no HTML tickets)' : ''}` : '');

    if (status.update) {
        renderUpdateStatus(status.update);
    }
    if (status.autoStart !== undefined) {
        config.autoStart = status.autoStart;
        updateAutostartButton(status.autoStart);
    }

    const running = svc.state && svc.state !== 'stopped';
    if (startStopBtn) {
        startStopBtn.className = running ? 'btn btn-danger btn-sm' : 'btn btn-dark btn-sm';
        setButton(startStopBtn, {
            disabled: !(running || status.configured || printerMappings.length > 0),
            icon: running ? 'stop' : 'play_arrow',
            label: running ? 'Stop printing' : 'Start printing',
        });
    }
    if (autostartStatus) {
        if (running && svc.state === 'retrying') {
            autostartStatus.className = 'status-message error';
            autostartStatus.textContent = `Server unreachable: ${svc.lastError || 'no details'}. The app keeps trying by itself.`;
        } else if (running) {
            autostartStatus.className = 'status-message success';
            autostartStatus.textContent = 'Printing service is running. You can close this window; it keeps printing from the tray and starts again with the computer.';
        } else {
            autostartStatus.className = 'status-message';
            autostartStatus.textContent = '';
        }
    }
}

function renderUpdateStatus(update) {
    const message = $('update-message');
    const progress = $('update-progress');
    const bar = $('update-progress-bar');
    const texts = {
        idle: 'Checked automatically every 4 hours and installed when printing is idle.',
        checking: 'Checking for updates...',
        available: update.message || `Update v${update.version} found, downloading...`,
        downloading: update.message || 'Downloading update...',
        downloaded: update.message || `Update v${update.version} ready. It installs when no ticket has printed for a minute.`,
        'not-available': `You are running the latest version${update.checkedAt ? ` (checked ${formatTime(update.checkedAt)})` : ''}.`,
        error: `Update check failed: ${update.message || 'unknown error'}`,
    };
    setText(message, texts[update.status] || update.message || '');
    if (progress && bar) {
        const show = update.status === 'downloading' || update.status === 'available';
        progress.classList.toggle('hidden', !show);
        bar.style.width = `${Math.max(0, Math.min(100, update.percent || 0))}%`;
    }
    if (installUpdateBtn) {
        installUpdateBtn.classList.toggle('hidden', update.status !== 'downloaded');
    }
}

// ---------------------------------------------------------------------------
// Connection

async function testConnection({ quiet = false } = {}) {
    setButton(testConnectionBtn, { disabled: true, icon: 'hourglass_empty', label: 'Testing...' });
    setText(statusText, 'Testing connection...');

    try {
        const saved = await invoke('save-config', {
            domainUrl: domainUrlInput ? domainUrlInput.value : config.domainUrl,
            apiKey: apiKeyInput ? apiKeyInput.value : config.apiKey,
        });
        if (saved && saved.config) {
            config = { ...config, ...saved.config };
            // Saving a valid setup switches launch at login on the first time.
            updateAutostartButton(config.autoStart);
        }

        const result = await invoke('test-connection');
        isConnected = Boolean(result && result.success);
        if (connectionStatus) {
            connectionStatus.textContent = isConnected ? 'Connected' : 'Disconnected';
            connectionStatus.className = `status-badge ${isConnected ? 'connected' : 'disconnected'}`;
        }
        if (isConnected) {
            if (!quiet) showToast('Connection successful', 'success');
            setText(statusText, 'Connected');
        } else {
            showToast((result && result.message) || 'Connection failed', 'error');
            setText(statusText, 'Connection failed');
        }
        if (refreshPrintersBtn) refreshPrintersBtn.disabled = false;
        return isConnected;
    } catch (error) {
        isConnected = false;
        showToast('Connection error: ' + error.message, 'error');
        setText(statusText, 'Error');
        return false;
    } finally {
        setButton(testConnectionBtn, { disabled: false, icon: 'wifi', label: 'Test Connection' });
    }
}

// ---------------------------------------------------------------------------
// Printers and mappings

async function loadSystemPrinters() {
    const result = await invoke('get-system-printers');
    if (result && result.success) {
        systemPrinters = result.printers || [];
    } else if (result && result.message) {
        showToast('Could not list local printers: ' + result.message, 'error');
    }
}

async function refreshPrinters({ quiet = false } = {}) {
    setButton(refreshPrintersBtn, { disabled: true, icon: 'hourglass_empty', label: 'Loading...' });
    setText(statusText, 'Fetching printers...');

    try {
        await loadSystemPrinters();
        const remoteResult = await invoke('refresh-printers');
        if (remoteResult && remoteResult.success) {
            remotePrinters = remoteResult.printers || [];
            isConnected = true;
            renderPrinterMappings();
            if (!quiet) showToast('Printers loaded', 'success');
            setText(statusText, `${remotePrinters.length} printer(s) on the server, ${systemPrinters.length} on this computer`);
        } else {
            renderPrinterMappings();
            showToast((remoteResult && remoteResult.message) || 'Failed to fetch printers', 'error');
            setText(statusText, 'Failed to load printers');
        }
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
        setText(statusText, 'Error');
    } finally {
        setButton(refreshPrintersBtn, { disabled: false, icon: 'refresh', label: 'Refresh Printers' });
    }
}

/** Rows to show: the server's printers when loaded, else the saved mappings. */
function mappingRows() {
    if (remotePrinters.length > 0) {
        return remotePrinters.map((p) => ({
            id: p.id,
            name: p.name,
            printFormat: p.print_format || 'thermal80mm',
            printType: p.print_type || 'image',
            printingChoice: p.printing_choice || null,
        }));
    }
    return printerMappings.map((m) => ({
        id: m.remotePrinterId,
        name: m.remotePrinterName || `Printer ${m.remotePrinterId}`,
        printFormat: m.printFormat || 'thermal80mm',
        printType: m.printType || 'image',
        printingChoice: null,
    }));
}

function renderPrinterMappings() {
    if (!printerMappingsContainer) {
        return;
    }
    const rows = mappingRows();
    if (rows.length === 0) {
        printerMappingsContainer.innerHTML = '<p class="text-muted">No printers found on the server. Add printers in Restify under Settings &gt; Printer, then refresh.</p>';
        updateMappingButtons();
        return;
    }

    const defaultPrinter = systemPrinters.find((p) => p.isDefault);
    const printerOptions = (selected) => [
        '<option value="">-- Select local printer --</option>',
        ...systemPrinters.map((sp) => `<option value="${esc(sp.name)}" ${sp.name === selected ? 'selected' : ''}>${esc(sp.name)}${sp.isDefault ? ' (default)' : ''}</option>`),
        // A saved printer that is no longer installed stays selectable so the row is not lost silently.
        ...(selected && !systemPrinters.some((sp) => sp.name === selected)
            ? [`<option value="${esc(selected)}" selected>${esc(selected)} (not installed)</option>`]
            : []),
    ].join('');

    const body = rows.map((row) => {
        const mapping = printerMappings.find((m) => m.remotePrinterId === row.id) || {};
        const copies = Math.min(5, Math.max(1, parseInt(mapping.copies, 10) || 1));
        const engine = mapping.engine || 'auto';
        return `
            <tr class="${mapping.localPrinterName ? '' : 'unmapped'}" data-printer-id="${esc(row.id)}">
                <td>
                    <span class="remote-name">${esc(row.name)}</span>
                    <span class="remote-format">${esc(row.printFormat)} · ${widthFromFormat(row.printFormat)} mm</span>
                </td>
                <td><select class="mapping-select" data-field="localPrinterName" data-printer-id="${esc(row.id)}">${printerOptions(mapping.localPrinterName)}</select></td>
                <td class="col-copies"><input type="number" min="1" max="5" step="1" value="${copies}" class="mapping-copies" data-field="copies" data-printer-id="${esc(row.id)}"></td>
                <td class="col-engine">
                    <select class="mapping-engine" data-field="engine" data-printer-id="${esc(row.id)}">
                        ${ENGINES.map((e) => `<option value="${e.value}" ${e.value === engine ? 'selected' : ''}>${e.label}</option>`).join('')}
                    </select>
                </td>
                <td class="col-test">
                    <button class="btn btn-light btn-sm test-print-btn" data-printer-id="${esc(row.id)}" ${mapping.localPrinterName ? '' : 'disabled'}>
                        <i class="material-icons" style="font-size: 18px;">print</i><span>Test print</span>
                    </button>
                </td>
            </tr>`;
    }).join('');

    printerMappingsContainer.innerHTML = `
        <table class="mapping-table">
            <thead>
                <tr>
                    <th>Restify printer</th>
                    <th>Local printer${defaultPrinter ? ` <span class="muted-note">(default: ${esc(defaultPrinter.name)})</span>` : ''}</th>
                    <th class="col-copies">Copies</th>
                    <th class="col-engine">Engine</th>
                    <th class="col-test"></th>
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>`;

    printerMappingsContainer.querySelectorAll('[data-field]').forEach((el) => {
        el.addEventListener('change', handleMappingChange);
    });
    printerMappingsContainer.querySelectorAll('.test-print-btn').forEach((btn) => {
        btn.addEventListener('click', () => testPrint(btn));
    });
    updateMappingButtons();
}

function rowValues(printerId) {
    const row = printerMappingsContainer ? printerMappingsContainer.querySelector(`tr[data-printer-id="${CSS.escape(String(printerId))}"]`) : null;
    if (!row) {
        return null;
    }
    const remote = mappingRows().find((r) => String(r.id) === String(printerId)) || {};
    const select = row.querySelector('[data-field="localPrinterName"]');
    const copies = row.querySelector('[data-field="copies"]');
    const engine = row.querySelector('[data-field="engine"]');
    return {
        remotePrinterId: remote.id,
        remotePrinterName: remote.name || '',
        localPrinterName: select ? select.value : '',
        printFormat: remote.printFormat || 'thermal80mm',
        printType: remote.printType || 'image',
        copies: Math.min(5, Math.max(1, parseInt(copies ? copies.value : '1', 10) || 1)),
        engine: engine ? engine.value : 'auto',
    };
}

function handleMappingChange(event) {
    const printerId = event.target.dataset.printerId;
    const values = rowValues(printerId);
    if (!values) {
        return;
    }
    const row = event.target.closest('tr');
    printerMappings = printerMappings.filter((m) => String(m.remotePrinterId) !== String(printerId));
    if (values.localPrinterName) {
        printerMappings.push(values);
    }
    if (row) {
        row.classList.toggle('unmapped', !values.localPrinterName);
        const testBtn = row.querySelector('.test-print-btn');
        if (testBtn) testBtn.disabled = !values.localPrinterName;
    }
    if (event.target.dataset.field === 'copies') {
        event.target.value = values.copies;
    }
    mappingsDirty = true;
    updateMappingButtons();
}

function updateMappingButtons() {
    if (saveMappingsBtn) {
        saveMappingsBtn.disabled = !mappingsDirty && printerMappings.length === 0;
    }
    if (startStopBtn && (!serviceStatus || serviceStatus.service.state === 'stopped')) {
        startStopBtn.disabled = printerMappings.length === 0;
    }
}

async function saveMappings({ quiet = false } = {}) {
    const result = await invoke('save-printer-mappings', printerMappings);
    if (result && result.success) {
        printerMappings = result.printerMappings || printerMappings;
        mappingsDirty = false;
        if (!quiet) showToast('Printer mappings saved', 'success');
        updateMappingButtons();
        return true;
    }
    showToast((result && result.message) || 'Could not save mappings', 'error');
    return false;
}

async function testPrint(button) {
    const values = rowValues(button.dataset.printerId);
    if (!values || !values.localPrinterName) {
        showToast('Choose a local printer first', 'error');
        return;
    }
    setButton(button, { disabled: true, icon: 'hourglass_empty', label: 'Printing...' });
    setText(statusText, `Printing a test ticket on ${values.localPrinterName}...`);
    try {
        const result = await invoke('test-print', {
            localPrinterName: values.localPrinterName,
            remotePrinterName: values.remotePrinterName,
            widthMm: widthFromFormat(values.printFormat),
            copies: values.copies,
            engine: values.engine,
        });
        showToast((result && result.message) || 'Test print finished', result && result.success ? 'success' : 'error');
        setText(statusText, (result && result.message) || 'Test print finished');
    } finally {
        setButton(button, { disabled: false, icon: 'print', label: 'Test print' });
    }
}

// ---------------------------------------------------------------------------
// Start / stop

async function startPrinting() {
    if (printerMappings.length === 0) {
        showToast('Please map at least one printer', 'error');
        return;
    }
    setButton(startStopBtn, { disabled: true, icon: 'hourglass_empty', label: 'Starting...' });
    setText(statusText, 'Starting printing service...');
    try {
        if (mappingsDirty && !(await saveMappings({ quiet: true }))) {
            return;
        }
        const result = await invoke('start-printing');
        if (result && result.success) {
            showToast('Printing service started', 'success');
            setText(statusText, 'Printing service active');
        } else {
            showToast((result && result.message) || 'Failed to start printing', 'error');
            setText(statusText, 'Failed to start');
        }
    } finally {
        const status = await invoke('get-status');
        if (status && status.service) renderServiceStatus(status);
    }
}

async function stopPrinting() {
    setButton(startStopBtn, { disabled: true, icon: 'hourglass_empty', label: 'Stopping...' });
    try {
        const result = await invoke('stop-printing');
        if (result && result.success) {
            showToast('Printing service stopped', 'success');
            setText(statusText, 'Service stopped');
        }
    } finally {
        const status = await invoke('get-status');
        if (status && status.service) renderServiceStatus(status);
    }
}

// ---------------------------------------------------------------------------
// Recent prints

function renderRecentPrints() {
    if (!recentPrintsContainer) {
        return;
    }
    const entries = jobLog.slice(0, RECENT_PRINTS_SHOWN);
    setText($('recent-count'), jobLog.length ? `${jobLog.length} in this session` : '');
    if (entries.length === 0) {
        recentPrintsContainer.innerHTML = '<p class="text-muted">No tickets printed yet</p>';
        return;
    }
    recentPrintsContainer.innerHTML = `
        <table class="recent-table">
            <thead>
                <tr><th>Time</th><th>Job</th><th>Printer</th><th>Engine</th><th>Took</th><th>Result</th></tr>
            </thead>
            <tbody>
                ${entries.map((e) => `
                    <tr>
                        <td class="mono">${esc(formatTime(e.at))}</td>
                        <td>${e.id === 'test' ? 'Test ticket' : `#${esc(e.id)}`}</td>
                        <td>${esc(e.printer || '-')}</td>
                        <td>${e.engine ? `<span class="pill pill-engine">${esc(e.engine)}</span>` : '-'}${e.fallback ? ` <span class="muted-note">(fallback: ${esc(e.reason || e.fallback)})</span>` : ''}</td>
                        <td class="mono">${e.ms != null ? `${esc(e.ms)} ms` : '-'}</td>
                        <td><span class="pill ${e.status === 'done' ? 'pill-done' : 'pill-failed'}">${e.status === 'done' ? 'Printed' : 'Failed'}</span>${e.error ? `<div class="err">${esc(e.error)}</div>` : ''}</td>
                    </tr>`).join('')}
            </tbody>
        </table>`;
}

// ---------------------------------------------------------------------------
// Updates

async function checkForUpdates() {
    setButton(checkUpdatesBtn, { disabled: true, icon: 'hourglass_empty', label: 'Checking...' });
    try {
        const result = await invoke('check-for-updates');
        if (result && result.success) {
            showToast(result.message, result.updateAvailable ? 'info' : 'success');
        } else {
            showToast((result && result.message) || 'Could not check for updates', 'error');
        }
    } finally {
        setButton(checkUpdatesBtn, { disabled: false, icon: 'system_update', label: 'Check Updates' });
    }
}

async function installUpdate() {
    const result = await invoke('install-update');
    if (result && !result.success) {
        showToast(result.message || 'No update to install', 'error');
    } else {
        showToast('Installing update, the app will restart...', 'info');
    }
}

// ---------------------------------------------------------------------------
// Events

if (testConnectionBtn) testConnectionBtn.addEventListener('click', () => testConnection());
if (refreshPrintersBtn) refreshPrintersBtn.addEventListener('click', () => refreshPrinters());
if (saveMappingsBtn) saveMappingsBtn.addEventListener('click', () => saveMappings());
if (openLogBtn) {
    openLogBtn.addEventListener('click', async () => {
        const result = await invoke('open-log-file');
        if (result && !result.success) {
            showToast(`Could not open the log: ${result.message || ''} (${result.path || ''})`, 'error');
        }
    });
}
if (startStopBtn) {
    startStopBtn.addEventListener('click', () => {
        const running = serviceStatus && serviceStatus.service && serviceStatus.service.state !== 'stopped';
        if (running) {
            stopPrinting();
        } else {
            startPrinting();
        }
    });
}
if (autostartToggle) {
    autostartToggle.addEventListener('click', async () => {
        const next = !config.autoStart;
        const result = await invoke('save-config', { autoStart: next });
        if (result && result.success) {
            config.autoStart = next;
            updateAutostartButton(next);
            showToast(`Autostart ${next ? 'enabled' : 'disabled'}`, 'success');
        } else {
            showToast((result && result.message) || 'Could not change autostart', 'error');
        }
    });
}
if (checkUpdatesBtn) checkUpdatesBtn.addEventListener('click', () => checkForUpdates());
if (installUpdateBtn) installUpdateBtn.addEventListener('click', () => installUpdate());

ipcRenderer.on('service-status', (event, status) => {
    if (status && status.service) {
        renderServiceStatus(status);
    }
});

ipcRenderer.on('update-status', (event, update) => {
    if (update) {
        renderUpdateStatus(update);
        if (update.status === 'downloaded') {
            showToast(update.message, 'success');
        } else if (update.status === 'error') {
            showToast('Update error: ' + update.message, 'error');
        }
    }
});

ipcRenderer.on('print-status', (event, status) => {
    if (!status) {
        return;
    }
    setText(statusText, status.message || 'Processing...');
    if (status.type === 'job' && status.job) {
        jobLog = [status.job, ...jobLog].slice(0, 100);
        renderRecentPrints();
        showToast(status.message, status.job.status === 'done' ? 'success' : 'error');
    } else if (status.type === 'error') {
        showToast(status.message, 'error');
    } else if (status.type === 'connection') {
        showToast(status.message, status.ok ? 'success' : 'error');
    }
});

init();
