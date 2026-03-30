# Restify Printer - macOS Release Script (PowerShell)
# This script can be run on Windows but requires macOS for actual .dmg building

param(
    [string]$Version = "",
    [string]$ReleaseNotes = ""
)

Write-Host "🍎 Restify Printer - macOS Release Builder" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green

# Check if we're on macOS (when running on Mac with PowerShell)
if ($IsMacOS -eq $false -and $env:OS -eq "Windows_NT") {
    Write-Host "⚠️  Warning: You're running this on Windows" -ForegroundColor Yellow
    Write-Host "   This script will prepare the release but .dmg building requires macOS" -ForegroundColor Yellow
    Write-Host "   You can run this to prepare, then run on Mac to build" -ForegroundColor Yellow
    Write-Host ""
}

# Check if GitHub CLI is available
try {
    gh --version | Out-Null
} catch {
    Write-Host "❌ Error: GitHub CLI (gh) is not installed" -ForegroundColor Red
    Write-Host "   Download from: https://cli.github.com/" -ForegroundColor Yellow
    exit 1
}

# Check GitHub authentication
try {
    gh auth status 2>$null | Out-Null
} catch {
    Write-Host "❌ Error: Not authenticated with GitHub" -ForegroundColor Red
    Write-Host "   Run: gh auth login" -ForegroundColor Yellow
    exit 1
}

# Check if npm is available
try {
    npm --version | Out-Null
} catch {
    Write-Host "❌ Error: npm is not installed" -ForegroundColor Red
    Write-Host "   Install Node.js from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Install dependencies if needed
if (!(Test-Path "node_modules")) {
    Write-Host "📦 Installing dependencies..." -ForegroundColor Blue
    npm install
}

# Get current version
$packageJson = Get-Content "package.json" | ConvertFrom-Json
$currentVersion = $packageJson.version
Write-Host "📋 Current version: $currentVersion" -ForegroundColor Cyan

# Handle version input
if ([string]::IsNullOrEmpty($Version)) {
    Write-Host ""
    Write-Host "Select version bump type:" -ForegroundColor Yellow
    Write-Host "1) Patch (bug fixes): $currentVersion → (auto-increment)"
    Write-Host "2) Minor (new features): $currentVersion → (auto-increment)"
    Write-Host "3) Major (breaking changes): $currentVersion → (auto-increment)"
    Write-Host "4) Custom version"
    Write-Host "5) Keep current version ($currentVersion)"
    
    $choice = Read-Host "Enter choice (1-5)"
    
    switch ($choice) {
        "1" { 
            npm version patch --no-git-tag-version
            $newVersion = (Get-Content "package.json" | ConvertFrom-Json).version
        }
        "2" { 
            npm version minor --no-git-tag-version
            $newVersion = (Get-Content "package.json" | ConvertFrom-Json).version
        }
        "3" { 
            npm version major --no-git-tag-version
            $newVersion = (Get-Content "package.json" | ConvertFrom-Json).version
        }
        "4" { 
            $customVersion = Read-Host "Enter custom version (e.g., 1.2.3)"
            npm version $customVersion --no-git-tag-version
            $newVersion = $customVersion
        }
        "5" { 
            $newVersion = $currentVersion
            Write-Host "📋 Keeping current version: $newVersion" -ForegroundColor Cyan
        }
        default {
            Write-Host "❌ Invalid choice. Exiting." -ForegroundColor Red
            exit 1
        }
    }
} else {
    $newVersion = $Version
    npm version $newVersion --no-git-tag-version
}

Write-Host "🔄 Building version: $newVersion" -ForegroundColor Green

# Handle release notes
if ([string]::IsNullOrEmpty($ReleaseNotes)) {
    Write-Host ""
    $ReleaseNotes = Read-Host "📝 Enter release notes (or press Enter for default)"
    if ([string]::IsNullOrEmpty($ReleaseNotes)) {
        $ReleaseNotes = "macOS release v$newVersion"
    }
}

# Update CHANGELOG.md
Write-Host ""
Write-Host "📝 Updating CHANGELOG.md..." -ForegroundColor Blue

$date = Get-Date -Format "yyyy-MM-dd"
$changelogEntry = @"
## v$newVersion - $date

### Added
- macOS build support
- $ReleaseNotes

"@

# Read current changelog
$changelog = Get-Content "CHANGELOG.md" -Raw

# Insert new entry after the first two lines (header)
$lines = $changelog -split "`n"
$newChangelog = $lines[0..1] + "" + $changelogEntry + $lines[2..($lines.Length-1)]
$newChangelog -join "`n" | Set-Content "CHANGELOG.md"

Write-Host "✅ CHANGELOG.md updated" -ForegroundColor Green

# Commit changes
Write-Host ""
Write-Host "📤 Committing changes..." -ForegroundColor Blue
git add package.json CHANGELOG.md
git commit -m "Release v$newVersion for macOS"

# Check if we can build (macOS required for .dmg)
if ($IsMacOS -eq $true) {
    # Build for macOS
    Write-Host ""
    Write-Host "🔨 Building macOS application..." -ForegroundColor Blue
    Write-Host "   This may take several minutes..." -ForegroundColor Yellow
    
    npm run build:mac
    
    # Check if build was successful
    $dmgFiles = Get-ChildItem "dist/*.dmg" -ErrorAction SilentlyContinue
    if ($dmgFiles.Count -eq 0) {
        Write-Host "❌ Build failed - no .dmg file found in dist/" -ForegroundColor Red
        exit 1
    }
    
    $dmgFile = $dmgFiles[0].FullName
    Write-Host "✅ Build successful: $dmgFile" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "⚠️  Skipping .dmg build (requires macOS)" -ForegroundColor Yellow
    Write-Host "   To complete the build:" -ForegroundColor Yellow
    Write-Host "   1. Transfer this project to a Mac" -ForegroundColor Yellow
    Write-Host "   2. Run: npm run build:mac" -ForegroundColor Yellow
    Write-Host "   3. Run the GitHub release creation below" -ForegroundColor Yellow
    
    # Create a placeholder for the dmg file path
    $dmgFile = "dist/Restify-Printer-$newVersion.dmg"
}

# Push changes to GitHub
Write-Host ""
Write-Host "📤 Pushing to GitHub..." -ForegroundColor Blue
git push origin main

# Create GitHub release (only if we have the .dmg file)
if (Test-Path $dmgFile) {
    Write-Host ""
    Write-Host "🚀 Creating GitHub release..." -ForegroundColor Blue
    
    $releaseNotes = @"
$ReleaseNotes

## macOS Installation
1. Download the .dmg file
2. Open the .dmg file
3. Drag Restify Printer to Applications folder
4. Launch from Applications

## System Requirements
- macOS 10.15 (Catalina) or later
- 64-bit processor
"@
    
    gh release create "v$newVersion" $dmgFile --title "Restify Printer v$newVersion (macOS)" --notes $releaseNotes --latest
    
    Write-Host ""
    Write-Host "🎉 Release completed successfully!" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "📋 Release prepared but not published (missing .dmg file)" -ForegroundColor Yellow
    Write-Host "   Complete the build on macOS and run:" -ForegroundColor Yellow
    Write-Host "   gh release create `"v$newVersion`" dist/*.dmg --title `"Restify Printer v$newVersion (macOS)`" --notes `"$ReleaseNotes`" --latest" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "📋 Summary:" -ForegroundColor Cyan
Write-Host "   Version: v$newVersion"
Write-Host "   Platform: macOS (.dmg)"
Write-Host "   File: $dmgFile"
Write-Host "   GitHub: https://github.com/mohamedsahal/Restify-Printer/releases/tag/v$newVersion"
Write-Host ""
Write-Host "🔗 Next steps:" -ForegroundColor Yellow
Write-Host "   1. Test the download from GitHub"
Write-Host "   2. Update Laravel download URLs:"
Write-Host "      cd .. && php artisan desktop-app:update-urls $newVersion"
Write-Host ""