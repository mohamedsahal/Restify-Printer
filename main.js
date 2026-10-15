const { app, BrowserWindow, ipcMain, Tray, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');
const PrinterService = require('./services/PrinterService');
const ApiService = require('./services/ApiService');
const Logger = require('./services/Logger');

// One running copy: the second one just brings the window of the first to the front.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

const store = new Store();
const logger = new Logger(path.join(app.getPath('userData'), 'logs'));
const jobLog = new ApiService.JobLog();

// Global references
let mainWindow = null;
let tray = null;
let printerService = null;
let apiService = null;

/** Wait 10 s, 30 s, then a minute between attempts while the server cannot be reached. */
const RETRY_DELAYS_MS = [10000, 30000, 60000];
const UPDATE_FIRST_CHECK_MS = 10 * 1000;
const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** Install a downloaded update only after this long without a finished print. */
const UPDATE_QUIET_MS = 60 * 1000;
const UPDATE_QUIET_RECHECK_MS = 30 * 1000;

const service = {
  state: 'stopped', // stopped | starting | running | retrying
  since: null,
  connection: { ok: null, message: '', at: null },
  pusher: false,
  serverVersion: null,
  supportsHtml: null,
  lastError: null,
  attempt: 0,
  nextRetryAt: null,
};
let retryTimer = null;
let startInProgress = null;

const update = {
  status: 'idle', // idle | checking | available | downloading | downloaded | not-available | error
  version: null,
  percent: null,
  message: '',
  checkedAt: null,
};
let lastJobFinishedAt = 0;
let quietInstallTimer = null;
let updateTimers = [];

// ---------------------------------------------------------------------------
// Auto-updater: public GitHub releases, downloaded in the background.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;
// info/warn/error only: the updater's debug lines would drown the printer log.
autoUpdater.logger = {
  info: (m) => logger.info(`updater: ${m}`),
  warn: (m) => logger.warn(`updater: ${m}`),
  error: (m) => logger.error(`updater: ${m}`),
};

// The repo is public; a token is only needed to raise the API rate limit while developing.
if (process.env.GH_TOKEN) {
  autoUpdater.requestHeaders = {
    Authorization: `token ${process.env.GH_TOKEN}`,
  };
}

// For development, allow any certificate
if (process.env.NODE_ENV === 'development') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

// Launch at login, hidden in the tray. Windows/Linux: registry/.desktop entry with --hidden.
const autoLauncher = new AutoLaunch({
  name: 'Restify Printer',
  path: app.getPath('exe'),
  isHidden: true,
});

// A log line instead of a crash: the printer must survive a bad ticket or a flaky network.
process.on('uncaughtException', (error) => {
  logger.error(`Uncaught exception: ${error && error.stack ? error.stack : error}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

// ---------------------------------------------------------------------------
// Helpers

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getConfig() {
  return {
    domainUrl: store.get('domainUrl', ''),
    apiKey: store.get('apiKey', ''),
    autoStart: store.get('autoStart', false),
    checkUpdates: store.get('checkUpdates', true),
    printingEnabled: store.get('printingEnabled', true),
    printerMappings: store.get('printerMappings', []),
  };
}

function isConfigured() {
  const config = getConfig();
  return Boolean(config.domainUrl && config.apiKey && config.printerMappings.length > 0);
}

function getStatus() {
  return {
    service: {
      ...service,
      running: service.state === 'running',
      busy: Boolean(apiService && apiService.isBusy()),
    },
    update: { ...update },
    version: app.getVersion(),
    autoStart: store.get('autoStart', false),
    printingEnabled: store.get('printingEnabled', true),
    logFile: logger.path,
    configured: isConfigured(),
  };
}

function statusLine() {
  switch (service.state) {
    case 'running':
      return `Printing (since ${new Date(service.since).toLocaleTimeString()})`;
    case 'starting':
      return 'Starting...';
    case 'retrying':
      return `Server unreachable, retrying (${service.lastError || 'no details'})`;
    default:
      return isConfigured() ? 'Printing stopped' : 'Not set up yet';
  }
}

function publishStatus() {
  send('service-status', getStatus());
  refreshTray();
}

function getPrinterService() {
  if (!printerService) {
    printerService = new PrinterService();
  }
  return printerService;
}

function getApiService() {
  const { domainUrl, apiKey } = getConfig();
  if (!apiService) {
    apiService = new ApiService(domainUrl, apiKey, { appVersion: app.getVersion(), jobLog, logger });
  } else if (apiService.domainUrl !== String(domainUrl || '').replace(/\/+$/, '') || apiService.apiKey !== apiKey) {
    apiService.updateConfig(domainUrl, apiKey);
  }
  return apiService;
}

// ---------------------------------------------------------------------------
// Launch at login

async function setLaunchAtLogin(enabled) {
  store.set('autoStart', Boolean(enabled));
  // An explicit choice is never overridden by the one-time default below.
  store.set('autoStartConfigured', true);
  try {
    if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: true });
    } else if (enabled) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
    logger.info(`Launch at login ${enabled ? 'enabled' : 'disabled'}`);
    return { success: true };
  } catch (error) {
    logger.error(`Launch at login change failed: ${error.message}`);
    return { success: false, message: error.message };
  }
}

/** On by default once the app is set up, so a reboot never needs a person at the keyboard. */
async function enableLaunchAtLoginOnce() {
  if (store.get('autoStartConfigured', false) || !app.isPackaged) {
    return;
  }
  store.set('autoStartConfigured', true);
  await setLaunchAtLogin(true);
}

function launchedHidden() {
  if (process.argv.includes('--hidden')) {
    return true;
  }
  if (process.platform === 'darwin') {
    try {
      const settings = app.getLoginItemSettings();
      return Boolean(settings.wasOpenedAtLogin || settings.wasOpenedAsHidden);
    } catch {
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Printing service (runs in the main process: no window needed)

function onPrintStatus(status) {
  if (status.type === 'job') {
    lastJobFinishedAt = Date.now();
  } else if (status.type === 'connection') {
    service.connection = { ok: status.ok, message: status.message, at: new Date().toISOString() };
    if (status.ok) {
      service.pusher = Boolean(status.pusherConnected);
      service.serverVersion = status.serverVersion || service.serverVersion;
    }
    publishStatus();
  }
  send('print-status', status);
}

function clearRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  service.nextRetryAt = null;
}

function scheduleRetry(message) {
  clearRetry();
  const delay = RETRY_DELAYS_MS[Math.min(service.attempt, RETRY_DELAYS_MS.length - 1)];
  service.attempt += 1;
  service.state = 'retrying';
  service.lastError = message;
  service.nextRetryAt = new Date(Date.now() + delay).toISOString();
  logger.warn(`Start failed (${message}); retrying in ${delay / 1000} s`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void startPrinting({ retry: true });
  }, delay);
  publishStatus();
}

/**
 * Test the connection, then poll. `manual` is a click in the window: it remembers the choice
 * so the next launch starts by itself; a retry keeps the previous choice.
 */
async function startPrinting({ manual = false, retry = false } = {}) {
  if (startInProgress) {
    return startInProgress;
  }
  startInProgress = (async () => {
    const config = getConfig();
    if (!config.domainUrl || !config.apiKey) {
      return { success: false, message: 'Please configure Domain URL and API Key' };
    }
    if (config.printerMappings.length === 0) {
      return { success: false, message: 'Please map at least one printer' };
    }

    if (manual) {
      store.set('printingEnabled', true);
      service.attempt = 0;
    }
    if (!retry) {
      clearRetry();
    }

    service.state = 'starting';
    publishStatus();

    const api = getApiService();
    const result = await api.testConnection();
    service.connection = { ok: result.success, message: result.message, at: new Date().toISOString() };

    if (!result.success) {
      logger.warn(`Connection test failed: ${result.message}`);
      scheduleRetry(result.message);
      return { success: false, message: result.message };
    }

    service.pusher = Boolean(result.pusherConnected);
    service.serverVersion = result.serverVersion || null;
    service.supportsHtml = result.supportsHtml;
    service.attempt = 0;
    service.lastError = null;

    api.startPolling(getPrinterService(), config.printerMappings, onPrintStatus);
    service.state = 'running';
    service.since = new Date().toISOString();
    logger.info(`Printing service started (server ${result.serverVersion || '?'}, pusher ${service.pusher ? 'on' : 'off'}, ${config.printerMappings.length} printer(s))`);
    publishStatus();
    return { success: true, message: 'Printing service started' };
  })().finally(() => {
    startInProgress = null;
  });
  return startInProgress;
}

function stopPrinting({ manual = false } = {}) {
  clearRetry();
  if (apiService) {
    apiService.stopPolling();
  }
  if (manual) {
    store.set('printingEnabled', false);
  }
  if (service.state !== 'stopped') {
    logger.info(`Printing service stopped${manual ? ' by the user' : ''}`);
  }
  service.state = 'stopped';
  service.since = null;
  service.pusher = false;
  service.attempt = 0;
  publishStatus();
  return { success: true, message: 'Printing service stopped' };
}

/** Settings changed while running: pick them up without a click. */
async function restartIfRunning() {
  if (service.state === 'stopped') {
    return;
  }
  stopPrinting();
  await startPrinting();
}

// ---------------------------------------------------------------------------
// Test ticket (lets the restaurant check a mapping without placing an order)

function buildTestTicketHtml({ printerName, widthMm }) {
  const now = new Date();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @page { size: ${widthMm}mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { width: ${widthMm}mm; font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #000; }
  .ticket { padding: 4mm 3mm; }
  h1 { font-size: 16px; text-align: center; margin: 0 0 6px; }
  p { margin: 2px 0; }
  .rule { border-top: 1px dashed #000; margin: 6px 0; }
  .center { text-align: center; }
</style></head>
<body><div class="ticket">
  <h1>Restify test ticket</h1>
  <p class="center">${esc(now.toLocaleDateString())} ${esc(now.toLocaleTimeString())}</p>
  <div class="rule"></div>
  <p>Printer: ${esc(printerName)}</p>
  <p>Paper width: ${esc(widthMm)} mm</p>
  <p>App version: ${esc(app.getVersion())}</p>
  <div class="rule"></div>
  <p class="center">If you can read this, the mapping works.</p>
</div></body></html>`;
}

async function testPrint({ localPrinterName, widthMm, copies, engine, remotePrinterName } = {}) {
  if (!localPrinterName) {
    return { success: false, message: 'Choose a local printer first' };
  }
  const width = parseInt(widthMm, 10) || 80;
  const startedAt = Date.now();
  let result;
  try {
    result = await getPrinterService().printJob({
      html: buildTestTicketHtml({ printerName: localPrinterName, widthMm: width }),
      printerName: localPrinterName,
      widthMm: width,
      copies: Math.max(1, parseInt(copies, 10) || 1),
      engine: engine || 'auto',
    });
  } catch (error) {
    result = { success: false, error: error.message };
  }
  const record = jobLog.add({
    id: 'test',
    printer: localPrinterName,
    remotePrinter: remotePrinterName || null,
    engine: result.engine || null,
    ms: Date.now() - startedAt,
    status: result.success ? 'done' : 'failed',
    error: result.success ? null : (result.error || 'Print failed'),
  });
  lastJobFinishedAt = Date.now();
  const message = result.success
    ? `Test ticket printed on ${localPrinterName} (${record.engine || 'n/a'}, ${record.ms} ms)`
    : `Test print failed: ${record.error}`;
  logger[result.success ? 'info' : 'error'](message);
  send('print-status', { type: 'job', job: record, message });
  return { success: Boolean(result.success), message, job: record };
}

// ---------------------------------------------------------------------------
// Updates

function setUpdate(status, patch = {}) {
  Object.assign(update, { status }, patch);
  send('update-status', { ...update });
  refreshTray();
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    return { success: false, message: 'Updates are only checked in the installed app' };
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result && result.updateInfo ? result.updateInfo.version : null;
    const current = app.getVersion();
    update.checkedAt = new Date().toISOString();
    if (latest && latest !== current) {
      return { success: true, updateAvailable: true, currentVersion: current, latestVersion: latest, message: `Update v${latest} is downloading` };
    }
    return { success: true, updateAvailable: false, currentVersion: current, message: 'You are running the latest version' };
  } catch (error) {
    logger.error(`Update check failed: ${error.message}`);
    return { success: false, message: error.message || 'Failed to check for updates' };
  }
}

function installUpdateNow() {
  logger.info(`Installing update v${update.version || '?'}`);
  stopPrinting();
  app.isQuitting = true;
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

/** Install when no ticket has printed for a minute; otherwise look again in 30 s. */
function scheduleQuietInstall() {
  if (quietInstallTimer) {
    clearTimeout(quietInstallTimer);
  }
  const quietFor = Date.now() - lastJobFinishedAt;
  const busy = apiService && apiService.isBusy();
  if (!busy && quietFor >= UPDATE_QUIET_MS) {
    quietInstallTimer = null;
    installUpdateNow();
    return;
  }
  quietInstallTimer = setTimeout(scheduleQuietInstall, UPDATE_QUIET_RECHECK_MS);
}

autoUpdater.on('checking-for-update', () => {
  setUpdate('checking', { message: 'Checking for updates...' });
});

autoUpdater.on('update-available', (info) => {
  logger.info(`Update available: v${info.version}`);
  setUpdate('available', { version: info.version, percent: 0, message: `Update v${info.version} found, downloading...` });
});

autoUpdater.on('update-not-available', () => {
  setUpdate('not-available', { version: null, percent: null, message: 'You are running the latest version', checkedAt: new Date().toISOString() });
});

autoUpdater.on('download-progress', (progress) => {
  setUpdate('downloading', { percent: progress.percent, message: `Downloading update: ${Math.round(progress.percent)}%` });
});

autoUpdater.on('update-downloaded', (info) => {
  logger.info(`Update downloaded: v${info.version}; installs when printing is idle`);
  setUpdate('downloaded', { version: info.version, percent: 100, message: `Update v${info.version} ready. It installs when no ticket has printed for a minute.` });
  scheduleQuietInstall();
});

autoUpdater.on('error', (error) => {
  logger.error(`Update error: ${error.message || error}`);
  setUpdate('error', { message: error.message || 'Update error' });
});

function startUpdateChecks() {
  if (!app.isPackaged) {
    return;
  }
  const check = () => autoUpdater.checkForUpdates().catch((err) => logger.error(`Auto-update check failed: ${err.message}`));
  updateTimers.push(setTimeout(check, UPDATE_FIRST_CHECK_MS));
  updateTimers.push(setInterval(check, UPDATE_CHECK_EVERY_MS));
}

// ---------------------------------------------------------------------------
// Window and tray

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show,
    icon: path.join(__dirname, 'assets', 'Restify.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true,
    },
    autoHideMenuBar: true,
    title: 'Restify Printer',
  });

  mainWindow.loadFile('index.html');

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Closing only hides: printing keeps running from the tray.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ show: true });
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function trayMenuTemplate() {
  const running = service.state !== 'stopped';
  const items = [
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    { label: 'Open', click: showWindow },
    {
      label: running ? 'Stop printing' : 'Start printing',
      enabled: running || isConfigured(),
      click: () => (running ? stopPrinting({ manual: true }) : void startPrinting({ manual: true })),
    },
  ];
  if (update.status === 'downloaded') {
    items.push({ label: `Install update v${update.version || ''}`.trim(), click: installUpdateNow });
  } else {
    items.push({ label: 'Check for updates', click: () => void checkForUpdates() });
  }
  items.push({ type: 'separator' });
  items.push({
    label: 'Quit',
    click: () => {
      app.isQuitting = true;
      app.quit();
    },
  });
  return items;
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) {
    return;
  }
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
  tray.setToolTip(`Restify Printer v${app.getVersion()} — ${statusLine()}`);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'Restify.png');
  tray = new Tray(iconPath);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  refreshTray();
}

// ---------------------------------------------------------------------------
// IPC

ipcMain.handle('get-config', async () => getConfig());

ipcMain.handle('save-config', async (event, config = {}) => {
  const before = getConfig();
  if (config.domainUrl !== undefined) {
    store.set('domainUrl', String(config.domainUrl || '').trim());
  }
  if (config.apiKey !== undefined) {
    store.set('apiKey', String(config.apiKey || '').trim());
  }
  if (config.checkUpdates !== undefined) {
    store.set('checkUpdates', Boolean(config.checkUpdates));
  }
  if (config.autoStart !== undefined && Boolean(config.autoStart) !== before.autoStart) {
    const result = await setLaunchAtLogin(config.autoStart);
    if (!result.success) {
      return result;
    }
  }
  const after = getConfig();
  if (after.domainUrl && after.apiKey) {
    await enableLaunchAtLoginOnce();
  }
  if (after.domainUrl !== before.domainUrl || after.apiKey !== before.apiKey) {
    await restartIfRunning();
  }
  publishStatus();
  return { success: true, config: getConfig() };
});

ipcMain.handle('test-connection', async () => {
  try {
    const { domainUrl, apiKey } = getConfig();
    if (!domainUrl || !apiKey) {
      return { success: false, message: 'Please configure Domain URL and API Key' };
    }
    const result = await getApiService().testConnection();
    service.connection = { ok: result.success, message: result.message, at: new Date().toISOString() };
    if (result.success) {
      service.serverVersion = result.serverVersion || null;
      service.supportsHtml = result.supportsHtml;
      if (service.state === 'running') {
        service.pusher = Boolean(result.pusherConnected);
      }
    }
    logger.info(`Connection test: ${result.success ? 'ok' : 'failed'} (${result.message})`);
    publishStatus();
    return result;
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-system-printers', async () => {
  try {
    const printers = await getPrinterService().getSystemPrinters();
    return { success: true, printers };
  } catch (error) {
    logger.error(`Listing printers failed: ${error.message}`);
    return { success: false, message: error.message, printers: [] };
  }
});

ipcMain.handle('refresh-printers', async () => {
  try {
    const { domainUrl, apiKey } = getConfig();
    if (!domainUrl || !apiKey) {
      return { success: false, message: 'Please configure Domain URL and API Key' };
    }
    return await getApiService().getPrinters();
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('save-printer-mappings', async (event, mappings) => {
  const clean = (Array.isArray(mappings) ? mappings : [])
    .filter((m) => m && m.remotePrinterId != null && m.localPrinterName)
    .map((m) => ({
      remotePrinterId: m.remotePrinterId,
      remotePrinterName: m.remotePrinterName || '',
      localPrinterName: m.localPrinterName,
      printFormat: m.printFormat || 'thermal80mm',
      printType: m.printType || 'image',
      copies: Math.min(5, Math.max(1, parseInt(m.copies, 10) || 1)),
      engine: ['auto', 'image'].includes(m.engine) ? m.engine : 'auto',
    }));
  store.set('printerMappings', clean);
  logger.info(`Saved ${clean.length} printer mapping(s)`);
  const { domainUrl, apiKey } = getConfig();
  if (domainUrl && apiKey && clean.length > 0) {
    await enableLaunchAtLoginOnce();
  }
  await restartIfRunning();
  publishStatus();
  return { success: true, printerMappings: clean };
});

ipcMain.handle('start-printing', async () => {
  try {
    return await startPrinting({ manual: true });
  } catch (error) {
    logger.error(`Start failed: ${error.message}`);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('stop-printing', async () => stopPrinting({ manual: true }));

ipcMain.handle('get-status', async () => getStatus());

ipcMain.handle('get-job-log', async () => jobLog.all());

ipcMain.handle('test-print', async (event, options) => testPrint(options || {}));

ipcMain.handle('get-app-version', async () => app.getVersion());

ipcMain.handle('check-for-updates', async () => checkForUpdates());

ipcMain.handle('install-update', async () => {
  if (update.status !== 'downloaded') {
    return { success: false, message: 'No update has been downloaded yet' };
  }
  installUpdateNow();
  return { success: true };
});

ipcMain.handle('open-log-file', async () => {
  try {
    if (!fs.existsSync(logger.path)) {
      logger.info('Log file created');
    }
    const error = await shell.openPath(logger.path);
    return error ? { success: false, message: error, path: logger.path } : { success: true, path: logger.path };
  } catch (error) {
    return { success: false, message: error.message, path: logger.path };
  }
});

// ---------------------------------------------------------------------------
// App lifecycle

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) {
    return;
  }
  logger.info(`Restify Printer v${app.getVersion()} starting (${process.platform}, argv ${process.argv.slice(1).join(' ') || '-'})`);
  const hidden = launchedHidden();
  createWindow({ show: !hidden });
  createTray();

  if (isConfigured()) {
    // Installs upgraded from 1.0.x were set up before launch at login became the default.
    await enableLaunchAtLoginOnce();
  }

  if (isConfigured() && store.get('printingEnabled', true)) {
    void startPrinting();
  } else {
    publishStatus();
  }

  startUpdateChecks();

  app.on('activate', () => {
    showWindow();
  });
});

// A tray app: closing (hiding) the last window must not quit, printing keeps running.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  for (const timer of updateTimers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  if (quietInstallTimer) {
    clearTimeout(quietInstallTimer);
  }
  clearRetry();
  if (apiService) {
    apiService.stopPolling();
  }
  if (printerService) {
    printerService.shutdown();
  }
  logger.info('Restify Printer quitting');
});
