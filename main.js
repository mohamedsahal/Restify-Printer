const { app, BrowserWindow, ipcMain, Tray, Menu, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const AutoLaunch = require('auto-launch');
const { autoUpdater } = require('electron-updater');
const PrinterService = require('./services/PrinterService');
const ApiService = require('./services/ApiService');

// Initialize store
const store = new Store();

// Global references
let mainWindow = null;
let tray = null;
let printerService = null;
let apiService = null;

// Configure auto-updater
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

// Auto-launch configuration
const autoLauncher = new AutoLaunch({
  name: 'Restify Printer',
  path: app.getPath('exe'),
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'assets', 'Restify.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    autoHideMenuBar: true,
    title: 'Restify Printer'
  });

  mainWindow.loadFile('index.html');

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

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

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'Restify.png');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show App',
      click: () => {
        mainWindow.show();
      }
    },
    {
      label: 'Connection Status',
      enabled: false
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Restify Printer');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow.show();
  });
}

// IPC Handlers
ipcMain.handle('get-config', async () => {
  return {
    domainUrl: store.get('domainUrl', ''),
    apiKey: store.get('apiKey', ''),
    autoStart: store.get('autoStart', false),
    checkUpdates: store.get('checkUpdates', true),
    printerMappings: store.get('printerMappings', [])
  };
});

ipcMain.handle('save-config', async (event, config) => {
  store.set('domainUrl', config.domainUrl);
  store.set('apiKey', config.apiKey);
  store.set('autoStart', config.autoStart);
  store.set('checkUpdates', config.checkUpdates);

  // Update auto-launch
  if (config.autoStart) {
    await autoLauncher.enable();
  } else {
    await autoLauncher.disable();
  }

  return { success: true };
});

ipcMain.handle('test-connection', async () => {
  try {
    const domainUrl = store.get('domainUrl');
    const apiKey = store.get('apiKey');

    if (!domainUrl || !apiKey) {
      return { success: false, message: 'Please configure Domain URL and API Key' };
    }

    if (!apiService) {
      apiService = new ApiService(domainUrl, apiKey);
    } else {
      apiService.updateConfig(domainUrl, apiKey);
    }

    const result = await apiService.testConnection();
    return result;
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-system-printers', async () => {
  try {
    if (!printerService) {
      printerService = new PrinterService();
    }
    const printers = await printerService.getSystemPrinters();
    return { success: true, printers };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('refresh-printers', async () => {
  try {
    const domainUrl = store.get('domainUrl');
    const apiKey = store.get('apiKey');

    if (!apiService) {
      apiService = new ApiService(domainUrl, apiKey);
    }

    const result = await apiService.getPrinters();
    return result;
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('save-printer-mappings', async (event, mappings) => {
  store.set('printerMappings', mappings);
  return { success: true };
});

ipcMain.handle('start-printing', async () => {
  try {
    const domainUrl = store.get('domainUrl');
    const apiKey = store.get('apiKey');
    const printerMappings = store.get('printerMappings', []);

    if (!printerService) {
      printerService = new PrinterService();
    }

    if (!apiService) {
      apiService = new ApiService(domainUrl, apiKey);
    } else {
      apiService.updateConfig(domainUrl, apiKey);
    }

    // Start polling for print jobs
    apiService.startPolling(printerService, printerMappings, (status) => {
      if (mainWindow) {
        mainWindow.webContents.send('print-status', status);
      }
    });

    return { success: true, message: 'Printing service started' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('stop-printing', async () => {
  if (apiService) {
    apiService.stopPolling();
  }
  return { success: true, message: 'Printing service stopped' };
});

ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

// Auto-updater IPC handlers
ipcMain.handle('check-for-updates', async () => {
  try {
    const checkUpdates = store.get('checkUpdates', true);
    if (!checkUpdates) {
      return { 
        success: false, 
        message: 'Update checking is disabled' 
      };
    }

    const result = await autoUpdater.checkForUpdates();
    
    if (result && result.updateInfo) {
      const currentVersion = app.getVersion();
      const latestVersion = result.updateInfo.version;
      
      if (currentVersion === latestVersion) {
        return {
          success: true,
          updateAvailable: false,
          currentVersion,
          message: 'You are running the latest version'
        };
      } else {
        return {
          success: true,
          updateAvailable: true,
          currentVersion,
          latestVersion,
          releaseNotes: result.updateInfo.releaseNotes,
          message: `Update available: v${latestVersion}`
        };
      }
    }
    
    return {
      success: true,
      updateAvailable: false,
      message: 'No updates available'
    };
  } catch (error) {
    console.error('Update check error:', error);
    return {
      success: false,
      message: error.message || 'Failed to check for updates'
    };
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true, message: 'Update downloaded successfully' };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('install-update', async () => {
  autoUpdater.quitAndInstall(false, true);
  return { success: true };
});

// Auto-updater events
autoUpdater.on('checking-for-update', () => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'checking',
      message: 'Checking for updates...'
    });
  }
});

autoUpdater.on('update-available', (info) => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'available',
      message: `Update available: v${info.version}`,
      version: info.version,
      releaseNotes: info.releaseNotes
    });
  }
});

autoUpdater.on('update-not-available', () => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'not-available',
      message: 'You are running the latest version'
    });
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'downloading',
      message: `Downloading: ${Math.round(progressObj.percent)}%`,
      percent: progressObj.percent
    });
  }
});

autoUpdater.on('update-downloaded', () => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'downloaded',
      message: 'Update downloaded. Restart to install.'
    });
  }
});

autoUpdater.on('error', (error) => {
  if (mainWindow) {
    mainWindow.webContents.send('update-status', {
      status: 'error',
      message: error.message || 'Update error'
    });
  }
});

// App lifecycle
app.whenReady().then(() => {
  createWindow();
  createTray();

  // Check for updates on startup if enabled
  const checkUpdates = store.get('checkUpdates', true);
  if (checkUpdates) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        console.log('Auto-update check failed:', err);
      });
    }, 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (apiService) {
    apiService.stopPolling();
  }
});
