/* ============================================================
 * Tzy OS · 维护终端（devterm）
 * 本地诊断与重置入口：缓存/应用/系统状态排查，以及强制刷新、
 * 重建应用等修复动作。命令同时也可由电脑端下发执行。
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "devterm",
    name: "维护终端",
    icon: "⌨️",
    tone: "tone-ink",
    version: "2.0.0",
    maximize: true,
    desktop: true,
    desc: "缓存/应用/系统强制重置与诊断终端。白屏、卡死、换网后打不开时用来救场。",
    open: function (root, OS) { build(root, OS); }
  });

  var HELP = [
    "命令格式：cmd [参数] —— 与电脑 exec 同一路由，全权限执行",
    "",
    "— 诊断 —",
    "  ping                       连通性自检",
    "  info                       系统一览（网络/应用/存储/统计）",
    "  dump                       导出完整快照（含全部 localStorage 键与体积）",
    "  cache keys [前缀]          列出缓存键名（默认全部）",
    "  cache sys [--dry]          列出/清理 Service Worker 与 CacheStorage",
    "  cache idb                  列出 IndexedDB 库（nova2 离线空间、各应用库）",
    "",
    "— 清理 —",
    "  cache get <键>             查看某个键的原始值与体积",
    "  cache del <键>             删除单个键",
    "  cache purge [前缀]         删除指定前缀的键（默认 nova2.，dry 预览）",
    "  cache idb-drop <库名> [force]  删除整个 IndexedDB 库（nova2 需 force）",
    "",
    "— 重置应用 —",
    "  appreset list              列出应用与运行状态",
    "  appreset <id>              重建指定应用（杀窗口+卸节点+清 blob+重载）",
    "  appreset all               重建全部正在运行的应用",
    "  appreset asset <id>        把离线空间副本重写回电脑 apps_data/",
    "",
    "— 看门狗快照 watchdog（离线启动的唯一凭据） —",
    "  watchdog                    同 watchdog status",
    "  watchdog status             快照可达性/HTTP 状态/Cache-Control/上次刷新时间（HEAD 探测，不写缓存）",
    "  watchdog refresh            请宿主父页面立即刷新快照（经 loader 写入“父页面缓存分区”）",
    "                              刷新是后台执行；完成后用 watchdog status 复核 lastRefreshAt/ageSec",
    "  watchdog verify             拉取快照并校验：是合法脚本(js=true)、非 CDN 错误页/半截、看 Cache-Control",
    "  watchdog url                打印当前快照绝对地址（排查分区/端口用）",
    "  用法示例：",
    "    watchdog                    看当前状态",
    "    watchdog refresh            联网后想让离线兜底立刻变新鲜时执行",
    "    watchdog verify             怀疑快照被 CDN 错误页覆盖时校验；非法不会覆盖旧快照",
    "  为何必须由宿主刷新：Chrome 双键缓存按 (顶级站,帧站) 分区，OS 在 iframe 内",
    "  自取快照写不进“启动时用的父页面分区”。本命令默认走 loader 在宿主执行。",
    "  原则：快照必须一年长缓存、每次联网刷新、绝不被清理；OS 本体坏了可 forcerefresh",
    "  重拉，但看门狗丢了就再也起不来。refresh 不删除任何数据，可放心执行。",
    "",
    "— 重置系统 —",
    "  netreset                   清后端地址记忆并重新探测（换网段/IP 必备）",
    "  sysreset [keep=apps,vfs,pin]  关全部应用+清系统配置，默认保留软件与文件",
    "  sysreset wipe              连应用注册表一起清（危险，需二次确认）",
    "  forcerefresh [now=false]   让电脑刷新 ?v= 后强制重载页面",
    "  reload                     仅重载 OS 页面",
    "  reload -all                重置运行实例/监视器/系统配置，保留软件和个人文件",
    "",
    "— 宿主页面 —",
    "  hostpage freeze | thaw     冻结/恢复被劫持的平台页面（省电、防误触）",
    "  hostpage reload            让 loader 重建整个 OS iframe（顶层自愈）",
    "  hostpage hide | show       主动隐藏/显示 OS",
    "",
    "— 其它 —",
    "  app list | app open <id> | app close <id>",
    "  vfs list <路径> | vfs get <路径> | vfs usage | vfs mkdir <路径>",
    "  storage keys | storage get <键> | storage set <键> <值> | storage del <键>",
    "  toast <文字> · lock 锁屏 · dbg on|off 调试日志 · eval <JS>",
    "复合参数可整体给 JSON：cache {\"op\":\"purge\",\"prefix\":\"nova2.\",\"dry\":true}",
    "clear 清屏 · help 本帮助 · 带 «电脑 前缀的行是电脑下发的命令"
  ].join("\n");

  /* 危险命令必须二次确认，避免手滑把离线空间/应用注册表清掉。 */
  var DANGER = [
    { re: /^sysreset\b.*\bwipe\b/, msg: "sysreset wipe 会删除已安装应用注册表，确定继续？" },
    { re: /^cache\s+idb-drop\s+nova2\b/, msg: "删除 nova2 会清空离线空间全部个人文件，确定继续？" },
    { re: /^cache\s+purge\s*$|^cache\s+purge\s+nova2\.$/, msg: "cache purge 会清掉全部 OS 设置（含锁屏 PIN），确定继续？" }
  ];

  /* 命令行解析：首词为 cmd，余文按习惯映射为 args；
   * 整体 JSON 直接采用（与电脑 exec 完全一致的参数结构）。 */
  function parseLine(line) {
    line = String(line || "").trim();
    if (!line) return null;
    var sp = line.indexOf(" ");
    var cmd = sp < 0 ? line : line.slice(0, sp);
    var rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    var args = {};
    if (!rest) return { cmd: cmd, args: args };
    if (cmd === "eval") { args.code = rest; return { cmd: cmd, args: args }; }
    if (rest.charAt(0) === "{") {
      try { return { cmd: cmd, args: JSON.parse(rest) }; } catch (e) { /* 回落 */ }
    }
    function cut(s) {                       // 首词 + 余文
      var i = s.indexOf(" ");
      return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1).trim()];
    }
    if (cmd === "toast") args.msg = rest;
    else if (cmd === "app") {
      var a = cut(rest); args.op = a[0];
      var b = cut(a[1]); args.id = b[0]; if (b[1]) args.arg = b[1];
    } else if (cmd === "vfs") {
      var v = cut(rest); args.op = v[0]; if (v[1]) args.path = v[1];
    } else if (cmd === "storage") {
      var s = cut(rest); args.op = s[0];
      if (args.op === "set") { var k = cut(s[1]); args.key = k[0]; if (k[1]) args.value = k[1]; }
      else if (s[1]) args.key = s[1];
    } else if (cmd === "cache") {
      // cache keys [前缀] / cache get <键> / cache del <键> / cache purge [前缀] [dry]
      // cache sys [dry] / cache idb / cache idb-drop <库名> [force]
      var c = cut(rest); args.op = c[0] || "keys";
      var c2 = cut(c[1]);
      // 词序无关地取前缀与 dry 标记：`purge nova2. dry` 和 `purge dry` 都成立。
      var cwords = c[1].split(/\s+/).filter(Boolean);
      if (args.op === "keys" || args.op === "purge") {
        cwords.forEach(function (w) {
          if (w === "dry" || w === "--dry") args.dry = true;
          else if (w === "force") args.force = true;
          else if (!args.prefix) args.prefix = w;
        });
      } else if (args.op === "get" || args.op === "del") args.key = c2[0];
      else if (args.op === "idb-drop") {
        cwords.forEach(function (w) {
          if (w === "force") args.force = true;
          else if (!args.name) args.name = w;
        });
      } else if (args.op === "sys") { if (cwords[0] === "dry") args.dry = true; }
    } else if (cmd === "appreset") {
      // appreset list | appreset all | appreset <id> [open] | appreset asset <id>
      var ar = cut(rest);
      if (ar[0] === "asset") args = { op: "asset", id: cut(ar[1])[0] };
      else if (!ar[0] || ar[0] === "list") args = { op: "list" };
      else if (ar[0] === "all") args = {};
      else {
        args = { id: ar[0] };
        if (ar[1] === "open") args.open = true;
      }
    } else if (cmd === "hostpage") {
      args.act = cut(rest)[0];
    } else if (cmd === "watchdog") {
      // watchdog status|refresh|verify|url（缺省 status）
      args.op = cut(rest)[0] || "status";
    } else if (cmd === "forcerefresh") {
      if (rest === "now=false" || rest === "stay") args.now = false;
      if (rest === "nobump") args.bump = false;
    } else if (cmd === "sysreset") {
      // sysreset [keep=apps,vfs,pin] [wipe]
      var words = rest.split(/\s+/).filter(Boolean);
      if (rest === "wipe") args.wipe = true;
      else words.forEach(function (w) {
        if (w === "wipe") args.wipe = true;
        else if (w.indexOf("keep=") === 0) args.keep = w.slice(5);
      });
    }
    else args.op = rest;
    return { cmd: cmd, args: args };
  }

  function build(root, OS) {
    var page = OS.h("div", "nv-term");

    /* ---------- 顶部状态条 ---------- */
    var bar = OS.h("div", "nv-term-bar");
    var dot = OS.h("span", "nv-term-dot");
    var stTxt = OS.h("span", "nv-term-st", "…");
    var stTok = OS.h("span", "nv-term-tok");
    var stCnt = OS.h("span", "nv-term-cnt");
    var btnPing = OS.h("button", "nv-btn", "ping");
    var btnInfo = OS.h("button", "nv-btn", "info");
    var btnHelp = OS.h("button", "nv-btn", "帮助");
    var btnClear = OS.h("button", "nv-btn", "清屏");
    bar.appendChild(dot);
    bar.appendChild(stTxt);
    bar.appendChild(stTok);
    bar.appendChild(stCnt);
    bar.appendChild(OS.h("span", "nv-term-gap"));
    bar.appendChild(btnPing);
    bar.appendChild(btnInfo);
    bar.appendChild(btnHelp);
    bar.appendChild(btnClear);

    /* ---------- 快捷修复条（平板上比敲命令快） ---------- */
    var quick = OS.h("div", "nv-term-quick");
    var QUICK = [
      { label: "诊断", cmd: "dump" },
      { label: "列缓存键", cmd: "cache keys" },
      { label: "列应用", cmd: "appreset list" },
      { label: "重建运行中应用", cmd: "appreset all" },
      { label: "重探电脑", cmd: "netreset" },
      { label: "强制刷新", cmd: "forcerefresh" },
      { label: "重置系统", cmd: "sysreset" },
      { label: "冻结宿主", cmd: "hostpage freeze" },
      { label: "解冻宿主", cmd: "hostpage thaw" },
      { label: "重建 OS", cmd: "hostpage reload" }
    ];
    QUICK.forEach(function (q) {
      var b = OS.h("button", "nv-btn nv-term-q", q.label);
      b.addEventListener("click", function () { runLocal(q.cmd); });
      quick.appendChild(b);
    });

    /* ---------- 输出区 ---------- */
    var out = OS.h("div", "nv-term-out");

    /* ---------- 输入行 ---------- */
    var inrow = OS.h("div", "nv-term-in");
    var prompt = OS.h("span", "nv-term-prompt", "❯");
    var inp = document.createElement("input");
    inp.className = "nv-term-input";
    inp.type = "text";
    inp.placeholder = "输入命令，如 ping / info / help";
    inp.autocapitalize = "off";
    inp.autocomplete = "off";
    inp.spellcheck = false;
    var btnRun = OS.h("button", "nv-btn primary", "执行");
    inrow.appendChild(prompt);
    inrow.appendChild(inp);
    inrow.appendChild(btnRun);

    page.appendChild(bar);
    page.appendChild(quick);
    page.appendChild(out);
    page.appendChild(inrow);
    root.appendChild(page);

    /* ---------- 输出辅助 ---------- */
    function ts() {
      var d = new Date();
      function p(n) { return (n < 10 ? "0" : "") + n; }
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }
    function print(cls, text) {
      var ln = OS.h("div", "nv-term-ln " + (cls || ""));
      ln.textContent = text;                    // textContent 直写，防注入
      out.appendChild(ln);
      while (out.childNodes.length > 400) out.removeChild(out.firstChild);
      out.scrollTop = out.scrollHeight;
    }
    // 结果格式化：远端包装 {ok,data,error,ms} 取 data；本地错误对象显 error
    function fmtRes(res) {
      var body = res;
      if (res && typeof res === "object" && "ok" in res && "ms" in res) body = res.data;
      if (body && typeof body === "object" && body.error) return "✗ " + body.error;
      var s;
      try { s = typeof body === "string" ? body : JSON.stringify(body, null, 1); }
      catch (e) { s = String(body); }
      if (typeof s === "undefined" || s === undefined) s = String(body);
      if (s && s.length > 4000) s = s.slice(0, 4000) + "\n…（已截断，共 " + s.length + " 字符）";
      return s;
    }
    function argsStr(a) {
      if (!a) return "";
      var s;
      try { s = JSON.stringify(a); } catch (e) { s = ""; }
      return s && s !== "{}" ? " " + s : "";
    }
    function banner() {
      print("sys", "Tzy OS 维护终端 v2.0 —— 缓存/应用/系统重置与诊断");
      print("sys", "白屏、卡死、换网后打不开：先点「诊断」，再按需「重探电脑 / 重建应用 / 强制刷新」");
      print("sys", "输入 help 查看全部命令；危险操作需再用 confirm 前缀确认一次");
    }

    /* ---------- 本地执行 ---------- */
    function runLocal(line, confirmed) {
      print("in", ts() + " ❯ " + line);
      var p = parseLine(line);
      if (!p) return;
      if (p.cmd === "clear") { out.textContent = ""; banner(); return; }
      if (p.cmd === "help") { print("sys", HELP); return; }
      // 危险命令（清注册表/删离线空间/清全部设置）必须二次确认
      if (!confirmed) {
        for (var i = 0; i < DANGER.length; i++) {
          if (DANGER[i].re.test(line)) {
            print("err", "⚠ " + DANGER[i].msg);
            print("sys", "确认请再执行：confirm " + line);
            return;
          }
        }
      }
      if (p.cmd === "confirm") {
        var again = line.slice(line.indexOf(" ") + 1).trim();
        if (again) runLocal(again, true);
        return;
      }
      OS.dev.exec(p.cmd, p.args).then(function (res) {
        print("", fmtRes(res));
        // 会重载页面的命令：提前告知，避免用户以为“没反应”
        var body = res && typeof res === "object" && "data" in res ? res.data : res;
        if (body && (body.reloading || body.willReload))
          print("sys", "…正在重载，如 3 秒后仍无变化请重新打开本应用");
      }, function (err) {
        print("err", "✗ " + (err && err.message ? err.message : String(err)));
      });
    }
    function go() { var v = inp.value; inp.value = ""; runLocal(v); }
    btnRun.addEventListener("click", go);
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
    // 点输出区即聚焦输入框（平板上少一次精准点击）
    out.addEventListener("click", function () { try { inp.focus(); } catch (e) { } });
    btnPing.addEventListener("click", function () { runLocal("ping"); });
    btnInfo.addEventListener("click", function () { runLocal("info"); });
    btnHelp.addEventListener("click", function () { print("sys", HELP); });
    btnClear.addEventListener("click", function () { out.textContent = ""; banner(); });

    /* ---------- 电脑下发命令实时上屏 ---------- */
    OS.on("dev-cmd", function (d) {
      print("in", ts() + " «电脑 " + d.cmd + argsStr(d.args));
      print(d.res && d.res.ok === false ? "err" : "", fmtRes(d.res));
      refresh();
    });

    /* ---------- 通道状态 ---------- */
    function refresh() {
      var s = OS.dev.state();
      dot.className = "nv-term-dot " + (s.on ? "on" : s.off ? "off" : "");
      stTxt.textContent = s.on ? "已连接电脑（开发模式）" : s.off ? "电脑已关闭开发模式" : "未连接，等待电脑…";
      stTok.textContent = s.token ? "会话 " + s.token : "";
      stCnt.textContent = "命令 " + s.cmds + " · 成功 " + s.ok + " · 失败 " + s.fail;
    }
    OS.on("dev-change", refresh);

    banner();
    refresh();
    setTimeout(function () { try { inp.focus(); } catch (e) { } }, 250);
  }
})();
