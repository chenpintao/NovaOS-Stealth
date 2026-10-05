# -*- coding: utf-8 -*-
"""书源模块集合：自动发现本目录下所有模块，import 即完成 @register 注册。

新增站点只需在本目录放一个 <key>.py，无需改动本文件。
Loshop & Cpt
"""
import importlib
import pkgutil

for _mod in pkgutil.iter_modules(__path__):
    if _mod.name.startswith("_"):
        continue
    importlib.import_module(__name__ + "." + _mod.name)