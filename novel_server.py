# -*- coding: utf-8 -*-
"""小说下载后端入口（中文书源聚合，纯 Python 3.8，Windows 7 可用）。

对外提供与 go-novel-dl 兼容的 REST 接口 /novel/api/*（路由见 novelsrc/facade.py），
由 novacore/novel_dl.py 按需拉起为子进程，再经 Tzy OS 挂载点反代给平板应用。

直接运行：
    python novel_server.py --port 18089
Loshop & Cpt
"""
import argparse
import os
import sys

# 内嵌便携运行时（python*._pth）不会自动把脚本目录加入 sys.path，需显式添加
ROOT = os.path.dirname(os.path.abspath(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from flask import Flask  # noqa: E402
from novelsrc.facade import register_routes  # noqa: E402


def create_app():
    app = Flask("novel-server", static_folder=None)
    register_routes(app)

    @app.after_request
    def _cors(resp):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Cache-Control"] = "no-store"
        return resp

    return app


def main():
    ap = argparse.ArgumentParser(description="Tzy OS novel backend")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("NOVEL_PORT", "18089")))
    args = ap.parse_args()
    app = create_app()
    app.run(host=args.host, port=args.port, threaded=True,
            debug=False, use_reloader=False)


if __name__ == "__main__":
    main()