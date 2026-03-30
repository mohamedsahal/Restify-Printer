# Installation Instructions

## 🚀 Quick Install (3 Steps)

### Step 1: Install Node.js

**Windows:**
1. Download: https://nodejs.org/ (LTS version)
2. Run installer
3. Click "Next" through all steps
4. Verify: Open CMD and type `node --version`

**macOS:**
```bash
# Using Homebrew (recommended)
brew install node

# Or download from: https://nodejs.org/
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt update
sudo apt install nodejs npm
```

### Step 2: Install Dependencies

Open terminal/command prompt in the `desktop-printer-app` folder:

```bash
npm install
```

Wait 2-3 minutes for installation to complete.

### Step 3: Run the App

```bash
npm start
```

The application window will open!

---

## 📦 Building Executable

### For Windows (.exe)

```bash
npm run build:win
```

Output: `dist/Restify Printer Setup.exe`

### For macOS (.dmg)

```bash
npm run build:mac
```

Output: `dist/Restify Printer.dmg`

### For Linux (.AppImage)

```bash
npm run build:linux
```

Output: `dist/Restify Printer.AppImage`

---

## 🔧 First-Time Setup

### 1. Configure Connection

- **Domain URL**: Your Restify URL (e.g., `https://restaurant.com`)
- **API Key**: From Restify Settings → Printer Settings → Branch Key

### 2. Test Connection

Click "Test Connection" - should show "Connected" in green.

### 3. Setup Printers

1. Click "Refresh Printers"
2. Map each printer to a local printer
3. Click "Save & Start Printing"

---

## ❓ Troubleshooting

### "npm: command not found"

Install Node.js first (see Step 1 above).

### "Cannot find module"

Run `npm install` again.

### "Printers not detected"

**Windows:** Check Control Panel → Devices and Printers
**macOS/Linux:** Run `lpstat -p` to check printer status

### "Connection failed"

- Check Domain URL format (must include `https://`)
- Verify API Key is correct
- Test URL in browser: `https://your-domain.com/api/test-connection`

---

## 📖 Full Documentation

See `README.md` and `SETUP_GUIDE.md` for complete documentation.

---

## 🎉 You're Done!

The app is ready to use. Happy printing! 🖨️
