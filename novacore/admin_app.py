# -*- coding: utf-8 -*-
"""本机管理界面（127.0.0.1:admin_port）。"""
import json
import os

from flask import jsonify, request, send_file
from flask import Flask, Response

from novacore.configutil import (
    CONFIG, cfg, validate, save_config, novaos_dir, mount_prefix,
)
from novacore.paths import ADMIN_DIR, ACCESS_LOG, LOADER_PATH
from novacore.netutil import local_ip, hotspot_ip, answer_ip, resolve_external
from novacore import toolkit

# ----------------------------- 本机管理界面 -----------------------------
def create_admin_app():
    app = Flask("nova-admin", static_folder=ADMIN_DIR, static_url_path="")

    @app.route("/")
    def index():
        from flask import send_from_directory
        return send_from_directory(ADMIN_DIR, "index.html")

    @app.route("/api/config", methods=["GET"])
    def get_config():
        return jsonify(CONFIG)

    @app.route("/api/config", methods=["POST"])
    def post_config():
        data = request.get_json(force=True, silent=True) or {}
        # 表单只渲染部分键（host_routes/lan_mode 等不在页面上）：
        # 以现有配置为底合并，避免保存时丢键。
        merged = dict(CONFIG)
        merged.update(data)
        errors = validate(merged)
        if errors:
            return jsonify({"ok": False, "errors": errors}), 400
        try:
            save_config(merged)
        except Exception as e:
            return jsonify({"ok": False, "errors": {"_": "保存失败：%s" % e}}), 500
        return jsonify({"ok": True, "note": "已保存。平板刷新专栏页面后新配置生效。"})

    @app.route("/api/access_log", methods=["GET"])
    def access_log():
        try:
            n = max(1, min(300, int(request.args.get("n", 80))))
            if not os.path.isfile(ACCESS_LOG):
                return jsonify({"lines": []})
            with open(ACCESS_LOG, "rb") as f:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                f.seek(max(0, size - 65536))
                text = f.read().decode("utf-8", errors="replace")
            lines = [ln for ln in text.splitlines() if ln.strip()]
            return jsonify({"lines": lines[-n:]})
        except Exception as e:
            return jsonify({"lines": [], "error": str(e)})

    @app.route("/api/update", methods=["POST"])
    def api_update():
        """更新系统：刷新入口 HTML 引用版本号（逻辑见 novacore.toolkit）。"""
        changed, errors = toolkit.bump_entry_versions()
        return jsonify({"ok": not errors, "changed": changed, "errors": errors,
                        "note": "版本号已刷新，设备下次打开即生效"})

    @app.route("/api/backup", methods=["GET"])
    def api_backup():
        """打包回传备份 zip 下载（逻辑见 novacore.toolkit）。"""
        try:
            data = toolkit.build_backup_zip()
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)}), 500
        resp = Response(data, status=200)
        resp.headers["Content-Type"] = "application/zip"
        resp.headers["Content-Disposition"] = 'attachment; filename="%s"' % toolkit.backup_filename()
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.route("/api/status", methods=["GET"])
    def status():
        root = novaos_dir()
        return jsonify({
            "local_ip": local_ip(),
            "hotspot_ip": hotspot_ip(),
            "answer_ip": answer_ip(),
            "novaos_dir": root,
            "index_exists": os.path.isfile(os.path.join(root, "index.html")),
            "loader_exists": os.path.isfile(LOADER_PATH),
            "mount_url": "%s://%s%sindex.html" % (
                cfg("serve_scheme", "http"), cfg("serve_host"), mount_prefix()),
            "dns_resolve_sample": (lambda: (lambda r: r if isinstance(r, list) else [str(r)])
                                   (resolve_external("web-alicdn.zyai.cc")))()
        })

    return app