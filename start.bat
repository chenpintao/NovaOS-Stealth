@echo off
chcp 65001 >nul
title NovaOS stealth 注入服务

rem ---- 自动申请管理员权限（53/80 端口需要）----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo 正在申请管理员权限...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

echo [1/2] 检查 Python 依赖...
python -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo 依赖安装失败，请确认已安装 Python 3 且联网。
    pause
    exit /b 1
)

echo [2/2] 启动服务...
python server.py
pause
