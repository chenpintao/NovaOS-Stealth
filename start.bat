@echo off
title Tzy OS stealth injection service (PC hotspot mode)

rem ================= Hotspot config (password must be >= 8 chars) =================
set "HOTSPOT_SSID=Hack Hotspot"
set "HOTSPOT_PWD=helloezy"
rem Band: 2.4GHz / 5GHz / Auto
set "HOTSPOT_BAND=2.4GHz"
rem ===============================================================================

rem Use /nohotspot for LAN mode (no hotspot; tablet's Wi-Fi DNS points at this PC)
set "NO_HOTSPOT=0"
if /i "%~1"=="/nohotspot" set "NO_HOTSPOT=1"

rem ---- Auto elevate (ports 53/80 and hotspot control require admin) ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

rem ---- Interpreter: prefer the bundled portable runtime, else system Python ----
rem The bundled runtime already contains every dependency, so the target PC
rem needs no Python and no online pip install.
set "PYEXE=runtime\python\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"

echo [1/4] Checking Python dependencies...
if /i not "%PYEXE%"=="python" goto :deps_ok
rem No bundled runtime (source/dev machine): use system Python + pip
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo Dependency installation failed. Make sure Python 3 is installed and the PC is online.
    pause
    exit /b 1
)
:deps_ok

echo [2/4] Opening firewall for incoming UDP 53 / TCP 80...
rem UDP 53 is needed in both modes: hotspot DNS hijack, or LAN mode where the
rem tablet's Wi-Fi DNS is pointed at this PC.
netsh advfirewall firewall delete rule name="NovaStealth DNS/HTTP" >nul 2>&1
netsh advfirewall firewall add rule name="NovaStealth DNS/HTTP" dir=in action=allow protocol=UDP localport=53 >nul
netsh advfirewall firewall add rule name="NovaStealth DNS/HTTP" dir=in action=allow protocol=TCP localport=80 >nul

if "%NO_HOTSPOT%"=="0" (
    echo [3/4] Configuring and starting PC hotspot: %HOTSPOT_SSID%
    rem Changing SSID/password requires: stop hotspot -> write registry -> start hotspot
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0disable-hotspot.ps1" -NonInteractive
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-hotspot-credentials.ps1" "%HOTSPOT_SSID%" "%HOTSPOT_PWD%" "%HOTSPOT_BAND%" -NonInteractive
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0enable-hotspot.ps1" -NonInteractive
    if %errorlevel% neq 0 (
        echo.
        echo [!] Failed to enable hotspot automatically. Please check:
        echo     1^) The PC has a working Wi-Fi adapter and internet connection
        echo     2^) Mobile Hotspot can be turned on manually in Windows Settings
        echo     Service will still start. You can also rerun with /nohotspot to skip this step.
        echo.
    )
    echo     Hotspot SSID : %HOTSPOT_SSID%
    echo     Hotspot pass : %HOTSPOT_PWD%
    echo     Connect phone/tablet to this hotspot, then open the column page as usual.
) else (
    echo [3/4] Hotspot control skipped (/nohotspot = LAN mode)
    echo     LAN mode: set the tablet Wi-Fi DNS to this PC's LAN IP, then open
    echo     the column page as usual. (The IP is printed below on startup.)
)

echo [4/4] Starting DNS + HTTP injection service...
echo ============================================================
"%PYEXE%" -X utf8 novaosd.py
echo.
echo Service stopped. Run stop-hotspot.bat to turn off the PC hotspot.
pause
