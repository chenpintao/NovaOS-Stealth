# -*- coding: utf-8 -*-
# 兼容旧入口：服务端已按功能拆入 novacore 包，统一新入口为 novaosd.py。
# 本文件仅保留转发，旧的 `python server.py` 与旧快捷方式继续可用。
from novacore.service import main

if __name__ == "__main__":
    main()
