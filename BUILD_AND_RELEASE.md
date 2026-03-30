# Build and Release Guide

## Your GitHub Repository

**Repository**: https://github.com/mohamedsahal/Restify-Printer
**Owner**: mohamedsahal
**Repo**: Restify-Printer
**Type**: Private

---

## 🚀 Quick Release (Automated)

### Windows Release
```powershell
.\create-release.ps1
```

### macOS Release
```powershell
.\create-release-mac.ps1
```

### Quick Build Only
```powershell
# Windows
.\create-release.ps1

# macOS  
.\build-mac.ps1
```

**What the scripts do:**
1. ✅ Updates version in package.json
2. ✅ Updates CHANGELOG.md
3. ✅ Commits and pushes changes
4. ✅ Builds platform-specific installer
5. ✅ Publishes to GitHub
6. ✅ Updates Laravel download URLs automatically

---

## 📋 Manual Release Process

### Step 1: Set GitHub Token (One-time setup)

**Windows PowerShell:**
```powershell
$env:GH_TOKEN="your_github_token_here"
```

**Windows CMD:**
```cmd
set GH_TOKEN=your_github_token_here
```

### Step 2: Update Version

Edit `package.json`:
```json
"version": "1.0.2"
```

### Step 3: Update Changelog

Edit `CHANGELOG.md`:
```markdown
## v1.0.2 - 2026-03-30

### Added
- New feature X

### Fixed
- Bug Y
```

### Step 4: Commit Changes

```bash
git add .
git commit -m "Release v1.0.2"
git push origin main
```

### Step 5: Build Platform-Specific

```bash
# Windows
npm run build:win

# macOS (requires macOS)
npm run build:mac

# All platforms
npm run build
```

### Step 6: Update Laravel URLs

```bash
cd ..
php artisan desktop-app:update-urls 1.0.2
cd desktop-printer-app
```

---

## 🔧 Commands Reference

### Create New Release
```bash
# Windows (automated)
.\create-release.ps1

# macOS (automated)  
.\create-release-mac.ps1

# Manual steps
npm version patch              # 1.0.1 → 1.0.2
npm run build:win             # Build Windows .exe
npm run build:mac             # Build macOS .dmg (requires macOS)
php artisan desktop-app:update-urls 1.0.2  # Update Laravel URLs
```

### Platform-Specific Builds
```bash
npm run build:win    # Windows (.exe)
npm run build:mac    # macOS (.dmg) 
npm run build        # All platforms
```

### Version Types
- `npm version patch` → 1.0.1 → 1.0.2 (bug fixes)
- `npm version minor` → 1.0.1 → 1.1.0 (new features)  
- `npm version major` → 1.0.1 → 2.0.0 (breaking changes)

### Update Download URLs Only
```bash
php artisan desktop-app:update-urls 1.0.2
```

---

## 🍎 macOS Build Requirements

### System Requirements
- **macOS 10.15+** (for building .dmg files)
- **Xcode Command Line Tools**: `xcode-select --install`
- **Node.js 16+**: Download from nodejs.org

### Cross-Platform Building
- **Windows → Windows**: ✅ Native
- **Windows → macOS**: ❌ Requires macOS for .dmg
- **macOS → macOS**: ✅ Native  
- **macOS → Windows**: ✅ Possible with wine

### Building on Windows
You can prepare the release on Windows, but .dmg creation requires macOS:

```powershell
# Prepare release (Windows)
.\create-release-mac.ps1

# Then on macOS, complete the build:
npm run build:mac
gh release upload v1.0.2 dist/*.dmg
```

---

## 🔍 Verification

After creating a release, verify:

1. **GitHub Release**: https://github.com/mohamedsahal/Restify-Printer/releases
2. **Files uploaded**:
   - `Restify-Printer-Setup-1.0.2.exe` (Windows)
   - `Restify-Printer-1.0.2.dmg` (macOS)
   - `latest.yml` (update metadata)
3. **Laravel URLs updated**: Check printer settings page
4. **Download works**: Test download from restaurant dashboard

---

## 🛠️ Troubleshooting

### "401 Unauthorized"
**Solution**: Update GitHub token with proper permissions:
- Contents: Write ✅
- Metadata: Read ✅

### "Build succeeds but no GitHub release"
**Solution**: 
```bash
npx electron-builder --publish always
```

### "Wrong download URL in Laravel"
**Solution**:
```bash
php artisan desktop-app:update-urls [version]
```

### macOS "App is damaged" Error
**Solution**: The app needs to be signed and notarized for distribution
```bash
# For development/testing only:
sudo xattr -rd com.apple.quarantine /Applications/Restify\ Printer.app
```

### "Cannot build .dmg on Windows"
**Solution**: Use the two-step process:
1. Run `.\create-release-mac.ps1` on Windows (prepares release)
2. Run `npm run build:mac` on macOS (creates .dmg)
3. Upload .dmg to GitHub release

---

## 📁 File Structure

```
desktop-printer-app/
├── create-release.ps1         # 🚀 Windows release script
├── create-release.bat         # 🚀 Windows release script (batch)
├── create-release-mac.ps1     # 🍎 macOS release script  
├── create-release-mac.sh      # 🍎 macOS release script (bash)
├── build-mac.ps1             # 🍎 Simple macOS build
├── package.json              # Version and build config
├── CHANGELOG.md              # Release notes
└── dist/                     # Built files
    ├── Restify Printer Setup 1.0.1.exe    # Windows
    ├── Restify Printer 1.0.1.dmg          # macOS
    └── latest.yml                          # Update metadata
```

---

## 🎯 Summary

### For Windows releases:
```powershell
.\create-release.ps1
```

### For macOS releases:
```powershell
.\create-release-mac.ps1    # (requires macOS for .dmg)
# OR
.\build-mac.ps1            # Simple build only
```

**That's it!** The scripts handle everything automatically:
- ✅ Version updates
- ✅ Changelog updates  
- ✅ Git commits
- ✅ Platform-specific builds
- ✅ GitHub releases
- ✅ Laravel URL updates

Your restaurants will automatically get the new download links for both platforms! 🎉
