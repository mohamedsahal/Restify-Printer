@echo off
echo Setting up GitHub Token for Restify Printer...
echo.

REM Set the GitHub token
set GH_TOKEN=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so

echo GitHub token has been set for this session.
echo.
echo You can now run:
echo   npm run build
echo.
echo To make this permanent, add to System Environment Variables:
echo   Variable: GH_TOKEN
echo   Value: %GH_TOKEN%
echo.
pause
