@echo off
setlocal
cd /d "%~dp0"
rem Build the bundled portable Python runtime for the lncrawl engine
rem (target machine needs no Python install).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_lncrawl_runtime.ps1" %*
if errorlevel 1 pause
