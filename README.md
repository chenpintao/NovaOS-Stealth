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
- **局域网代理模式（模式 2）**：不控热点。**DNS 应答默认开启**——把平板 Wi-Fi 的 DNS 手动设为电脑的局域网 IP，平板照常打开「在线专栏」即可被透明注入（只解析 `hijack_domains` 里列出的平台域名，其余域名照常转发，不影响平板访问其它网站）。`cache_poison`（一年长缓存投毒 / 离线持久化）在模式 2 默认**关闭**，需要时可在管理界面开启。
- **隐蔽唤起**（均可在管理界面开关）：键盘 `Ctrl+Shift+Y`、屏幕角落连点 5 次、网址暗参 `?_o=1`、搜索框输入关键词。

## 2. 目录结构

| 路径 | 说明 |
| --- | --- |
| `novaosd.py` | **总程序入口**（转发到 `novacore.service.main`，兼容内嵌运行时） |
| `server.py` | 旧入口兼容 shim，效果等同 `novaosd.py` |
| `novacore/` | 服务端按功能拆分的 Python 包（见下表） |
| `novelsrc/` | 📚 小说下载后端：19 个中文书源实现 + HTTP 门面（纯 Python） |
| `novel_server.py` | 📚 小说下载后端入口（Flask，按需拉起为子进程） |
| `tools/nova_setup.py` | 安装器：依赖安装、模式切换、环境预检 |
| `tools/nova_update.py` | 更新器：刷新页面静态资源缓存版本号 |
| `tools/nova_backup.py` | 备份器：打包 novaos2 + 配置 + 入口脚本为 zip |
| `novaos2/` | 桌面页面（`index/nova/os.html`、`os.js/css`、`apps/*.js`） |
| `admin/` | 本机管理界面（端口 8899） |
| `loader.js` / `boot-stub.js` / `bridge.js` | 注入引导链：stub 注入 manifest → loader 握手 → bridge 桥接 |
| `config.json` | 全部运行配置（管理界面可改，一般不用手编） |
| `install.bat` / `start.bat` / `stop-hotspot.bat` | 安装 / 启动（自动提权、开热点、防火墙）/ 关热点 |
| `runtime/` | 内嵌便携 Python 3.8 运行时（含全部依赖，`build_runtime.ps1` 生成，不入库） |
| `build_runtime.ps1` | 构建内嵌便携 Python 运行时（Win7/10/11 通用） |
| `build_all.bat` | 一键打包：组装 `dist\TzyOS\` + 自动压缩为 `dist\TzyOS.zip` |
| `apps_repo/` | 预装应用仓库（`*.tzyp` 应用包） |
| `archive/novaos1/` | 旧版 NovaOS 1 整包归档，不再参与运行 |
| `archive/lncrawl/` | 已废弃的 lncrawl / lnoveldl 代码与构建脚本（归档） |

### novacore 模块职责

| 模块 | 职责 |
| --- | --- |
| `paths.py` | 部署路径常量、访问日志 |
| `configutil.py` | 配置加载/保存/校验、`novaos_dir`/`fs_root`/挂载前缀 |
| `netutil.py` | 本机/热点/应答 IP、外部域名解析（防 DNS 回环、带缓存） |
| `dns_service.py` | 迷你 DNS 服务（UDP 53，劫持域名 + 上游转发） |
| `htmlkit.py` | 缓存头、入口 HTML 转换（注入桥接脚本、资源版本号、去统计） |
| `sources.py` | 挂载点应用 API：本地文件/FTP/SMB/外网代取/ping |
| `cdp_browser.py` | CDP headless Chrome 单例：启动、输入回注、JPEG 帧 SSE 推流 |
| `toolkit.py` | 公共工具：`?v=` 版本号刷新、备份 zip 打包 |
| `proxy_app.py` | HTTP 透明代理 + 注入 + 挂载点（含 `/sys/update`、`/sys/backup`） |
| `novel_dl.py` | 📚 小说下载后端：`novel_server.py` 子进程按需拉起 + 流式反代 |
| `admin_app.py` | 本机管理界面 API |
| `service.py` | DNS / HTTP / ADMIN 三线程编排总控 |

## 3. 快速开始

**目标机无需安装任何东西**：解释器与依赖都在随包分发的 `runtime\`（内嵌便携 Python 3.8）。

要求：Windows 7 SP1 / 8.1 / 10 / 11 + Chrome 或 Edge（远程浏览器用，可选）。
Win7 SP1 另需 UCRT 更新 **KB2999226**（多数已随系统更新打过，详见 [BUILD.md](BUILD.md)）。

1. 右键管理员运行 `install.bat`，按提示选模式（1=热点 DNS 劫持 / 2=局域网代理），会自动做环境预检并启动。
   - `install.bat --check`：只做预检（管理员权限、解释器、依赖、Chrome、目录、Win7 UCRT）。
   - `install.bat --mode 1|2`：免交互直接切模式。
2. 之后每次运行 `start.bat`（自动提权、开防火墙、起服务）：模式 1 会自动开热点；模式 2 用 `start.bat /nohotspot`。
3. 平板接入：
   - 模式 1：连电脑热点，照常打开「在线专栏」，用暗号唤起。
   - 模式 2：把平板当前 Wi-Fi 的 **DNS 手动设为电脑的局域网 IP**（启动时会打印，如 `192.168.1.5`），再照常打开「在线专栏」——无需输入任何自定义网址。若关掉 DNS 应答，也可直接访问 `http://电脑IP/__nova__/`。
4. 管理：电脑浏览器开 <http://127.0.0.1:8899/>。

停止服务后用 `stop-hotspot.bat` 关闭电脑热点。

> 开发机源码调试：先 `python tools\nova_setup.py --deps` 装依赖，再 `python novaosd.py`。
> 打包分发见 [BUILD.md](BUILD.md)：`build_runtime.ps1` 生成运行时，`build_all.bat` 一键出 `dist\TzyOS.zip`。

## 4. 打包分发（源码 + 内嵌运行时，全平台通用）

不编译、不混淆，**Win7 / Win10 / Win11 共用一个包**：

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File build_runtime.ps1   :: 首次生成 runtime\（约 40MB）
build_all.bat                                                          :: 组装 + 自动压缩
```

产物：

| 产物 | 说明 |
| --- | --- |
| `dist\TzyOS\` | 部署目录（源码 + `novaos2/` + `runtime/`，拷到目标机即可运行） |
| `dist\TzyOS.zip` | 压缩包（Optimal，约 15MB），含包内冒烟自检通过的完整运行环境 |

`build_all.bat` 在压缩前会用**包内**运行时导入 `novacore.service` / `novelsrc.facade` 与全部
第三方库做冒烟自检，不通过则中止，确保出包可用。`install.bat` / `start.bat` 会优先使用
`runtime\python\python.exe`，找不到时才回退系统 `python`。

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

1. **平板上**：设置应用 →「系统维护」卡片：
   - **立即更新**：POST 挂载点同源接口 `sys/update`，刷新 HTML 内 `?v=` 版本号，平板下次打开自动取新文件，无需清缓存。
   - **下载备份**：GET `sys/backup`，把 `novaos2/`、`config.json`、`loader/bridge`、入口脚本打包为带时间戳的 zip 下载到平板本机。
   （管理端口只绑 127.0.0.1，平板访问不到，所以这两个功能特意挂在同源挂载点。）
2. **电脑管理界面**：更新/备份按钮，走 `127.0.0.1:8899` 的 `/api/update`、`/api/backup`。
3. **命令行**：用包内解释器（或系统 Python）执行
   - `runtime\python\python.exe tools\nova_update.py`（`--dry-run` 只看不动）
   - `runtime\python\python.exe tools\nova_backup.py [输出目录]`

## 7. 缓存策略（为什么不用清缓存）

- 入口 HTML（`index/os/nova.html`、`__boot__.js`）：`Cache-Control: no-cache` + `ETag/304`，每次使用前校验，改完即生效，正文仅 KB 级。
- js/css/字体等静态资源：一年长缓存，引用处带 `?v=<文件mtime>`；文件一改，运行一次更新（或管理界面/平板上点「立即更新」）即换新 URL，旧缓存自然淘汰。

## 8. 离线空间（虚拟内部存储）

- 桌面「离线空间」原基于 localStorage（约 5MB 上限），现已升级为 **IndexedDB**：库名 `nova2`，`meta` 存目录与文件元数据，`blobs` 以 Blob 存正文，浏览器配额通常**数百 MB**，设置页用 `navigator.storage.estimate()` 显示真实配额。
- 方法契约不变（`vfs.list/get/put/del/mkdir/rename/clear/usage`，均为 Promise）；首次启动自动把旧 localStorage 数据一次性迁入 IDB（旧键保留），IndexedDB 不可用时自动降级 localStorage。

## 9. 兼容性

- 前端 ES6，兼容华为平板内置 Chrome 99 WebView：不使用 2022+ 语法，不用 `:has()` / `color-mix()`。
- 后端纯 Python 3.8，Win7 SP1 / 8.1 / 10 / 11 通用（Win7 需 UCRT 更新 KB2999226）。
- bat 脚本纯 ASCII、无 BOM、不依赖 `chcp`。

## 10. 故障排查

- 服务起不来：先 `install.bat --check`；53/80 端口必须管理员，热点模式检查 Wi-Fi 网卡与互联网。
- 平板打不开 OS：看电脑 `logs/access.log`（含平板回传的探针打点）；确认连对热点、域名在劫持列表、缓存投毒开关与专栏 manifest 路径。
- 远程浏览器黑屏：确认电脑装有 Chrome/Edge；程序会自动清理残留的 `SingletonLock` 并轮询等待 CDP 端口就绪。
- 断劫持后失联：确认曾成功投毒（`cache_poison` 开且访问过一次），或改用模式 2 直连 `http://电脑IP/__nova__/`。
- Win7 报缺 `api-ms-win-crt-*.dll`：装 UCRT 更新 KB2999226。
- 重新打包失败：直接运行 `build_all.bat` 看输出；`runtime\` 缺失时它会先调 `build_runtime.ps1` 重建。
