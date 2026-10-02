@echo off
title Tzy OS stealth injection service (PC hotspot mode)

rem ================= Hotspot config (password must be >= 8 chars) =================
set "HOTSPOT_SSID=Hack Hotspot"
set "HOTSPOT_PWD=helloezy"
rem Band: 2.4GHz / 5GHz / Auto
set "HOTSPOT_BAND=2.4GHz"
rem ===============================================================================

rem Use /nohotspot to skip hotspot control (LAN / manual DNS mode)
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

echo [1/4] Checking Python dependencies...
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo Dependency installation failed. Make sure Python 3 is installed and the PC is online.
    pause
    exit /b 1
)

if "%NO_HOTSPOT%"=="0" (
    echo [2/4] Opening firewall for incoming UDP 53 / TCP 80...
    netsh advfirewall firewall delete rule name="NovaStealth DNS/HTTP" >nul 2>&1
    netsh advfirewall firewall add rule name="NovaStealth DNS/HTTP" dir=in action=allow protocol=UDP localport=53 >nul
    netsh advfirewall firewall add rule name="NovaStealth DNS/HTTP" dir=in action=allow protocol=TCP localport=80 >nul

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
    echo [2/4] Hotspot control skipped (/nohotspot)
)

echo [4/4] Starting DNS + HTTP injection service...
echo ============================================================
rem Prefer Nuitka single-file build; fall back to python source.
if exist "dist\novaosd.exe" (
    "dist\novaosd.exe"
) else (
    python novaosd.py
)
echo.
echo Service stopped. Run stop-hotspot.bat to turn off the PC hotspot.
pause
