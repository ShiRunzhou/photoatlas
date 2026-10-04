@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\cli.js" (
  echo PhotoAtlas runtime missing. Run npm ci in this folder.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading the Electron runtime for the first launch...
  node "node_modules\electron\install.js"
  if errorlevel 1 (
    echo Download failed. Check network access to GitHub Releases and try again.
    pause
    exit /b 1
  )
)
start "PhotoAtlas" "node_modules\electron\dist\electron.exe" "."
