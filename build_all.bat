@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem ============================================================
rem  Build all Tzy OS tools as Nuitka one-file exes (strong
rem  obfuscation, no source on the target machine).
rem
rem  Output: dist\novaosd.exe      main daemon (DNS+HTTP+CDP)
rem          dist\nova-setup.exe   installer / preflight
rem          dist\nova-update.exe  cache version bump
rem          dist\nova-backup.exe  backup zip packer
rem
rem  Data files (novaos2\, admin\, config.json, *.js) stay next
rem  to the exe and are NOT embedded - they are meant to be
rem  editable; only python code is compiled/obfuscated.
rem ============================================================

if not exist dist mkdir dist

echo [1/5] Installing Nuitka ...
python -m pip install nuitka
if errorlevel 1 (
    echo [!] Failed to install Nuitka. Check python and network.
    pause
    exit /b 1
)

rem Make novacore package discoverable for the tool entry scripts.
set "PYTHONPATH=%~dp0;%PYTHONPATH%"

set "FLAGS=--onefile --assume-yes-for-downloads --remove-output --output-dir=dist --include-package=novacore"

set TARGETS=0
set TOTAL=4
for %%T in ("novaosd.py|novaosd.exe" "tools\nova_setup.py|nova-setup.exe" "tools\nova_update.py|nova-update.exe" "tools\nova_backup.py|nova-backup.exe") do (
    set /a TARGETS+=1
    for /f "tokens=1,2 delims=|" %%A in (%%T) do (
        echo [!TARGETS!/!TOTAL!] Compiling %%A -^> dist\%%B ...
        python -m nuitka %FLAGS% --output-filename=%%B %%A
        if errorlevel 1 (
            echo [!] Build failed: %%A
            pause
            exit /b 1
        )
    )
)

echo.
echo ============================================================
echo  All builds done. Files in dist\:
dir /b dist\*.exe
echo.
echo  Deploy: copy dist\*.exe next to config.json / novaos2\,
echo  then run nova-setup.exe (first time) or novaosd.exe.
echo ============================================================
pause
