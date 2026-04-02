@echo off
:: Tigrimos - Stop Container
title Tigrimos - Stopping...

echo.
echo   ========================================
echo      Tigrimos - Stopping
echo   ========================================
echo.

:: Try to find docker in common locations
where docker >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "DOCKER_CMD=docker"
    goto :found_docker
)

if exist "C:\Program Files\Docker\Docker\resources\bin\docker.exe" (
    set "DOCKER_CMD=C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    goto :found_docker
)

echo   [ERROR] Docker not found. Please make sure Docker Desktop is installed.
echo.
pause
exit /b 1

:found_docker

:: Find the Tigrimos install directory
:: First check if we're in the install directory (has docker-compose.yml)
if exist "%~dp0docker-compose.yml" (
    set "INSTALL_DIR=%~dp0"
    goto :stop_app
)

:: Check default install location
if exist "C:\Tigrimos\docker-compose.yml" (
    set "INSTALL_DIR=C:\Tigrimos"
    goto :stop_app
)

echo   [ERROR] Cannot find Tigrimos installation.
echo   Please run this script from the Tigrimos install directory.
echo.
pause
exit /b 1

:stop_app
echo   Stopping Tigrimos...
echo.

pushd "%INSTALL_DIR%"
"%DOCKER_CMD%" compose down
popd

if %ERRORLEVEL% equ 0 (
    echo.
    echo   Tigrimos has been stopped.
) else (
    echo.
    echo   There was a problem stopping Tigrimos.
)

echo.
echo   Press any key to close...
pause >nul
