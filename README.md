# Tzy OS

隐蔽注入式「Tzy OS」桌面环境：电脑端跑 DNS + HTTP 注入代理，平板/手机在**不安装任何东西、不改代理设置**的情况下，打开原有在线专栏页面即可通过隐蔽唤起方式进入一套完整的网页操作系统（文件管理、编辑器、媒体播放器、远程浏览器、小游戏等），并支持断劫持后的离线持久化。

Loshop & Cpt

---

## 1. 工作原理

```
平板 ──(连 PC 热点 / 同局域网)──> PC 上的 novaosd
                                  ├─ DNS 服务（53）：劫持域名解析到本机，其余正常递归
                                  ├─ HTTP 代理（80）：平台流量透明透传 + 注入引导脚本
                                  │                 静态资源缓存投毒（一年长缓存）
                                  ├─ Tzy OS 挂载点 /__nova__/：桌面页面 + 应用 API
                                  ├─ CDP 远程浏览器：电脑端 headless Chrome 画面推流
                                  └─ 管理界面 127.0.0.1:8899（仅本机）
```

- **热点 DNS 劫持模式（模式 1）**：平板连电脑热点，DNS 劫持 + manifest 注入 + 缓存投毒。访问一次专栏后，即使断开劫持，OS 仍可从浏览器长期缓存唤起。
- **局域网代理模式（模式 2）**：不控 DNS，平板与电脑同一局域网，浏览器直接开 `http://电脑IP/__nova__/`。
- **隐蔽唤起**（均可在管理界面开关）：键盘 `Ctrl+Shift+Y`、屏幕角落连点 5 次、网址暗参 `?_o=1`、搜索框输入关键词。

## 2. 目录结构

| 路径 | 说明 |
| --- | --- |
| `novaosd.py` | **总程序入口**（5 行，转发到 `novacore.service.main`） |
| `server.py` | 旧入口兼容 shim，效果等同 `novaosd.py` |
| `novacore/` | 服务端按功能拆分的 Python 包（见下表） |
| `tools/nova_setup.py` | 安装器：依赖安装、模式切换、环境预检 |
| `tools/nova_update.py` | 更新器：刷新页面静态资源缓存版本号 |
| `tools/nova_backup.py` | 备份器：打包 novaos2 + 配置 + 入口脚本为 zip |
| `novaos2/` | 桌面页面（`index/nova/os.html`、`os.js/css`、`apps/*.js`） |
| `admin/` | 本机管理界面（端口 8899） |
| `loader.js` / `boot-stub.js` / `bridge.js` | 注入引导链：stub 注入 manifest → loader 握手 → bridge 桥接 |
| `config.json` | 全部运行配置（管理界面可改，一般不用手编） |
| `install.bat` / `start.bat` / `stop-hotspot.bat` | 安装 / 启动（自动提权、开热点、防火墙）/ 关热点 |
| `build_all.bat` | 一键 Nuitka 编译 4 个单文件 exe（强混淆） |
| `archive/novaos1/` | 旧版 NovaOS 1 整包归档，不再参与运行 |

### novacore 模块职责

| 模块 | 职责 |
| --- | --- |
| `paths.py` | 部署路径常量（兼容 Nuitka onefile 的临时解压目录）、访问日志 |
| `configutil.py` | 配置加载/保存/校验、`novaos_dir`/`fs_root`/挂载前缀 |
| `netutil.py` | 本机/热点/应答 IP、外部域名解析（防 DNS 回环、带缓存） |
| `dns_service.py` | 迷你 DNS 服务（UDP 53，劫持域名 + 上游转发） |
| `htmlkit.py` | 缓存头、入口 HTML 转换（注入桥接脚本、资源版本号、去统计） |
| `sources.py` | 挂载点应用 API：本地文件/FTP/SMB/外网代取/ping |
| `cdp_browser.py` | CDP headless Chrome 单例：启动、输入回注、JPEG 帧 SSE 推流 |
| `toolkit.py` | 公共工具：`?v=` 版本号刷新、备份 zip 打包 |
| `proxy_app.py` | HTTP 透明代理 + 注入 + 挂载点（含 `/sys/update`、`/sys/backup`） |
| `admin_app.py` | 本机管理界面 API |
| `service.py` | DNS / HTTP / ADMIN 三线程编排总控 |

## 3. 快速开始（Python 源码方式）

要求：Windows 10/11 + Python 3.9+（开发环境 3.13）+ Chrome 或 Edge（远程浏览器用，可选）。

1. 右键管理员运行 `install.bat`（或命令行 `python tools\nova_setup.py`），按提示选模式，会自动 `pip install -r requirements.txt` 并做环境预检。
   - `python tools\nova_setup.py --check`：只做预检（管理员权限、依赖、Chrome、目录）。
   - `python tools\nova_setup.py --mode 1|2`：免交互直接切模式。
2. 模式 1：运行 `start.bat`（自动提权、开防火墙、开热点、起服务）；模式 2：`start.bat /nohotspot`，或安装器选 2 后直接启动。
3. 平板连热点后照常打开专栏页面，用设定的暗号唤起；模式 2 直接浏览器开启动时打印的 `http://电脑IP/__nova__/`。
4. 管理：电脑浏览器开 <http://127.0.0.1:8899/>。

停止服务后用 `stop-hotspot.bat` 关闭电脑热点。

## 4. 编译为单文件 exe（强混淆）

运行 `build_all.bat`（首次会自动安装 Nuitka 并下载 MinGW64 工具链，需联网、耗时较长）。
产物在 `dist/`：

| exe | 对应 | 作用 |
| --- | --- | --- |
| `novaosd.exe` | `novaosd.py` | 主服务（DNS+HTTP+CDP+管理） |
| `nova-setup.exe` | `tools/nova_setup.py` | 安装/预检/模式切换 |
| `nova-update.exe` | `tools/nova_update.py` | 刷新缓存版本号 |
| `nova-backup.exe` | `tools/nova_backup.py` | 生成备份 zip（可带输出目录参数） |

Python 代码经 Nuitka 编译为机器码，目标机无 `.py` 源码。`novaos2/`、`admin/`、`config.json`、注入脚本等**数据文件不嵌入 exe**，便于不重新编译就热更页面。

**部署**：把 4 个 exe 放到与 `config.json`、`novaos2/` 同级的目录（exe 旁找不到配置时自动退回当前工作目录）；`install.bat` / `start.bat` 检测到 `dist\*.exe` 会优先用 exe，否则回退 Python 源码。

## 5. 配置说明（config.json / 管理界面）

常用项：

- `inject_*`：注入开关与 manifest 匹配路径；`serve_host` 挂载域名；`mount` 挂载路径（即入口暗号地址）。
- `novaos_dir`：桌面页面目录；`fs_root`：「本地文件」应用访问边界。
- `cache_poison`：缓存投毒离线持久化；`strip_ga`：去除 Google 统计。
- `http_port` / `admin_port`：HTTP 与管理端口（不能相同）。
- `dns_enable` / `hijack_domains` / `dns_upstreams` / `answer_ip`：DNS 劫持。
- 四组唤起暗号：热键 / 角落连点 / 网址暗参 / 搜索关键词；`exit_action` 退出方式。
- **远程浏览器画面（高度自定义）**：
  - `cdp_width` 640–3840（默认 1280）
  - `cdp_height` 480–2160（默认 800）
  - `cdp_quality` JPEG 画质 10–100（默认 55，越高越清晰越费带宽）
  - 管理界面「服务与 DNS」卡片可直接改；保存后在远程浏览器里重开一次应用生效。平板端画布会自动从 `/cdp/state` 同步尺寸。

管理界面保存配置时以现有配置为底**合并**提交，页面上没有的键（如 `host_routes`、`lan_mode`）不会丢失。

## 6. 更新与备份（三种入口）

1. **平板上（强混淆页面内）**：设置应用 →「系统维护」卡片：
   - **立即更新**：POST 挂载点同源接口 `sys/update`，刷新 HTML 内 `?v=` 版本号，平板下次打开自动取新文件，无需清缓存。
   - **下载备份**：GET `sys/backup`，把 `novaos2/`、`config.json`、`loader/bridge`、入口脚本打包为带时间戳的 zip 下载到平板本机。
   （管理端口只绑 127.0.0.1，平板访问不到，所以这两个功能特意挂在同源挂载点。）
2. **电脑管理界面**：更新/备份按钮，走 `127.0.0.1:8899` 的 `/api/update`、`/api/backup`。
3. **命令行**：
   - `python tools\nova_update.py`（`--dry-run` 只看不动）
   - `python tools\nova_backup.py [输出目录]`
   - 编译后对应 `nova-update.exe` / `nova-backup.exe`。

## 7. 缓存策略（为什么不用清缓存）

- 入口 HTML（`index/os/nova.html`、`__boot__.js`）：`Cache-Control: no-cache` + `ETag/304`，每次使用前校验，改完即生效，正文仅 KB 级。
- js/css/字体等静态资源：一年长缓存，引用处带 `?v=<文件mtime>`；文件一改，运行一次更新（或管理界面/平板上点「立即更新」）即换新 URL，旧缓存自然淘汰。

## 8. 离线空间（虚拟内部存储）

- 桌面「离线空间」原基于 localStorage（约 5MB 上限），现已升级为 **IndexedDB**：库名 `nova2`，`meta` 存目录与文件元数据，`blobs` 以 Blob 存正文，浏览器配额通常**数百 MB**，设置页用 `navigator.storage.estimate()` 显示真实配额。
- 方法契约不变（`vfs.list/get/put/del/mkdir/rename/clear/usage`，均为 Promise）；首次启动自动把旧 localStorage 数据一次性迁入 IDB（旧键保留），IndexedDB 不可用时自动降级 localStorage。

## 9. 兼容性

- 前端 ES6，兼容华为平板内置 Chrome 99 WebView：不使用 2022+ 语法，不用 `:has()` / `color-mix()`。
- bat 脚本纯 ASCII、无 BOM、不依赖 `chcp`。

## 10. 故障排查

- 服务起不来：先 `nova-setup --check`；53/80 端口必须管理员，热点模式检查 Wi-Fi 网卡与互联网。
- 平板打不开 OS：看电脑 `logs/access.log`（含平板回传的探针打点）；确认连对热点、域名在劫持列表、缓存投毒开关与专栏 manifest 路径。
- 远程浏览器黑屏：确认电脑装有 Chrome/Edge；程序会自动清理残留的 `SingletonLock` 并轮询等待 CDP 端口就绪。
- 断劫持后失联：确认曾成功投毒（`cache_poison` 开且访问过一次），或改用模式 2 直连 `http://电脑IP/__nova__/`。
- 重新编译失败：直接运行 `build_all.bat` 看 Nuitka 输出；不编译也可以，`start.bat` 会自动回退到 Python 源码运行。
