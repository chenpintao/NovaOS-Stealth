# BUILD.md · Tzy OS 构建与打包说明

Tzy OS 采用 **「源码 + 内嵌便携 Python 3.8」** 的统一分发方案：
**不编译、不混淆**，Win7 / Win10 / Win11 共用同一个包，目标机**无需安装 Python**。

Loshop & Cpt

---

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| 构建机 | Windows 10 / 11（仅打包时需要；Wi-Fi 热点模式运行需带无线网卡） |
| 构建机 Python | 任意 3.8+（仅用于跑打包脚本可选的预检，**不用于运行**） |
| 目标机 | Windows 7 SP1 / 8.1 / 10 / 11，**无需安装 Python** |
| Chrome | 目标机已装 Google Chrome 或 Edge（仅「远程浏览器」应用需要，用于 headless CDP） |
| 权限 | 模式 1（DNS 劫持 53 端口、80 端口、开热点）必须管理员；模式 2 局域网模式可用高端口 |
| 磁盘 | 源码约 8MB；含 runtime 的完整包解压后约 40MB，zip 约 15MB |

> 说明：仓库里 `runtime/`（约 40MB）不入库，由 `build_runtime.ps1` 生成；
> `dist/`（打包产物）同样不入库。

## 2. 为什么用 Python 3.8 + 内嵌运行时

- **Python 3.8 是最后一个支持 Windows 7 的版本**，因此统一选 3.8，Win7/10/11 一份通吃。
- 官方 **embed zip**（`python-3.8.10-embed-amd64.zip`）只有几 MB，解压即用，配一个
  `python38._pth` 打开 `import site` 即可安装第三方库到 `Lib\site-packages\`。
- 不再使用 Nuitka：无需 MinGW/zig 工具链、无需 2GB 磁盘、构建从「十几分钟」降到「几分钟」，
  包体也从数百 MB 降到十几 MB。**代码以源码形式分发**（本项目接受这一取舍）。

### Windows 7 前置条件：UCRT（KB2999226）

Python 3.8 依赖 **Windows 通用 C 运行时（UCRT）**。Win10/11 自带；**Win7 SP1 需要**
微软更新 **KB2999226**（多数已随 Windows Update 打过）。若目标机缺 UCRT，
`runtime\python\python.exe` 会报缺少 `api-ms-win-crt-runtime-l1-1-0.dll`，装一次
KB2999226 即可。安装器预检也会提示：

```bat
install.bat --check
:: [i] Windows 7 detected : requires UCRT update KB2999226 (see BUILD.md)
:: [i] UCRT present       : YES / NO - install KB2999226
```

## 3. 构建步骤（一键）

```bat
:: 1) 首次：联网构建内嵌运行时（下载 embed + pip 安装依赖，产物 runtime\，约 40MB）
::    已存在时自动跳过；强制重建加 -Force
powershell -NoProfile -ExecutionPolicy Bypass -File build_runtime.ps1

:: 2) 组装部署目录 + 自动压缩为 zip
build_all.bat
```

`build_all.bat` 做的事：

1. 检查 `runtime\python\python.exe`，缺失则调用 `build_runtime.ps1`；
2. 组装 `dist\TzyOS\`（复制源码 + 页面 + 运行时，剔除 `__pycache__/*.pyc/*.log`）；
3. **包内冒烟自检**：用包内运行时导入 `novacore.service` / `novelsrc.facade` 与全部第三方库；
4. 用 .NET `ZipFile`（Optimal）压缩为 `dist\TzyOS.zip`（不含顶层目录）。

产物：

```
dist\TzyOS\        部署目录（拷到目标机即可运行）
dist\TzyOS.zip     压缩包（约 15MB，便于传输）
```

`build_all.bat /nort` 可跳过运行时检查（runtime 已就绪、只想重打包时）。

### runtime 里装了什么

`build_runtime.ps1` 以固定版本安装（`--no-compile` 不生成 `__pycache__`，随后再精简掉
pip/setuptools、头文件、测试数据，最终约 40MB）：

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| flask / werkzeug / jinja2 | 3.0.3 / 3.0.6 / 3.1.6 | `novel_server.py` HTTP 后端 |
| requests / urllib3 / certifi / idna / charset-normalizer | 2.32.4 … | 抓取书源（含 GBK 嗅探） |
| websocket-client | 1.8.0 | CDP 远程浏览器 |
| beautifulsoup4 / soupsieve / lxml | 4.15.0 / 5.4.0 | HTML 解析 |
| pycryptodome / cryptography / cffi | 3.24.0 / 47.0.0 | 加密书源解密 |
| ebooklib / six | 0.20 / 1.17.0 | EPUB 导出 |

## 4. 包内目录（数据文件同样进包，便于热更）

```
TzyOS\
├─ runtime\python\python.exe   内嵌便携 Python 3.8（含全部依赖）
├─ novaosd.py                  总入口（DNS+HTTP+CDP+管理）
├─ server.py                   旧入口兼容 shim
├─ novel_server.py             📚 小说下载后端（Flask，按需被子进程拉起）
├─ novacore\                   服务端功能包
├─ novelsrc\                   19 个中文书源实现 + HTTP 门面
├─ novaos2\                    平板桌面页面（os.js + apps\*.js）
├─ admin\                      本机管理界面（127.0.0.1:8899）
├─ apps_repo\                  预装应用仓库（*.tzyp）
├─ tools\                      setup / update / backup 三个 CLI
├─ loader.js / boot-stub.js / bridge.js   注入引导链
├─ config.json                 运行配置
├─ install.bat / start.bat / stop-hotspot.bat   安装 / 启动 / 关热点
└─ enable-hotspot.ps1 / disable-hotspot.ps1 / set-hotspot-credentials.ps1
```

## 5. 部署到目标电脑

1. 解压 `TzyOS.zip` 到任意目录（注意：**不要放在中文/需要管理员权限保护的系统目录**）。
2. 管理员运行 `install.bat`（首次，选模式 1 热点 DNS 劫持 / 模式 2 局域网），
   或直接 `install.bat --mode 2` 免交互。
3. 之后每次运行 `start.bat`（自动提权、开防火墙 UDP 53 / TCP 80、起服务）：
   模式 1 会自动开热点；模式 2 用 `start.bat /nohotspot`。
4. 平板接入：
   - 模式 1：连电脑热点 → 照常打开专栏页 → 暗号唤起。
   - 模式 2：把平板 Wi-Fi 的 **DNS 手动设为电脑的局域网 IP**（启动时打印），
     再照常打开专栏页即可（无需输入自定义网址）；若关掉 DNS 应答，也可直接开
     `http://电脑IP/__nova__/`。
5. 电脑本机管理：<http://127.0.0.1:8899/>。

### 两种运行模式对照

| 项 | 模式 1（热点 DNS 劫持） | 模式 2（局域网） |
| --- | --- | --- |
| `lan_mode` | false | true |
| 电脑热点 | 自动开（`start.bat`） | 不开（`start.bat /nohotspot`） |
| `dns_enable` | true | **true**（默认开） |
| `cache_poison` | true（断劫持后仍可离线唤起） | **false**（默认关，避免污染其它站点缓存） |
| DNS 绑定 | 精确绑热点网关 IP（压过 ICS 通配占用） | 通配 `0.0.0.0:53`，秒级就绪 |
| 平板接入 | 连热点，正常打开专栏页 | 平板 Wi-Fi DNS 手动指向电脑 IP，正常打开专栏页 |
| DNS 解析范围 | 仅劫持 `hijack_domains`，其余转发上游 | 同左（只解析列表内域名，其余照常转发） |

以上四项均可在管理界面 <http://127.0.0.1:8899/> 随时改动（`lan_mode` 不在界面上，
由 `install.bat` 模式选择写入）。

> 目标机**无需安装 Python、无需联网装依赖**：解释器与依赖都在 `runtime\` 内。
> `install.bat` / `start.bat` 会自动优先使用 `runtime\python\python.exe`，
> 找不到时才回退系统 `python`（开发机源码调试场景）。

## 6. 改完代码/页面后怎么更新

| 改了什么 | 操作 |
| --- | --- |
| `novacore/**`、`novelsrc/**`、`novaosd.py`、`tools/**`（Python） | 直接替换部署目录里的对应 `.py`（**无需重新打包**，纯源码分发） |
| `novaos2/**`（js/css/页面）、`admin/`、注入脚本 | 运行 `tools\nova_update.py --dry-run` 或管理界面/平板「立即更新」，按 mtime 刷新 HTML 里的 `?v=` 版本号，平板下次打开自动取新文件 |
| `runtime\` 依赖变更 | 改 `build_runtime.ps1` 的 pin 列表后 `-Force` 重建，重新打包 |

缓存策略：入口 HTML 为 `no-cache + ETag`（改完即生效）；js/css 一年长缓存，靠 `?v=<mtime>` 换 URL 失效。

## 7. 小说下载后端（novelsrc）

- 纯 Python 实现，**19 个中文书源**，进程内聚合搜索（8 并发 + 25s 硬时限，超时返回已到结果）。
- 后端入口 `novel_server.py`（Flask），由 `novacore/novel_dl.py` 在第一个
  `/__nova__/novel/*` 请求时按需拉起，再由代理流式反代给平板。
- 接口：`/novel/api/healthz|meta|version|search|books/detail|chapter-content|download-tasks|download-file`。
- 导出文件写到 `novel_exports/`，经 `download-file` 下发给平板。
- **英文/多语种轻小说（lncrawl）已整体归档**至 `archive/lncrawl/`，不再随包分发。

## 8. 备份与恢复

```bat
install.bat --deps            :: 只装依赖（有内嵌 runtime 时会跳过）
tools\nova_backup.py D:\backups
```

zip 内含 `novaos2/`、`novacore/`、`novelsrc/`、`tools/`、`config.json`、注入脚本、bat/ps1、README/BUILD；
不含 `logs/`、`dist/`、`runtime/`、`archive/`。
平板端也可在 设置 → 系统维护 → 下载备份（走同源 `sys/backup` 端点）。

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| Win7 双击 `python.exe` 报缺 `api-ms-win-crt-*.dll` | 安装 UCRT 更新 **KB2999226**（见第 2 节） |
| `ModuleNotFoundError: novacore` | 用 `runtime\python\python.exe novaosd.py` 或 `start.bat` 启动；入口已自动把脚本目录加入 `sys.path` |
| 包内 imports 失败 | 重新跑 `build_runtime.ps1 -Force`，看第 6 步验证输出 |
| 服务起不来（53/80 占用） | 管理员运行；检查 IIS / 其他 Web 服务；`netstat -ano | findstr :53` 找占用 |
| 远程浏览器不开 | 确认装了 Chrome/Edge；程序自动按版本选择 `--headless=new`(≥112) 或 `--headless`，绝不在电脑弹窗 |
| 平板页面没更新 | 跑一次「立即更新」；确认改的是部署目录里的 `novaos2/` 而非源码目录 |
| 小说搜索很慢 | 个别书源不可达时会等到 25s 硬时限才返回，属预期；多数情况 1~5s |

## 10. 目录速查

```
build_runtime.ps1     构建内嵌便携 Python 3.8 运行时（runtime\，约 40MB，不入库）
build_all.bat         组装 dist\TzyOS\ + 自动压缩为 dist\TzyOS.zip
novaosd.py            总入口（转发 novacore.service.main）
server.py             旧入口兼容 shim
novel_server.py       📚 小说下载后端入口（Flask，子进程）
novacore/             服务端功能包（config/net/dns/htmlkit/sources/cdp/toolkit/novel_dl/...）
novelsrc/             19 个中文书源 + facade + http 客户端
tools/                setup / update / backup 三个 CLI
novaos2/              平板 OS 页面与应用
admin/                127.0.0.1:8899 管理界面
apps_repo/            预装应用仓库（*.tzyp）
runtime/              内嵌便携 Python 3.8（build_runtime.ps1 生成，不入库）
install.bat/start.bat 安装与启动（优先 runtime，回退系统 Python）
archive/novaos1/      旧版 NovaOS 1 归档（不参与运行与打包）
archive/lncrawl/      已废弃的 lncrawl / lnoveldl 相关代码与运行时构建脚本（归档）
```