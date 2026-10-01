@echo off
title Turn off PC hotspot

net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"
echo Turning off PC hotspot...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disable-hotspot.ps1" -NonInteractive
if %errorlevel% equ 0 (
    echo Hotspot is off.
) else (
    echo Failed. You can turn off Mobile Hotspot manually in Windows Settings.
)
timeout /t 3 >nul
