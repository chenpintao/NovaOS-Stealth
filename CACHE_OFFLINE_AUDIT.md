# TzyOS / NovaOS 缓存、离线与看门狗自愈审查

审查日期：2026-10-27
范围：注入引导链（`boot-stub.js` / `loader.js` / `bridge.js`）、`novaos2` 内核与内置应用、`novacore` HTTP 层、托管静态站（`lib/*`）、应用包（`.tzyp`）与落盘副本（`apps_data/*`）、离线空间（IndexedDB VFS）。
目标：逐层核实 5 类问题 —— **缓存失效、离线、错误副本缓存、缓存后冲突、离线完整性**，给出每个软件的应对方法；并落实“每次联网刷新看门狗缓存、看门狗不可被清理、OS 可重新拉取”的原则，同时标注 WebView / 宿主页面刷新重载带来的局限。

---

## 0. 结论摘要

| 层 | 缓存失效 | 离线 | 错误副本 | 缓存后冲突 | 离线完整性 | 结论 |
|---|---|---|---|---|---|---|
| 看门狗快照 `__boot__.snapshot.js` | 长缓存 + 每次联网 `reload` | 磁盘直读，零请求 | `r.ok` 校验 + 每小时/联网重刷 | 无（长缓存独占键） | 唯一兜底，**永不清理** | ✅ 已加固 |
| loader `__boot__.js`（注入本体） | `no-cache` + ETag/304 | 走快照 | `onerror`/内容校验回落快照 | 无 | 可变 | ✅ |
| OS 入口 `nova.html` | `max-age=60` + ETag | 60s 内磁盘可启 | 换名 `nova.html` 零清缓存升级 | 允许回源 | 可重新拉取 | ✅ |
| OS 运行时 `os.js` / `apps/*.js` | `?v=mtime` 长缓存 | 预取写盘 | 排障重建 / 强制刷新 | 版本号刷新解决 | 可重建 | ✅ |
| 托管静态站 `lib/*`（phi/geogebra/mojuan...） | 1 天 + ETag（不再钉死一年） | 预取 | 上游 hash URL 会被钉死 → 已改条件请求 | **历史坑**：坏副本白屏 | 自愈最迟 1 天 | ⚠️ 见 §4 |
| 应用落盘副本 `apps_data/*` | 60s/1 天 + ETag | 磁盘可读 | 可从 VFS 重写自愈 | 安装覆盖 | 可重建 | ✅ |
| 离线空间 VFS / IndexedDB | 不适用（用户数据） | 原生离线 | 不适用 | 重命名静默覆盖 | 定期维护 + 备份 | ⚠️ 见 §6 |
| 平台页面（宿主） | 投毒一年（可关） | 无（宿主非本系统） | 注入即可反向控制 | 无关 | 不涉及 | ✅ |

**本次代码改动**（对应“每次联网刷新看门狗缓存、看门狗不被清理”）：

- `boot-stub.js`：新增 `warmSnapshot()`，在 `online` / `visibilitychange` / `pageshow` 各补刷一次；`online` 触发跳过节流强制刷新，其余按 10 分钟节流。首屏 2.5s 仍预热一次。
- `loader.js`：在 `online` 事件里新增 `warmWatchdogSnapshot()`，对父页面分区的快照再做一次 `cache:"reload"` 刷新（双保险），并保留原有看门狗重置。

---

## 1. 五类问题的定义与本项目映射

| 术语 | 本项目的具体表现 | 主要受影响组件 |
|---|---|---|
| **缓存失效** | 更新代码后设备仍跑旧 `os.js` / 旧应用 / 旧快照 | `?v=` 版本号、ETag、`cache_poison` |
| **离线** | 无热点/无电脑服务，或劫持断了只有磁盘缓存 | snapshot、`max-age`、预取、VFS |
| **错误副本缓存** | 某次返回 404/半截/错误页，被浏览器长期钉死（白屏） | 长缓存资源，尤其 `lib/*` 上游写死 URL |
| **缓存后冲突** | 新副本与旧副本并存、同类两份、`?t=` 重试键污染 | 看门狗重试键、入口换名、`?v=` |
| **离线完整性** | 断网后并非所有依赖都齐（缺一个 lib 就白屏） | `__filelist__.json` + 预取 pump |

---

## 2. 引导链与“看门狗”职责

```
宿主页面（平台页面）
  └─ boot-stub 注入（manifest 最前）── 恒定内容，只替换 __BOOT_BASE__
        ├─ 在线：加载 __boot__.js（no-cache+ETag）→ loader + 最新配置
        └─ 失败/离线：加载 __boot__.snapshot.js（长缓存，磁盘直读）
  └─ loader.js（父页面）
        ├─ 触发口令 → 建 closed ShadowRoot + iframe
        ├─ iframe 看门狗：8s 未 nva-ready 则 cache-bust 重建（最多 3 次）
        ├─ 息屏恢复 / bfcache / online → 重建或重置看门狗
        └─ online →【本次新增】刷新 __boot__.snapshot.js
  └─ iframe: nova.html → bridge.js（握手/nva-ready/封禁 SW/预取）→ os.js
```

**关键区分（用户要求）**：这里的“看门狗”= **`__boot__.snapshot.js` 这份长缓存快照**，它是断劫持/断网后唯一能把系统拉起来的凭据。

- **看门狗绝不能丢**：它必须始终以长缓存留在磁盘；被清掉等于永久失去离线唤起能力。
- **OS 本体无所谓**：`nova.html` / `os.js` / `apps/*` 坏了可以联网重新拉取（版本号 + 强制刷新 + 应用重建），不需要也不应该把 OS 也做成“永不失效”。

### 2.1 每次联网刷新看门狗（本次落地）

| 触发点 | 行为 | 代码 |
|---|---|---|
| 首屏 head() | 2.5s 后预热一次 | `boot-stub.js` `setTimeout(warmSnapshot,2500)` |
| `window online` | **强制刷新**（跳过节流） | `boot-stub.js` + `loader.js` |
| `visibilitychange`（转前台） | 节流刷新 | `boot-stub.js` |
| `pageshow`（bfcache） | 节流刷新 | `boot-stub.js` |

刷新用 `fetch(url,{cache:"reload"})`，强制回源并写入磁盘缓存，`r.ok` 为真才更新打点时间戳；404/半截响应不记成功，下次继续补。

> **上线注意（部署约束）**：stub 是被 `proxy_app` 在**请求时**读文件、替换 `__BOOT_BASE__` 后内联进 `manifest.build.*` 响应的。而平台 manifest 已被投毒缓存一年，已缓存旧 stub 的设备**不会**自动获得新版 stub 里的 `online→刷新` 逻辑。因此本次改动：
> - 对**新设备 / manifest 已被清 / 首次联网**立即生效；
> - 对**已缓存旧 stub 的老设备**，其自带的“每小时预热”仍能维持快照，但“每次联网强制刷新”要等 manifest 缓存被换掉后才加上。
> 若需老设备尽快获得，可通过维护终端 `cache sys` + 重开（用户主动）或换 manifest 入口文件名（零清缓存升级的既有手法）来推动。

`proxy_app.serve_boot()` 对快照**始终** `apply_long_cache`（一年、去 ETag），且注释明确“不受 `cache_poison` 开关影响”——保证开关关闭时快照仍可离线用。

---

## 3. 逐层：缓存失效 / 离线

### 3.1 宿主平台页面（被劫持页）

- 平台 `manifest.build.*` 被缓存投毒一年（`config.cache_poison`），一旦命中就永不更新。
- **应对**：`boot-stub` 内容恒定，真正逻辑在 `__boot__.js`（no-cache，随时更新），所以“投毒一年”不影响我们迭代——这是最容易踩错的地方：**不要把可变逻辑放进 stub**。
- 离线：宿主页面本身来自平台 CDN，本系统不负责其离线；断网时若宿主页已缓存则壳还在，靠快照拉起 OS。

### 3.2 loader（注入本体）

- `__boot__.js`：`no-cache` + ETag/304，loader 或配置一改立即生效，零正文流量。
- 离线/劫持断：`onerror`、`onload` 后 60ms 校验 `__novaStealth`、1.2s 超时，三重回落快照。
- **局限**：loader 在宿主页面运行，宿主若整页刷新/重载，loader 状态（`shown`、`handshaked`、看门狗计时器）全部丢失，需重新注入、重新握手。见 §7。

### 3.3 OS 入口与运行时

- `nova.html`：`no-cache` 语义用 `public, max-age=60` + ETag 表达（**不能用 `no-cache, max-age=60`，no-cache 会让 max-age 失效导致断网 `ERR_CONNECTION_REFUSED`**）。
- `os.js` / `apps/*.js`：`?v=mtime` 长缓存；`tools/nova_update.py` / `sys/update` 刷新引用版本号。
- 升级零清缓存：入口从 `os.html` 换名到 `nova.html`，绕过已投毒一年的旧文件名。
- **离线**：由 `bridge.js` 的 `bridgePrefetch()` 把 `__filelist__.json` 全量分批写盘；必须**在 iframe 同源分区**执行（Chrome 双键缓存按 (顶级站, 当前帧站) 分区，父页面预取对本 iframe 无效）。

### 3.4 网络探测与离线降级（`os.js` NET）

- 三项状态：`NET.online / NET.base / NET.probed`，空 base 是同源合法值，用 `probed` 而非 base 作缓存哨兵。
- 探测失败：清 base/info，进入 5s 冷却，冷却期 API 直接返回 `OFFLINE`（不空基址重试）。
- 冷却结束允许被动调用重探（即使 WebView 没派发 online）。
- `nva-netbase` 把实际基址回传父页面存 `nova2.frameBase`，供息屏恢复用正确地址重建 iframe（否则回到打不开的劫持域名黑屏）。

---

## 4. 错误副本缓存（最危险的一类）

**机理**：长缓存（一年）+ 去掉 ETag/Last-Modified → 浏览器在新鲜期内绝不回源。只要某一次返回了 404 / 半截 / 上游错误页，它就被永久钉死在磁盘缓存里，**重装应用/重装系统都救不回**（应用包不含这些静态站文件，重装不清浏览器缓存）。

历史事故与现状：

| 资源 | 历史问题 | 现状对策 |
|---|---|---|
| `lib/phigros`（phi） | `script-1.5.9.2.js` 内 `import "./utils/interact.js?v=<手写串>"`，版本号永不变 → 坏副本白屏一年 | 入口/其他资源改 `max-age=60` + 保留 Flask ETag；最迟过期后带 `If-None-Match` 回源，304 或新副本 |
| `lib/mojuan`（墨卷） | 同上，白屏 | 同上 |
| `lib/geogebra` | 白屏 | 同上，另有 `verify/geo_resilience_test.js` |
| `apps_data/*` 落盘副本 | 一年不回源，坏副本长期沿用 | `max-age=60`(html)/`86400`(其余) + ETag 条件请求，最迟 1 天自愈 |

**注意**：`lib/*` 文件保留 Flask 生成的 ETag，**不能**用自定义 ETag 覆盖（协商用 Flask 自身的，覆盖后永远 200 且不一致）。
**看门狗重试键**（`index.html?t=..&r=..`）不投毒、给 `no-cache`，避免与干净键的正式副本长期并存（缓存后冲突）。

**残余风险**：`lib/*` 的“1 天”窗口内仍会沿用坏副本；若上游 URL 完全写死且服务端某次稳定返回错误，最迟 1 天后恢复。若需更快，可在维护终端 `appreset asset` 从 VFS 重写落盘副本。

---

## 5. 缓存后冲突

| 场景 | 冲突表现 | 对策 |
|---|---|---|
| 看门狗重试 `?t=&r=` vs 干净键 | 两份 index.html 并存占用分区 | 重试键 `no-cache` 不投毒 |
| 入口换名 | 旧 `os.html` 与新 `nova.html` 同时可访问 | 新名只走 `nova.html`；旧名保留但不再引导 |
| `?v=mtime` 刷新 | 版本号未变但内容变（罕见，mtime 未更新） | 发布后显式跑 `nova_update.py`；`forcerefresh` 里先 `sys/update` 再带时间戳 reload |
| 应用包重装 | 新包与旧 `apps_data` / VFS 副本并存 | `appreset asset` 从 VFS 重写落盘副本；安装走 VFS 注册表 |
| bfcache 恢复 | 旧 iframe 与旧握手缓存 | `pageshow.persisted` 触发 `recoverOS()` 重建 |

---

## 6. 离线完整性

- **清单**：`__filelist__.json`（`no-cache`），列出 `novaos2` 下全部文件与版本串 `mtime-count`。
- **预取 pump**：`bridge.js` 以 BATCH=6 分批 `fetch(f,{cache:"default"})`，全部成功才记 `__nova_pfv__=version`；有失败则保留旧版本，下次打开继续补抓（弱网中断可自愈）。
- **完整性缺口**：预取未完成时断网，会缺文件 → 白屏。应对：`bridge` 在 `navigator.onLine===false` 时跳过；ES 弱网下分批轻间隔；终端 `forcerefresh` / 重开补抓。
- **VFS**：IndexedDB 优先、localStorage 约 5MB 降级；`requestStoragePersistence` 争取持久化，`scheduleVfsMaintenance` 周期压缩/迁移。

### 6.1 VFS / IndexedDB 专项（用户数据，非缓存）

| 风险 | 说明 | 对策 |
|---|---|---|
| 重命名静默覆盖 | `rename` 未检查目标已存在，直接覆盖元数据+Blob（见 `SYSTEM_AUDIT.md` P2-2） | 应用层确认；后端事务内检测 |
| 存储被系统回收 | WebView 清理站点数据会连带清 VFS 与快照 | 定期备份到电脑（`sys/vfs-begin/push/commit`） |
| 持久化未授予 | 部分 WebView 仅在站点长期使用后才给 persistence | 后端恢复在线时再申请（`requestStoragePersistence("backend-online")`） |

---

## 7. WebView 环境局限 & 宿主页面刷新/重载

这是本系统最容易被忽略、也最影响“缓存与离线”结论的部分。

### 7.1 WebView 局限

| 局限 | 后果 | 应对（已在代码中） |
|---|---|---|
| **不派发 `online`/`offline`** | 网络恢复后看门狗/探测不触发 | `NET` 冷却到期被动重探；loader `online` 只是加分项，不依赖 |
| **白名单未开站点不会给 persistence** | VFS/快照可能被清 | 后端在线时反复申请；备份到电脑 |
| **`display:none` 冻结 iframe** | 返回黑屏 | `hide()` 用 `opacity:0 + pointerEvents:none`，保持挂载 |
| **后台挂起可见 iframe** | 旧握手失效、黑屏 | 息屏 ≥60s 走 `recoverOS()`；短息屏 `poke("resume")` + 重挂看门狗 |
| **bfcache 恢复不触发 visibilitychange** | 卡在旧运行时 | `pageshow.persisted` 强制 `recoverOS()` |
| **老内核延迟解析 `display:none` iframe** | 首次白屏 | 创建即可见，显隐在 host 上控制 |
| **`cache:"reload"` 在部分内核语义弱** | 快照刷新可能命中旧副本 | 依赖 ETag/长期新鲜期；联网多次重试 |
| **主线程被宿主占满** | 任何点击/定时器都停摆 | 无解，需系统级刷新（恢复按钮也点不动） |

### 7.2 宿主页面刷新 / 重载的影响

宿主页面（平台页）一旦 `reload` 或被框架整页重绘：

1. **loader 全部状态丢失**：`frame/host/root` 引用、`shown`、`handshaked`、`osReady`、`reloads`、看门狗计时器全部清零；iframe 被销毁。
2. **`window.__novaStealth` 标记随页面消失**，新页面重新注入、重新走 `head()`。
3. **激活状态不丢**：存在宿主 `localStorage`（按 `serveOrigin+mount` 隔离），重载后仍已激活。
4. **看门狗快照不丢**：它在 HTTP 磁盘缓存里，与页面生命周期无关——**这正是要求“每次联网刷新、永不清理”的意义**：重载后 `head()` 再次尝试网络，失败仍能读快照拉起。
5. **`frameBase` 需要重建**：iframe 与宿主不同源，父页面只能经 `localStorage`（`nova2.frameBase`）保存直连基址；重载后据此选择正确地址，避免回到已断的劫持域名。
6. **口令触发的回车/软键盘“搜索”键**：`justArmed()`（8s）内拦截 `submit`/`Enter`，防止刚弹出的 iframe 随旧页面提交跳转消失。
7. **框架重绘清空 `body`**：`guardFrame()` 用 MutationObserver 仅监听 `documentElement`/`body` 的直接子节点增删，把 host 挂回，**绝不重建 iframe**，避免“摘除-挂回”拉锯导致每 250ms 闪一次。

**结论**：宿主刷新会“重置运行时”，但**不会破坏离线能力**——前提是看门狗快照始终在磁盘且新鲜。本次“每次联网刷新”正是为此服务。

---

## 8. 每个软件的应对方法（操作手册）

> 路径：维护终端 / 浏览器控制台 / 电脑端执行 `OS.api` 命令。

### 8.1 OS 内核（`nova.html` / `os.js` / 内置应用）

| 场景 | 应对 |
|---|---|
| 更新后仍是旧界面 | `forcerefresh`（先 `sys/update` 刷 `?v=`，再带时间戳 reload）；或 `cache sys` 清 SW/CacheStorage |
| 白屏/锁屏卡死 | 看门狗 8s 自动重建（≤3 次）；仍不行点右上角透明恢复按钮（宿主 DOM 守护，重绘自动挂回） |
| 换网段/IP 后连不上电脑 | `netreset`（清后端地址记忆并重探） |
| 配置错乱 | `sysreset`（默认 `keep=apps,vfs,pin,ui`，保留软件与个人文件） |

### 8.2 托管静态站（phi / geogebra / mojuan / quickdraw）

| 场景 | 应对 |
|---|---|
| 白屏、样式/组件丢失 | 等待 `lib/*` 的 1 天 ETag 自愈；急用则维护终端 `cache sys` 后重开；或 `appreset asset id=<应用>` |
| 上游写死 URL 坏副本 | 服务端已改条件请求；若稳定坏，手动清该 URL 缓存（浏览器 DevTools → Application → Cache） |
| 离线不可用 | 确认 `__filelist__.json` 预取完成（联网后首屏 1.2s 启动预取）；断网前不要强杀 |

### 8.3 应用包（`.tzyp`）/ 落盘副本（`apps_data`）

| 场景 | 应对 |
|---|---|
| 应用损坏 | `appreset id=<id>`（从 VFS 重新加载）；`open:true` 可直接重开 |
| 落盘副本与 VFS 不一致 | `appreset asset id=<id>`（从 VFS 重写电脑端副本） |
| 版本旧 | 应用商店升级；或 `forcerefresh` |

### 8.4 离线空间 VFS / 个人文件

| 场景 | 应对 |
|---|---|
| 担心被 WebView 清理 | 定期 `sys/vfs-begin → push → commit` 备份到电脑；电脑端 `sys/restore-catalog` 恢复 |
| 重命名覆盖 | 应用层确认后再操作（已知风险，见 SYSTEM_AUDIT P2-2） |
| IndexedDB 不可用 | 自动降级 localStorage（约 5MB）；尽量保持站点持久化授权 |

### 8.5 注入链 / 看门狗（运维）

| 场景 | 应对 |
|---|---|
| 改 loader/配置 | 离线改快照 + 重开，或电脑端 `POST /__nova__/sys/update` |
| 断劫持后起不来 | 检查磁盘是否有 `__boot__.snapshot.js`（一年长缓存）；**这是唯一兜底，禁止被清** |
| 联网后想确保兜底新鲜 | 本次改动已自动：`online` → 强制 `reload` 快照 |
| 发布静态资源 | 必须跑 `tools/nova_update.py`（或 `sys/update`）刷新 `?v=`，否则旧版本号钉死 |

---

## 9. 验证清单

- [ ] `python3 -c "import esprima;esprima.parseScript(open('boot-stub.js').read());esprima.parseScript(open('loader.js').read())"`（本次已通过）
- [ ] 联网状态下 DevTools Network 观察 `__boot__.snapshot.js` 在 `online` 事件后出现一次 `reload` 请求（状态 200）
- [ ] 断网后重开宿主页面 → 仍能从快照进入 OS（`verify/geo_offline_test.js` 可复用思路）
- [ ] 宿主页面 `location.reload()` 后 → 已激活状态保留、看门狗自动重建、`frameBase` 正确
- [ ] `forcerefresh` 后 `os.js?v=` 变化且界面更新
- [ ] 弱网中断预取 → 下次联网继续补抓（`__nova_pfv__` 未更新）

---

## 10. 设计原则（供后续修改遵循）

1. **看门狗快照是“唯一不可丢”的缓存**：长缓存、每次联网刷新、任何开关都不得使其变 `no-store`。
2. **OS 本体可以重拉**：入口/运行时不追求长期不回源，改用受控 `max-age + ETag`，让坏副本能自愈。
3. **可变逻辑绝不放 stub**：stub 内容恒定，避免被投毒一年后无法迭代。
4. **预取必须在 iframe 同源分区**：Chrome 双键缓存按 (顶级站, 当前帧站) 分区。
5. **重试键不投毒**：`?t=&r=` 一次性绕缓存，绝不长缓存，避免缓存后冲突。
6. **WebView 不可信事件**：不依赖 `online`，靠冷却到期被动重探 + 快照兜底。
7. **主线程被占满时恢复按钮也无效**：这是硬边界，需系统级刷新。
