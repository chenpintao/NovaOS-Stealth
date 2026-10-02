@echo off
setlocal
cd /d "%~dp0"

rem Tzy OS installer entry.
rem Prefer the Nuitka-compiled single-file build; fall back to python source.

if exist "dist\nova-setup.exe" (
    "dist\nova-setup.exe" %*
) else (
    python tools\nova_setup.py %*
)

if errorlevel 1 pause
