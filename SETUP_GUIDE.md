# Restify Desktop Printer - Setup Guide

## Quick Start (5 Minutes)

### Step 1: Install Dependencies

Open terminal/command prompt in the `desktop-printer-app` folder:

```bash
npm install
```

This will install all required packages (~2-3 minutes).

### Step 2: Run the Application

```bash
npm start
```

The application window will open.

### Step 3: Configure Connection

1. **Domain URL**: Enter your Restify URL
   - Example: `https://restaurant.restify.com`
   - Or: `http://localhost:8000` (for local development)

2. **API Key**: Get this from your Restify dashboard
   - Login to Restify
   - Go to Settings → Printer Settings
   - Copy the "Branch Key" or "API Key"
   - Paste it in the app

3. Click **"Test Connection"**
   - Should show "Connected" in green

### Step 4: Map Printers

1. Click **"Refresh Printers"**
   - This loads your configured printers from TableTrack

2. For each printer, select a local printer from the dropdown
   - Example: "Kitchen 1" → "EPSON TM-T88V"
   - Example: "Bar" → "Star TSP143"

3. Click **"Save & Start Printing"**

### Step 5: Test Print

1. Create a test order in Restify
2. Watch the app status bar
3. The receipt should print automatically!

---

## Detailed Setup

### For Windows Users

#### Installing Node.js

1. Download from: https://nodejs.org/
2. Run the installer
3. Check "Add to PATH" during installation
4. Verify: Open CMD and type `node --version`

#### Printer Setup

1. Install your thermal printer drivers
2. Go to Control Panel → Devices and Printers
3. Right-click your printer → "Set as default" (optional)
4. Ensure status shows "Ready"

#### Running the App

```cmd
cd C:\path\to\desktop-printer-app
npm install
npm start
```

### For macOS Users

#### Installing Node.js

```bash
# Using Homebrew
brew install node

# Or download from: https://nodejs.org/
```

#### Printer Setup

1. System Preferences → Printers & Scanners
2. Click "+" to add your thermal printer
3. Select the correct driver

#### Running the App

```bash
cd /path/to/desktop-printer-app
npm install
npm start
```

### For Linux Users

#### Installing Node.js

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nodejs npm

# Fedora
sudo dnf install nodejs npm
```

#### Printer Setup

```bash
# Install CUPS
sudo apt install cups

# Add printer
sudo lpadmin -p PrinterName -E -v usb://...

# Check status
lpstat -p
```

#### Running the App

```bash
cd /path/to/desktop-printer-app
npm install
npm start
```

---

## Building Executable

### Create Windows .exe

```bash
npm run build:win
```

Output: `dist/TableTrack Printer Setup.exe`

### Create macOS .dmg

```bash
npm run build:mac
```

Output: `dist/TableTrack Printer.dmg`

### Create Linux AppImage

```bash
npm run build:linux
```

Output: `dist/TableTrack Printer.AppImage`

---

## Common Issues

### "npm: command not found"

**Solution**: Install Node.js first
- Windows: https://nodejs.org/
- macOS: `brew install node`
- Linux: `sudo apt install nodejs npm`

### "Printers not detected"

**Windows:**
```cmd
# Run as Administrator
# Check printers
wmic printer get name
```

**macOS/Linux:**
```bash
# Check CUPS
lpstat -p

# Restart CUPS
sudo systemctl restart cups
```

### "Connection failed"

1. Check Domain URL format:
   - ✅ `https://restaurant.com`
   - ❌ `restaurant.com` (missing https://)

2. Verify API Key:
   - Copy exactly from Restify
   - No extra spaces

3. Test in browser:
   - Open: `https://your-domain.com/api/test-connection`
   - Should see JSON response

### "Print jobs not processing"

1. Check connection status (top right)
2. Verify printer mappings are saved
3. Ensure "Save & Start Printing" was clicked
4. Check status bar for errors

---

## Auto-Start Setup

### Windows

1. Press `Win + R`
2. Type: `shell:startup`
3. Create shortcut to the .exe file
4. Or use the "Enable Autostart" button in the app

### macOS

1. System Preferences → Users & Groups
2. Login Items tab
3. Click "+" and add the app
4. Or use the "Enable Autostart" button in the app

### Linux

1. Create desktop entry:
```bash
nano ~/.config/autostart/restify-printer.desktop
```

2. Add:
```ini
[Desktop Entry]
Type=Application
Name=Restify Printer
Exec=/path/to/Restify Printer.AppImage
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
```

---

## Network Configuration

### Firewall Rules

Allow outbound connections to:
- Your TableTrack domain (port 443)
- Pusher servers (port 443)

### Proxy Setup

If behind a corporate proxy, set environment variables:

```bash
# Windows CMD
set HTTP_PROXY=http://proxy:port
set HTTPS_PROXY=http://proxy:port

# macOS/Linux
export HTTP_PROXY=http://proxy:port
export HTTPS_PROXY=http://proxy:port
```

---

## Advanced Configuration

### Custom Polling Interval

Edit `services/ApiService.js`:

```javascript
// Change from 5000 (5 seconds) to your preferred interval
this.pollingInterval = setInterval(async () => {
    // ...
}, 5000); // ← Change this value
```

### Custom Printer Commands

Edit `services/PrinterService.js` to add custom ESC/POS commands.

### Debug Mode

Run with DevTools open:

```bash
npm run dev
```

Or add `--dev` flag:

```bash
electron . --dev
```

---

## Getting Help

### Check Logs

**Windows:**
```
%APPDATA%\restify-printer\logs\
```

**macOS:**
```
~/Library/Logs/restify-printer/
```

**Linux:**
```
~/.config/restify-printer/logs/
```

### Support Channels

- Email: support@restify.com
- Documentation: https://docs.restify.com
- Community: https://community.restify.com

---

## Next Steps

1. ✅ Test with a real order
2. ✅ Configure cash drawer (if applicable)
3. ✅ Enable auto-start
4. ✅ Map all your printers
5. ✅ Train your staff

**You're all set! Happy printing! 🎉**
