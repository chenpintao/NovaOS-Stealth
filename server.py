# -*- coding: utf-8 -*-
# 兼容旧入口：服务端已按功能拆入 novacore 包，统一新入口为 novaosd.py。
# 本文件仅保留转发，旧的 `python server.py` 与旧快捷方式继续可用。
import os
import sys

# 内嵌便携运行时（python38._pth）不会自动把脚本目录加入 sys.path，需显式补上
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from novacore.service import main  # noqa: E402

if __name__ == "__main__":
    main()
