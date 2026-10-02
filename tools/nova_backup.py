# -*- coding: utf-8 -*-
"""Tzy OS backup tool: pack novaos2 + loader/bridge/config/server entry
into a timestamped zip.

Usage:
    python nova_backup.py [output_dir]

Loshop & Cpt"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from novacore.configutil import load_config  # noqa: E402
from novacore import toolkit  # noqa: E402


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    os.makedirs(out_dir, exist_ok=True)
    load_config()
    print("packing backup ...")
    data = toolkit.build_backup_zip()
    fname = toolkit.backup_filename()
    out = os.path.join(out_dir, fname)
    with open(out, "wb") as f:
        f.write(data)
    print("backup written: %s (%.1f KB)" % (out, len(data) / 1024.0))


if __name__ == "__main__":
    main()
