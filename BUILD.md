# BUILD.md · Tzy OS 构建与打包说明

本文档说明如何从源码运行 Tzy OS，以及如何用 Nuitka 把各功能编译成**强混淆单文件 exe**。

Loshop & Cpt

---

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11（热点模式需带 Wi-Fi 网卡） |
| Python | 3.9 或更高（开发验证：3.13，安装时勾选 *Add python to PATH*） |
| Chrome | 本机已装 Google Chrome 或 Edge（仅「远程浏览器」应用需要，用于 headless CDP） |
| 磁盘 | 源码约 20MB；首次编译需约 2GB（Nuitka + MinGW/zig 工具链缓存） |
| 权限 | 模式 1（DNS 劫持 53 端口、80 端口、开热点）必须管理员；模式 2 可普通权限 + 高端口 |

依赖见 [requirements.txt](requirements.txt)：`flask`、`requests`、`websocket-client`（CDP）。

## 2. 直接从源码运行（开发/调试）

```bat
:: 1) 安装依赖并选择模式（1=热点DNS劫持，2=局域网直连），同时做环境预检
python tools\nova_setup.py

:: 2) 启动总服务（DNS + HTTP 注入代理 + CDP + 管理界面）
python novaosd.py
```

非交互方式：

```bat
python tools\nova_setup.py --deps            :: 只装依赖
python tools\nova_setup.py --check           :: 只做环境预检（管理员/依赖/Chrome/目录）
python tools\nova_setup.py --mode 2          :: 直接切到局域网模式
```

也可以直接双击 `install.bat`（首次）与 `start.bat`（之后每次）。
`start.bat` 会自动提权、开防火墙规则、创建电脑热点；`start.bat /nohotspot` 跳过热点。

## 3. 编译为单文件 exe（强混淆）

一键构建：

```bat
build_all.bat
```

脚本执行内容：

1. `python -m pip install nuitka`
2. 首次运行自动下载 C 工具链（MinGW64 / zig，`--assume-yes-for-downloads`，需联网，耗时较长）
3. 依次编译 4 个 onefile 目标，`--remove-output` 自动清理中间产物

| 产物 | 入口 | 功能 |
| --- | --- | --- |
| `dist\novaosd.exe` | [novaosd.py](novaosd.py) | 主服务总程序（DNS+HTTP+CDP+管理） |
| `dist\nova-setup.exe` | [tools/nova_setup.py](tools/nova_setup.py) | 安装 / 预检 / 双模式切换 |
| `dist\nova-update.exe` | [tools/nova_update.py](tools/nova_update.py) | 刷新页面资源缓存版本号 |
| `dist\nova-backup.exe` | [tools/nova_backup.py](tools/nova_backup.py) | 打包备份 zip（可加输出目录参数） |

关键 Nuitka 参数：

```
--onefile                       单文件 exe
--include-package=novacore      内置按功能拆分的服务端包
--assume-yes-for-downloads      自动同意下载工具链
--remove-output                 编译后删除中间 build 目录
--output-dir=dist
```

Python 代码被编译为机器码，目标机没有 `.py` 源码。

> 单文件 exe 启动时会把依赖解压到系统临时目录，首次启动稍慢（1~3 秒）属正常。
> 代码里 `paths.app_dir()` 已兼容 Nuitka：frozen 时取 exe 所在目录；exe 旁没有 `config.json` 时退回当前工作目录。

### 单独编译某一个目标

```bat
set PYTHONPATH=%CD%;%PYTHONPATH%
python -m nuitka --onefile --assume-yes-for-downloads --remove-output ^
  --output-dir=dist --include-package=novacore ^
  --output-filename=novaosd.exe novaosd.py
```

## 4. 数据文件不嵌入 exe（刻意设计）

以下文件/目录**不参与编译**，必须与 exe 同级部署，方便不重新编译就热更页面：

```
dist/ 或任意部署目录/
├─ novaosd.exe / nova-setup.exe / nova-update.exe / nova-backup.exe
├─ config.json        运行配置（也可全部走管理界面生成）
├─ novaos2/           平板桌面全部页面（os.js、apps/、lib/ 等）
├─ admin/             本机管理界面
├─ loader.js          注入引导链
├─ boot-stub.js
└─ bridge.js
```

## 5. 部署到目标电脑

1. 新建目录，拷入 4 个 exe + 上表数据文件。
2. 管理员运行 `nova-setup.exe`（或源码方式 `python tools\nova_setup.py`）选模式。
3. 模式 1：配好热点（可用仓库里的 `start.bat` 逻辑 / `enable-hotspot.ps1`），运行 `novaosd.exe`。
4. 平板连热点 → 打开专栏页 → 暗号唤起；模式 2 平板浏览器直接开 `http://电脑IP/__nova__/`。
5. 电脑本机管理：<http://127.0.0.1:8899/>。

`install.bat`、`start.bat` 已做自动选择：存在 `dist\xxx.exe` 时用 exe，否则回退 `python` 源码。

## 6. 改完代码/页面后怎么更新

| 改了什么 | 操作 |
| --- | --- |
| `novacore/**`、`novaosd.py`、`tools/**`（Python） | 重新跑 `build_all.bat`（或单目标编译）后替换 exe |
| `novaos2/**`（js/css/页面）、`admin/`、注入脚本 | **不用重新编译**。运行 `nova-update.exe`（或管理界面/平板设置里点「立即更新」），它会按文件 mtime 刷新 HTML 里的 `?v=` 版本号，平板下次打开自动取新文件 |

缓存策略：入口 HTML 为 `no-cache + ETag`（改完即生效）；js/css 一年长缓存，靠 `?v=<mtime>` 换 URL 失效。

## 7. 备份与恢复

```bat
:: 源码
python tools\nova_backup.py D:\backups

:: 编译后
nova-backup.exe D:\backups
```

zip 内含 `novaos2/`、`novacore/`、`tools/`、`config.json`、注入脚本、全部 bat/ps1、README/BUILD 文档；
不含 `logs/`、`dist/`、`build-dist/`、`archive/`。
平板端也可在 设置 → 系统维护 → 下载备份（走同源 `sys/backup` 端点）。

## 8. 常见构建问题

| 现象 | 处理 |
| --- | --- |
| 首次编译卡在下载工具链 | 网络问题；重跑 `build_all.bat` 会断点续用已下载部分。公司网可先手动装 `pip install nuitka` |
| 杀软报毒 / 删除 exe | Nuitka onefile 自解压行为易被误报；加白名单或改用 `--standalone`（出目录而非单文件） |
| exe 双击一闪而过 | 用命令行启动看报错；多数是同级缺 `config.json` / `novaos2/` |
| `ModuleNotFoundError: novacore` | 编译工具脚本时需仓库根在 PYTHONPATH（`build_all.bat` 已设置），或在根目录执行编译 |
| 服务起不来（53/80 占用） | 管理员运行；检查 IIS / 其他 Web 服务；`netstat -ano | findstr :53` 找占用 |
| 远程浏览器不开 | 确认装了 Chrome/Edge；程序自动按版本选择 `--headless=new`(≥112) 或 `--headless`，绝不在电脑弹窗 |
| 平板页面没更新 | 跑一次「立即更新」；确认改的是部署目录（exe 同级）里的 `novaos2/` 而非源码目录 |

## 9. 目录速查

```
novaosd.py            总入口（5 行转发 novacore.service.main）
server.py             旧入口兼容 shim
novacore/             服务端功能包（config/net/dns/htmlkit/sources/cdp/toolkit/两个 app/service）
tools/                三个分功能 CLI：setup / update / backup
novaos2/              平板 OS 页面与应用（os.js + apps/*.js）
admin/                127.0.0.1:8899 管理界面
build_all.bat         Nuitka 一键构建 4 个单文件 exe
install.bat/start.bat 安装与启动（优先 exe，回退源码）
archive/novaos1/      旧版归档（不参与运行与编译）
```
