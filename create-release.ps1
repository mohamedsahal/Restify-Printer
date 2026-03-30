Write-Host "========================================" -ForegroundColor Cyan
Write-Host "    Restify Printer Release Creator" -ForegroundColor Cyan  
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Get current version from package.json
$packageJson = Get-Content "package.json" | ConvertFrom-Json
$currentVersion = $packageJson.version

Write-Host "Current version: $currentVersion" -ForegroundColor Yellow
Write-Host ""

# Ask for new version
$newVersion = Read-Host "Enter new version (current: $currentVersion)"
if ([string]::IsNullOrEmpty($newVersion)) {
    $newVersion = $currentVersion
}

Write-Host ""
Write-Host "Creating release v$newVersion..." -ForegroundColor Green
Write-Host ""

# Update version in package.json
Write-Host "Updating package.json version..." -ForegroundColor Blue
$packageJson.version = $newVersion
$packageJson | ConvertTo-Json -Depth 10 | Set-Content "package.json"

# Update CHANGELOG.md
Write-Host "Updating CHANGELOG.md..." -ForegroundColor Blue
$date = Get-Date -Format "yyyy-MM-dd"
$newChangelog = @"
# Changelog

All notable changes to this project will be documented in this file.

## v$newVersion - $date

### Added
- New features and improvements

### Fixed  
- Bug fixes and stability improvements

### Changed
- Updated dependencies and configurations

"@

if (Test-Path "CHANGELOG.md") {
    $existingChangelog = Get-Content "CHANGELOG.md" -Raw
    # Skip the first few lines if they contain the header
    $lines = $existingChangelog -split "`n"
    $startIndex = 0
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match "^## v") {
            $startIndex = $i
            break
        }
    }
    if ($startIndex -gt 0) {
        $existingChangelog = ($lines[$startIndex..($lines.Length-1)] -join "`n")
    }
    $newChangelog += "`n" + $existingChangelog
}

$newChangelog | Set-Content "CHANGELOG.md"

# Commit changes
Write-Host "Committing changes..." -ForegroundColor Blue
git add .
git commit -m "Release v$newVersion"
git push origin main

# Build and publish
Write-Host "Building and publishing release..." -ForegroundColor Blue
npm run build

# Update Laravel app URLs
Write-Host "Updating Laravel download URLs..." -ForegroundColor Blue
Set-Location ".."
php artisan desktop-app:update-urls $newVersion
Set-Location "desktop-printer-app"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "✅ Release v$newVersion created successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "Check your release at:" -ForegroundColor Yellow
Write-Host "https://github.com/mohamedsahal/Restify-Printer/releases" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Green

Read-Host "Press Enter to continue"