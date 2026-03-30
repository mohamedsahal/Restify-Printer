const { ipcRenderer } = require('electron');

// DOM Elements
const domainUrlInput = document.getElementById('domain-url');
const apiKeyInput = document.getElementById('api-key');
const testConnectionBtn = document.getElementById('test-connection');
const refreshPrintersBtn = document.getElementById('refresh-printers');
const saveStartPrintingBtn = document.getElementById('save-start-printing');
const autostartToggle = document.getElementById('autostart-toggle');
const checkUpdatesToggle = document.getElementById('check-updates-toggle');
const connectionStatus = document.getElementById('connection-status');
const printerMappingsContainer = document.getElementById('printer-mappings');
const autostartStatus = document.getElementById('autostart-status');
const statusText = document.getElementById('status-text');
const appVersionSpan = document.getElementById('app-version');


// State
let config = {};
let systemPrinters = [];
let remotePrinters = [];
let printerMappings = [];
let isConnected = false;
let isPrinting = false;

// Initialize
async function init() {
    config = await ipcRenderer.invoke('get-config');
    const version = await ipcRenderer.invoke('get-app-version');
    
    // Load config
    domainUrlInput.value = config.domainUrl || '';
    apiKeyInput.value = config.apiKey || '';
    appVersionSpan.textContent = version;
    
    // Update toggles
    updateToggleButton(autostartToggle, config.autoStart);
    updateToggleButton(checkUpdatesToggle, config.checkUpdates);
    
    // Load printer mappings
    if (config.printerMappings && config.printerMappings.length > 0) {
        printerMappings = config.printerMappings;
    }
    
    // Auto-test connection if configured
    if (config.domainUrl && config.apiKey) {
        testConnection();
    }
}

// Toast notification
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Update toggle button
function updateToggleButton(button, isActive) {
    const isAutostart = button.id === 'autostart-toggle';
    
    if (isActive) {
        if (isAutostart) {
            // When autostart is ON - show RED with power_off icon
            button.className = 'btn-pill btn-pill-red';
            button.innerHTML = '<i class="material-icons">power_off</i><span>Disable Autostart</span>';
        } else {
            button.className = 'btn-pill btn-pill-blue active';
            button.innerHTML = '<i class="material-icons">system_update</i><span>Check Updates</span>';
        }
    } else {
        if (isAutostart) {
            // When autostart is OFF - show GREEN with power_settings_new icon
            button.className = 'btn-pill btn-pill-green';
            button.innerHTML = '<i class="material-icons">power_settings_new</i><span>Enable Autostart</span>';
        } else {
            button.className = 'btn-pill btn-pill-blue';
            button.innerHTML = '<i class="material-icons">system_update</i><span>Check Updates</span>';
        }
    }
}

// Test connection
async function testConnection() {
    testConnectionBtn.disabled = true;
    testConnectionBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">hourglass_empty</i><span>Testing...</span>';
    statusText.textContent = 'Testing connection...';
    
    try {
        // Save config first
        await ipcRenderer.invoke('save-config', {
            domainUrl: domainUrlInput.value,
            apiKey: apiKeyInput.value,
            autoStart: config.autoStart,
            checkUpdates: config.checkUpdates
        });
        
        const result = await ipcRenderer.invoke('test-connection');
        
        if (result.success) {
            isConnected = true;
            connectionStatus.textContent = 'Connected';
            connectionStatus.className = 'status-badge connected';
            showToast('Connection successful!', 'success');
            statusText.textContent = 'Connected';
            refreshPrintersBtn.disabled = false;
        } else {
            isConnected = false;
            connectionStatus.textContent = 'Disconnected';
            connectionStatus.className = 'status-badge disconnected';
            showToast(result.message || 'Connection failed', 'error');
            statusText.textContent = 'Connection failed';
        }
    } catch (error) {
        isConnected = false;
        showToast('Connection error: ' + error.message, 'error');
        statusText.textContent = 'Error';
    } finally {
        testConnectionBtn.disabled = false;
        testConnectionBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">wifi</i><span>Test Connection</span>';
    }
}

// Refresh printers
async function refreshPrinters() {
    if (!isConnected) {
        showToast('Please test connection first', 'error');
        return;
    }
    
    refreshPrintersBtn.disabled = true;
    refreshPrintersBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">hourglass_empty</i><span>Loading...</span>';
    statusText.textContent = 'Fetching printers...';
    
    try {
        // Get system printers
        const systemResult = await ipcRenderer.invoke('get-system-printers');
        if (systemResult.success) {
            systemPrinters = systemResult.printers;
        }
        
        // Get remote printers
        const remoteResult = await ipcRenderer.invoke('refresh-printers');
        if (remoteResult.success) {
            remotePrinters = remoteResult.printers || [];
            renderPrinterMappings();
            saveStartPrintingBtn.disabled = false;
            showToast('Printers loaded successfully', 'success');
            statusText.textContent = 'Printers loaded';
        } else {
            showToast(remoteResult.message || 'Failed to fetch printers', 'error');
            statusText.textContent = 'Failed to load printers';
        }
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
        statusText.textContent = 'Error';
    } finally {
        refreshPrintersBtn.disabled = false;
        refreshPrintersBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">refresh</i><span>Refresh Printers</span>';
    }
}

// Render printer mappings
function renderPrinterMappings() {
    if (remotePrinters.length === 0) {
        printerMappingsContainer.innerHTML = '<p class="text-muted">No printers found on server</p>';
        return;
    }
    
    printerMappingsContainer.innerHTML = '';
    
    remotePrinters.forEach(printer => {
        const mappingItem = document.createElement('div');
        mappingItem.className = 'printer-mapping-item';
        
        const existingMapping = printerMappings.find(m => m.remotePrinterId === printer.id);
        
        mappingItem.innerHTML = `
            <div class="mapping-header">
                <h4>🖨️ ${printer.name}</h4>
                <span style="font-size: 12px; color: #6c757d;">${printer.print_format || 'thermal80mm'}</span>
            </div>
            <select class="mapping-select" data-printer-id="${printer.id}">
                <option value="">-- Select Local Printer --</option>
                ${systemPrinters.map(sp => `
                    <option value="${sp.name}" ${existingMapping && existingMapping.localPrinterName === sp.name ? 'selected' : ''}>
                        ${sp.name}
                    </option>
                `).join('')}
            </select>
        `;
        
        printerMappingsContainer.appendChild(mappingItem);
    });
    
    // Add event listeners
    document.querySelectorAll('.mapping-select').forEach(select => {
        select.addEventListener('change', handleMappingChange);
    });
}

// Handle mapping change
function handleMappingChange(event) {
    const remotePrinterId = parseInt(event.target.dataset.printerId);
    const localPrinterName = event.target.value;
    
    // Remove existing mapping for this printer
    printerMappings = printerMappings.filter(m => m.remotePrinterId !== remotePrinterId);
    
    // Add new mapping if selected
    if (localPrinterName) {
        const remotePrinter = remotePrinters.find(p => p.id === remotePrinterId);
        printerMappings.push({
            remotePrinterId,
            remotePrinterName: remotePrinter.name,
            localPrinterName,
            printFormat: remotePrinter.print_format || 'thermal80mm',
            printType: remotePrinter.print_type || 'image'
        });
    }
}

// Save and start printing
async function saveAndStartPrinting() {
    if (printerMappings.length === 0) {
        showToast('Please map at least one printer', 'error');
        return;
    }
    
    saveStartPrintingBtn.disabled = true;
    saveStartPrintingBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">hourglass_empty</i><span>Starting...</span>';
    statusText.textContent = 'Starting printing service...';
    
    try {
        // Save mappings
        await ipcRenderer.invoke('save-printer-mappings', printerMappings);
        
        // Start printing service
        const result = await ipcRenderer.invoke('start-printing');
        
        if (result.success) {
            isPrinting = true;
            saveStartPrintingBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">pause</i><span>Stop Printing</span>';
            autostartStatus.className = 'status-message success';
            autostartStatus.textContent = '✓ Autostart Enabled - Printing service is running';
            showToast('Printing service started successfully', 'success');
            statusText.textContent = 'Printing service active';
        } else {
            showToast(result.message || 'Failed to start printing', 'error');
            statusText.textContent = 'Failed to start';
        }
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
        statusText.textContent = 'Error';
    } finally {
        saveStartPrintingBtn.disabled = false;
    }
}

// Stop printing
async function stopPrinting() {
    saveStartPrintingBtn.disabled = true;
    saveStartPrintingBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">hourglass_empty</i><span>Stopping...</span>';
    
    try {
        const result = await ipcRenderer.invoke('stop-printing');
        
        if (result.success) {
            isPrinting = false;
            saveStartPrintingBtn.innerHTML = '<i class="material-icons" style="font-size: 20px;">play_arrow</i><span>Save & Start Printing</span>';
            autostartStatus.className = 'status-message';
            autostartStatus.textContent = '';
            showToast('Printing service stopped', 'success');
            statusText.textContent = 'Service stopped';
        }
    } catch (error) {
        showToast('Error: ' + error.message, 'error');
    } finally {
        saveStartPrintingBtn.disabled = false;
    }
}

// Event Listeners
testConnectionBtn.addEventListener('click', testConnection);
refreshPrintersBtn.addEventListener('click', refreshPrinters);

saveStartPrintingBtn.addEventListener('click', () => {
    if (isPrinting) {
        stopPrinting();
    } else {
        saveAndStartPrinting();
    }
});

autostartToggle.addEventListener('click', async () => {
    config.autoStart = !config.autoStart;
    updateToggleButton(autostartToggle, config.autoStart);
    await ipcRenderer.invoke('save-config', config);
    showToast(`Autostart ${config.autoStart ? 'enabled' : 'disabled'}`, 'success');
});

checkUpdatesToggle.addEventListener('click', async () => {
    config.checkUpdates = !config.checkUpdates;
    updateToggleButton(checkUpdatesToggle, config.checkUpdates);
    await ipcRenderer.invoke('save-config', config);
    showToast(`Update checks ${config.checkUpdates ? 'enabled' : 'disabled'}`, 'success');
    
    // If enabled, check for updates immediately
    if (config.checkUpdates) {
        checkForUpdates();
    }
});

// Check for updates function
async function checkForUpdates() {
    showToast('Checking for updates...', 'info');
    
    try {
        const result = await ipcRenderer.invoke('check-for-updates');
        
        if (result.success) {
            if (result.updateAvailable) {
                const response = confirm(
                    `Update Available!\n\n` +
                    `Current version: v${result.currentVersion}\n` +
                    `Latest version: v${result.latestVersion}\n\n` +
                    `Would you like to download and install the update?`
                );
                
                if (response) {
                    downloadUpdate();
                }
            } else {
                showToast(result.message, 'success');
            }
        } else {
            showToast(result.message, 'error');
        }
    } catch (error) {
        showToast('Failed to check for updates', 'error');
    }
}

// Download update
async function downloadUpdate() {
    showToast('Downloading update...', 'info');
    
    try {
        const result = await ipcRenderer.invoke('download-update');
        
        if (result.success) {
            const response = confirm(
                'Update downloaded successfully!\n\n' +
                'The app will restart to install the update. Continue?'
            );
            
            if (response) {
                await ipcRenderer.invoke('install-update');
            }
        } else {
            showToast('Download failed: ' + result.message, 'error');
        }
    } catch (error) {
        showToast('Download error: ' + error.message, 'error');
    }
}

// Listen for update status
ipcRenderer.on('update-status', (event, status) => {
    console.log('Update status:', status);
    
    if (status.status === 'available') {
        showToast(status.message, 'info');
    } else if (status.status === 'downloading') {
        statusText.textContent = status.message;
    } else if (status.status === 'downloaded') {
        showToast(status.message, 'success');
        
        const response = confirm(
            'Update ready to install!\n\n' +
            'The app will restart to complete the installation. Continue?'
        );
        
        if (response) {
            ipcRenderer.invoke('install-update');
        }
    } else if (status.status === 'error') {
        showToast('Update error: ' + status.message, 'error');
    }
});

// Listen for print status updates
ipcRenderer.on('print-status', (event, status) => {
    statusText.textContent = status.message || 'Processing...';
    
    if (status.type === 'success') {
        showToast(status.message, 'success');
    } else if (status.type === 'error') {
        showToast(status.message, 'error');
    }
});

// Initialize app
init();
