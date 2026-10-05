# -*- coding: utf-8 -*-
"""Tzy OS stealth 总程序入口（DNS + HTTP 注入代理 + 管理界面 + CDP 远程浏览器）。
运行方式二选一：
    runtime\\python\\python.exe novaosd.py   （内嵌便携运行时，Win7/10/11 通用）
    python novaosd.py                        （系统 Python）
Loshop & Cpt"""
import os
import sys

# 内嵌便携运行时（python38._pth）处于 semi-isolated 模式，不会自动把脚本
# 所在目录加入 sys.path，这里显式补上，否则找不到 novacore 包。
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from novacore.service import main  # noqa: E402

if __name__ == "__main__":
    main()
