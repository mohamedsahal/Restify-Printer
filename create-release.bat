@echo off
echo ========================================
echo    Restify Printer Release Creator
echo ========================================
echo.

REM Get current version from package.json
for /f "tokens=2 delims=:" %%a in ('findstr "version" package.json') do (
    set VERSION=%%a
    set VERSION=!VERSION:"=!
    set VERSION=!VERSION:,=!
    set VERSION=!VERSION: =!
)

echo Current version: %VERSION%
echo.

REM Ask for new version
set /p NEW_VERSION="Enter new version (current: %VERSION%): "
if "%NEW_VERSION%"=="" set NEW_VERSION=%VERSION%

echo.
echo Creating release v%NEW_VERSION%...
echo.

REM Update version in package.json
echo Updating package.json version...
powershell -Command "(Get-Content package.json) -replace '\"version\": \".*\"', '\"version\": \"%NEW_VERSION%\"' | Set-Content package.json"

REM Update CHANGELOG.md
echo Updating CHANGELOG.md...
echo ## v%NEW_VERSION% - %date% > temp_changelog.md
echo. >> temp_changelog.md
echo ### Added >> temp_changelog.md
echo - New features and improvements >> temp_changelog.md
echo. >> temp_changelog.md
echo ### Fixed >> temp_changelog.md
echo - Bug fixes and stability improvements >> temp_changelog.md
echo. >> temp_changelog.md
type CHANGELOG.md >> temp_changelog.md
move temp_changelog.md CHANGELOG.md

REM Commit changes
echo Committing changes...
git add .
git commit -m "Release v%NEW_VERSION%"
git push origin main

REM Build and publish
echo Building and publishing release...
npm run build

REM Update Laravel app URLs
echo Updating Laravel download URLs...
cd ..
php artisan desktop-app:update-urls %NEW_VERSION%
cd desktop-printer-app

echo.
echo ========================================
echo ✅ Release v%NEW_VERSION% created successfully!
echo.
echo Check your release at:
echo https://github.com/mohamedsahal/Restify-Printer/releases
echo ========================================
pause