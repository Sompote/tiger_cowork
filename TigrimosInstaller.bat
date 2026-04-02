@echo off
:: Tigrimos Installer - Windows Launcher
:: Double-click this file to start the installation

title Tigrimos Installer

echo.
echo   ========================================
echo      Tigrimos Installer
echo   ========================================
echo.
echo   Starting installer, please wait...
echo.

:: Launch PowerShell with bypass policy to run the install script
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0install.ps1"

if %ERRORLEVEL% neq 0 (
    echo.
    echo   Installation encountered an error.
    echo   Press any key to close...
    pause >nul
)
