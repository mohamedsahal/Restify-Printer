# Build and Release Guide

## Your GitHub Repository

**Repository**: https://github.com/mohamedsahal/Restify-Printer
**Owner**: mohamedsahal
**Repo**: Restify-Printer
**Type**: Private

---

## Quick Start

### Step 1: Set GitHub Token

**Windows:**
```cmd
setup-github-token.bat
```

**macOS/Linux:**
```bash
chmod +x setup-github-token.sh
./setup-github-token.sh
```

Or manually:

**Windows CMD:**
```cmd
set GH_TOKEN=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so
```

**Windows PowerShell:**
```powershell
$env:GH_TOKEN="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so"
```

**macOS/Linux:**
```bash
export GH_TOKEN=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so
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Build

```bash
npm run build
```

This will:
1. Build the executable
2. Create installers
3. Upload to GitHub releases automatically

---

## Release Process

### 1. Update Version

Edit `package.json`:
```json
"version": "1.0.1"
```

### 2. Update Changelog

Create/update `CHANGELOG.md`:
```markdown
## v1.0.1 - 2026-03-30

### Added
- New feature X

### Fixed
- Bug Y
```

### 3. Commit Changes

```bash
git add .
git commit -m "Release v1.0.1"
git push origin main
```

### 4: Build and Publish

```bash
# Set token (if not already set)
setup-github-token.bat  # Windows
# or
./setup-github-token.sh  # macOS/Linux

# Build and publish
npm run build
```

### 5. Verify Release

Go to: https://github.com/mohamedsahal/Restify-Printer/releases

You should see:
- Release tag: `v1.0.1`
- Files:
  - `Restify-Printer-Setup-1.0.1.exe` (Windows)
  - `Restify-Printer-1.0.1.dmg` (macOS)
  - `Restify-Printer-1.0.1.AppImage` (Linux)
  - `latest.yml` (update metadata)

---

## Testing Updates

### Test Scenario

1. **Install v1.0.0:**
   - Build with version 1.0.0
   - Install the app
   - Run it

2. **Create v1.0.1 release:**
   - Update version to 1.0.1
   - Build and publish

3. **Test update:**
   - Run the v1.0.0 app
   - Click "Check Updates"
   - Should show: "Update available: v1.0.1"
   - Click OK to download
   - Click OK to install
   - App restarts with v1.0.1

---

## Build Commands

### Build for Current Platform
```bash
npm run build
```

### Build for Specific Platform
```bash
npm run build:win    # Windows
npm run build:mac    # macOS
npm run build:linux  # Linux
```

### Build Without Publishing
```bash
npm run build -- --publish never
```

---

## Troubleshooting

### "GH_TOKEN is not set"

**Solution**: Run the setup script or set manually

### "Repository not found"

**Cause**: Token doesn't have access to private repo

**Solution**: 
1. Go to: https://github.com/settings/tokens
2. Edit your token
3. Ensure `repo` scope is selected (all checkboxes)
4. Save and use the new token

### "Upload failed"

**Cause**: Release already exists

**Solution**: 
1. Delete the release on GitHub
2. Or increment version number
3. Build again

### "Permission denied"

**Cause**: Token expired or invalid

**Solution**: Generate a new token and update

---

## GitHub Token Permissions

Your token needs these scopes:
- ✅ `repo` (Full control of private repositories)
  - ✅ `repo:status`
  - ✅ `repo_deployment`
  - ✅ `public_repo`
  - ✅ `repo:invite`
  - ✅ `security_events`

---

## Security Notes

### ⚠️ Important

1. **Never commit the token** to git
2. **Keep `.env` in `.gitignore`**
3. **Regenerate if exposed**
4. **Use environment variables**

### Token Storage

**Permanent (Recommended):**

**Windows:**
1. Search "Environment Variables"
2. Click "Environment Variables"
3. Under "User variables", click "New"
4. Variable name: `GH_TOKEN`
5. Variable value: `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so`
6. Click OK

**macOS/Linux:**

Add to `~/.bashrc` or `~/.zshrc`:
```bash
export GH_TOKEN=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so
```

Then:
```bash
source ~/.bashrc  # or ~/.zshrc
```

---

## First Release Checklist

- [ ] GitHub repository created
- [ ] Token generated with `repo` scope
- [ ] Token set in environment
- [ ] Dependencies installed (`npm install`)
- [ ] Version is 1.0.0 in package.json
- [ ] Build successful (`npm run build`)
- [ ] Release appears on GitHub
- [ ] Installer files uploaded
- [ ] Test installation works

---

## Next Release Checklist

- [ ] Update version in package.json
- [ ] Update CHANGELOG.md
- [ ] Commit and push changes
- [ ] Set GH_TOKEN environment variable
- [ ] Run `npm run build`
- [ ] Verify release on GitHub
- [ ] Test update from previous version
- [ ] Announce release

---

## Support

If you encounter issues:

1. Check token permissions
2. Verify repository access
3. Check build logs
4. Test with `--publish never` first
5. Review GitHub Actions (if enabled)

---

## Summary

✅ **Your repository is configured!**

- Repository: https://github.com/mohamedsahal/Restify-Printer
- Token: Ready to use
- Build: `npm run build`
- Updates: Automatic via electron-updater

Just run the setup script and build! 🚀
