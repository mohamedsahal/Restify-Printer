# Auto-Update Setup Guide

## Overview

The Restify Printer app now has a fully functional auto-update system using `electron-updater`.

---

## How It Works

### 1. Update Checking
- **Automatic**: Checks for updates 3 seconds after app starts (if enabled)
- **Manual**: Click "Check Updates" button to check anytime
- **Toggle**: Enable/disable update checking with the button

### 2. Update Process
1. App checks GitHub releases for new versions
2. If update available, shows notification
3. User confirms to download
4. Update downloads in background with progress
5. User confirms to install
6. App restarts and installs update

### 3. Version Comparison
- Current version: `1.0.0` (from package.json)
- Compares with latest GitHub release
- Only shows update if newer version exists

---

## Setup for GitHub Releases

### Step 1: Create GitHub Repository

```bash
# Create a new repository on GitHub
# Example: https://github.com/your-username/restify-printer
```

### Step 2: Update package.json

Edit `desktop-printer-app/package.json`:

```json
"publish": {
  "provider": "github",
  "owner": "your-github-username",
  "repo": "restify-printer",
  "private": false
}
```

Replace:
- `your-github-username` with your GitHub username
- `restify-printer` with your repository name

### Step 3: Generate GitHub Token

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes: `repo` (all)
4. Copy the token

### Step 4: Set Environment Variable

**Windows:**
```cmd
set GH_TOKEN=your_github_token
```

**macOS/Linux:**
```bash
export GH_TOKEN=your_github_token
```

### Step 5: Build and Publish

```bash
# Build the app
npm run build

# This will:
# 1. Build the executable
# 2. Create installers
# 3. Upload to GitHub releases
```

---

## Alternative: Custom Update Server

If you don't want to use GitHub, you can host updates on your own server.

### Step 1: Update package.json

```json
"publish": {
  "provider": "generic",
  "url": "https://your-domain.com/updates"
}
```

### Step 2: Server Structure

Your server should have this structure:

```
https://your-domain.com/updates/
├── latest.yml              # Update metadata
├── Restify-Printer-1.0.0.exe
├── Restify-Printer-1.0.1.exe
└── ...
```

### Step 3: latest.yml Format

```yaml
version: 1.0.1
files:
  - url: Restify-Printer-1.0.1.exe
    sha512: [file hash]
    size: 123456789
path: Restify-Printer-1.0.1.exe
sha512: [file hash]
releaseDate: '2026-03-30T10:00:00.000Z'
```

---

## Testing Updates

### Local Testing

1. **Build version 1.0.0:**
   ```bash
   npm run build
   ```

2. **Install and run the app**

3. **Update version in package.json to 1.0.1:**
   ```json
   "version": "1.0.1"
   ```

4. **Build again:**
   ```bash
   npm run build
   ```

5. **Create GitHub release with v1.0.1**

6. **Run the 1.0.0 app and click "Check Updates"**

---

## User Experience

### When Update Available

1. User clicks "Check Updates" button
2. Toast notification: "Update available: v1.0.1"
3. Confirmation dialog appears:
   ```
   Update Available!
   
   Current version: v1.0.0
   Latest version: v1.0.1
   
   Would you like to download and install the update?
   ```

4. If user clicks "OK":
   - Download starts
   - Progress shown: "Downloading: 45%"
   - When complete: "Update downloaded. Restart to install."

5. Confirmation dialog:
   ```
   Update ready to install!
   
   The app will restart to complete the installation. Continue?
   ```

6. App restarts and installs update

### When No Update Available

- Toast notification: "You are running the latest version"

---

## Configuration

### Enable/Disable Auto-Check

Users can toggle the "Check Updates" button:
- **Blue (enabled)**: Checks on startup
- **Gray (disabled)**: Manual check only

### Stored in Config

```json
{
  "checkUpdates": true
}
```

---

## Release Process

### 1. Update Version

Edit `package.json`:
```json
"version": "1.0.1"
```

### 2. Update Changelog

Create `CHANGELOG.md`:
```markdown
## v1.0.1 - 2026-03-30

### Added
- New feature X

### Fixed
- Bug fix Y
```

### 3. Build

```bash
npm run build
```

### 4. Create GitHub Release

1. Go to: https://github.com/your-username/restify-printer/releases
2. Click "Create a new release"
3. Tag: `v1.0.1`
4. Title: `Restify Printer v1.0.1`
5. Description: Copy from CHANGELOG.md
6. Upload files from `dist/` folder:
   - `Restify Printer Setup 1.0.1.exe` (Windows)
   - `Restify Printer-1.0.1.dmg` (macOS)
   - `Restify Printer-1.0.1.AppImage` (Linux)
7. Click "Publish release"

### 5. Test

- Install old version
- Click "Check Updates"
- Verify update process works

---

## Troubleshooting

### "Failed to check for updates"

**Cause**: No internet connection or GitHub API rate limit

**Solution**: 
- Check internet connection
- Wait a few minutes (rate limit)
- Verify GitHub repository is public

### "Update not found"

**Cause**: No releases on GitHub

**Solution**: Create a release with version tag (e.g., `v1.0.1`)

### "Download failed"

**Cause**: File not found in release

**Solution**: Ensure release has the correct installer files

---

## Security

### Code Signing (Recommended)

For production, sign your app:

**Windows:**
```bash
set CSC_LINK=path/to/certificate.pfx
set CSC_KEY_PASSWORD=your_password
npm run build:win
```

**macOS:**
```bash
export CSC_LINK=path/to/certificate.p12
export CSC_KEY_PASSWORD=your_password
npm run build:mac
```

### Benefits:
- No "Unknown Publisher" warnings
- Users trust the app
- Required for auto-update on macOS

---

## Best Practices

1. **Semantic Versioning**: Use `MAJOR.MINOR.PATCH` (e.g., 1.0.0)
2. **Test Updates**: Always test before releasing
3. **Changelog**: Document all changes
4. **Backup**: Keep old versions available
5. **Gradual Rollout**: Release to small group first

---

## Summary

✅ **Auto-update is now 100% functional!**

- Checks for updates automatically
- Downloads in background
- Installs with one click
- Works with GitHub releases
- Can use custom server
- User can enable/disable

Just set up your GitHub repository and start releasing updates!
