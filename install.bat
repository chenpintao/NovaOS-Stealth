@echo off
setlocal
cd /d "%~dp0"

rem Tzy OS installer entry.
rem Interpreter: prefer the bundled portable runtime (target PC needs no
rem Python), else fall back to system Python.

set "PYEXE=runtime\python\python.exe"
if not exist "%PYEXE%" set "PYEXE=python"

"%PYEXE%" -X utf8 tools\nova_setup.py %*

if errorlevel 1 pause