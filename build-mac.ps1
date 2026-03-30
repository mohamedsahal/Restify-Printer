# Simple macOS Build Script
# This script builds the macOS .dmg file

Write-Host "🍎 Building Restify Printer for macOS..." -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Green

# Check if npm is available
try {
    $null = npm --version
    Write-Host "✅ npm found" -ForegroundColor Green
} catch {
    Write-Host "❌ Error: npm is not installed" -ForegroundColor Red
    Write-Host "   Install Node.js from: https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Check if dependencies are installed
if (!(Test-Path "node_modules")) {
    Write-Host "📦 Installing dependencies..." -ForegroundColor Blue
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ Failed to install dependencies" -ForegroundColor Red
        exit 1
    }
    Write-Host "✅ Dependencies installed" -ForegroundColor Green
} else {
    Write-Host "✅ Dependencies already installed" -ForegroundColor Green
}

# Get current version
try {
    $packageJson = Get-Content "package.json" | ConvertFrom-Json
    $version = $packageJson.version
    Write-Host "📋 Current version: $version" -ForegroundColor Cyan
} catch {
    Write-Host "❌ Error reading package.json" -ForegroundColor Red
    exit 1
}

# Clean previous builds
if (Test-Path "dist") {
    Write-Host "🧹 Cleaning previous builds..." -ForegroundColor Yellow
    Remove-Item "dist" -Recurse -Force
}

# Build for macOS
Write-Host ""
Write-Host "🔨 Building macOS application (.dmg)..." -ForegroundColor Blue
Write-Host "   This may take several minutes..." -ForegroundColor Yellow
Write-Host "   Note: This will create a .dmg file that can be distributed" -ForegroundColor Cyan

npm run build:mac

# Check if build was successful
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Build failed!" -ForegroundColor Red
    exit 1
}

# Check for output files
$distFiles = Get-ChildItem "dist" -ErrorAction SilentlyContinue
if ($distFiles.Count -eq 0) {
    Write-Host "❌ Build completed but no files found in dist/" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "✅ Build completed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "📁 Output files:" -ForegroundColor Cyan

foreach ($file in $distFiles) {
    $size = [math]::Round($file.Length / 1MB, 2)
    Write-Host "   📄 $($file.Name) ($size MB)" -ForegroundColor White
}

# Find .dmg file specifically
$dmgFiles = Get-ChildItem "dist/*.dmg" -ErrorAction SilentlyContinue
if ($dmgFiles.Count -gt 0) {
    $dmgFile = $dmgFiles[0]
    $dmgSize = [math]::Round($dmgFile.Length / 1MB, 2)
    
    Write-Host ""
    Write-Host "🎉 macOS installer ready!" -ForegroundColor Green
    Write-Host "   📦 File: $($dmgFile.Name)" -ForegroundColor Cyan
    Write-Host "   📏 Size: $dmgSize MB" -ForegroundColor Cyan
    Write-Host "   📍 Path: $($dmgFile.FullName)" -ForegroundColor Gray
    
    Write-Host ""
    Write-Host "🔗 Next steps:" -ForegroundColor Yellow
    Write-Host "   1. Test the .dmg file on a Mac"
    Write-Host "   2. Upload to your Laravel app using the desktop app manager"
    Write-Host "   3. Or create a GitHub release with: .\create-release-mac.ps1"
} else {
    Write-Host ""
    Write-Host "⚠️  No .dmg file found in output" -ForegroundColor Yellow
    Write-Host "   Check the dist/ folder for other build artifacts" -ForegroundColor Yellow
}

Write-Host ""