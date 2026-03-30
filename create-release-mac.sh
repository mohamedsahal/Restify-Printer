#!/bin/bash

# Restify Printer - macOS Release Script
# This script automates the entire release process for macOS

set -e  # Exit on any error

echo "🍎 Restify Printer - macOS Release Builder"
echo "=========================================="

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ Error: This script must be run on macOS to build .dmg files"
    echo "   Current OS: $OSTYPE"
    exit 1
fi

# Check if GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo "❌ Error: GitHub CLI (gh) is not installed"
    echo "   Install it with: brew install gh"
    echo "   Or download from: https://cli.github.com/"
    exit 1
fi

# Check if authenticated with GitHub
if ! gh auth status &> /dev/null; then
    echo "❌ Error: Not authenticated with GitHub"
    echo "   Run: gh auth login"
    exit 1
fi

# Check if Node.js and npm are installed
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed"
    echo "   Install Node.js from: https://nodejs.org/"
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "📋 Current version: $CURRENT_VERSION"

# Ask for version bump type
echo ""
echo "Select version bump type:"
echo "1) Patch (bug fixes): $CURRENT_VERSION → $(npm version --no-git-tag-version patch --dry-run | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')"
echo "2) Minor (new features): $CURRENT_VERSION → $(npm version --no-git-tag-version minor --dry-run | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')"
echo "3) Major (breaking changes): $CURRENT_VERSION → $(npm version --no-git-tag-version major --dry-run | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')"
echo "4) Custom version"
echo "5) Keep current version ($CURRENT_VERSION)"

read -p "Enter choice (1-5): " choice

case $choice in
    1)
        NEW_VERSION=$(npm version patch --no-git-tag-version)
        ;;
    2)
        NEW_VERSION=$(npm version minor --no-git-tag-version)
        ;;
    3)
        NEW_VERSION=$(npm version major --no-git-tag-version)
        ;;
    4)
        read -p "Enter custom version (e.g., 1.2.3): " custom_version
        npm version $custom_version --no-git-tag-version
        NEW_VERSION="v$custom_version"
        ;;
    5)
        NEW_VERSION="v$CURRENT_VERSION"
        echo "📋 Keeping current version: $NEW_VERSION"
        ;;
    *)
        echo "❌ Invalid choice. Exiting."
        exit 1
        ;;
esac

# Remove 'v' prefix for version number
VERSION_NUMBER=${NEW_VERSION#v}

echo "🔄 Building version: $VERSION_NUMBER"

# Ask for release notes
echo ""
read -p "📝 Enter release notes (or press Enter for default): " RELEASE_NOTES

if [ -z "$RELEASE_NOTES" ]; then
    RELEASE_NOTES="macOS release v$VERSION_NUMBER"
fi

# Update CHANGELOG.md
echo ""
echo "📝 Updating CHANGELOG.md..."
CHANGELOG_ENTRY="## v$VERSION_NUMBER - $(date +%Y-%m-%d)

### Added
- macOS build support
- $RELEASE_NOTES

"

# Create backup of CHANGELOG.md
cp CHANGELOG.md CHANGELOG.md.bak

# Add new entry to top of changelog (after the header)
{
    head -n 2 CHANGELOG.md
    echo "$CHANGELOG_ENTRY"
    tail -n +3 CHANGELOG.md
} > CHANGELOG.md.tmp && mv CHANGELOG.md.tmp CHANGELOG.md

echo "✅ CHANGELOG.md updated"

# Commit changes
echo ""
echo "📤 Committing changes..."
git add package.json CHANGELOG.md
git commit -m "Release v$VERSION_NUMBER for macOS"

# Build for macOS
echo ""
echo "🔨 Building macOS application..."
echo "   This may take several minutes..."

npm run build:mac

# Check if build was successful
if [ ! -d "dist" ] || [ -z "$(ls -A dist/*.dmg 2>/dev/null)" ]; then
    echo "❌ Build failed - no .dmg file found in dist/"
    exit 1
fi

# Find the built .dmg file
DMG_FILE=$(ls dist/*.dmg | head -n 1)
echo "✅ Build successful: $DMG_FILE"

# Push changes to GitHub
echo ""
echo "📤 Pushing to GitHub..."
git push origin main

# Create GitHub release
echo ""
echo "🚀 Creating GitHub release..."

gh release create "v$VERSION_NUMBER" \
    "$DMG_FILE" \
    --title "Restify Printer v$VERSION_NUMBER (macOS)" \
    --notes "$RELEASE_NOTES

## macOS Installation
1. Download the .dmg file
2. Open the .dmg file
3. Drag Restify Printer to Applications folder
4. Launch from Applications

## System Requirements
- macOS 10.15 (Catalina) or later
- 64-bit processor" \
    --latest

echo ""
echo "🎉 Release completed successfully!"
echo ""
echo "📋 Summary:"
echo "   Version: v$VERSION_NUMBER"
echo "   Platform: macOS (.dmg)"
echo "   File: $DMG_FILE"
echo "   GitHub: https://github.com/mohamedsahal/Restify-Printer/releases/tag/v$VERSION_NUMBER"
echo ""
echo "🔗 Next steps:"
echo "   1. Test the download from GitHub"
echo "   2. Update Laravel download URLs:"
echo "      cd .. && php artisan desktop-app:update-urls $VERSION_NUMBER"
echo ""