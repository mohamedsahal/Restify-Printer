#!/bin/bash

echo "Setting up GitHub Token for Restify Printer..."
echo ""

# Set the GitHub token
export GH_TOKEN=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so

echo "GitHub token has been set for this session."
echo ""
echo "You can now run:"
echo "  npm run build"
echo ""
echo "To make this permanent, add to your ~/.bashrc or ~/.zshrc:"
echo "  export GH_TOKEN=$GH_TOKEN"
echo ""
