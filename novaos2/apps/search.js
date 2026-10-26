/* ============================================================
 * Tzy OS · 智能搜索 / AI 对话
 *   - AI 模式：可勾选“联网搜索”，结果流式输出（SSE）
 *   - 搜索模式：不使用 AI，直接联网搜索并给出来源摘要
 *   - 来源自动折叠，点击展开
 *   - AI 配置走侧边栏，修改需口令（后端校验）
 *   - 对话记录保存在本机（localStorage），AI 配置保存在电脑端 config.json
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "search",
    name: "智能搜索",
    icon: "🔎",
    tone: "tone-blue",
    version: "2.0.0",
    maximize: true,
    open: function (root, OS) { build(root, OS); }
  });

  var HISTORY_KEY = "nova2.search.history";
  var MODE_KEY = "nova2.search.mode";
  var USESEARCH_KEY = "nova2.search.useSearch";
  var HISTORY_MAX = 40;

  function esc(s) { return String(s == null ? "" : s); }

  function build(root, OS) {
    var state = {
      mode: OS.store.get(MODE_KEY, "ai") === "search" ? "search" : "ai",
      useSearch: OS.store.get(USESEARCH_KEY, true) !== false,
      busy: false,
      cancelStream: null,
      history: loadHistory()
    };

    var wrap = OS.h("div", "nv-search");
    wrap.style.cssText = "position:absolute;top:0;left:0;right:0;bottom:0;" +
      "display:flex;flex-direction:column;background:var(--paper);color:var(--text);";

    /* ---------- 顶栏 ---------- */
    var bar = OS.h("div", "nv-search-bar");
    bar.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:8px;" +
      "padding:10px 12px;background:var(--surface);color:var(--text);";
    var title = OS.h("div", "", "🔎 智能搜索");
    title.style.cssText = "font-weight:600;margin-right:auto;";
    var status = OS.h("span", "", "就绪");
    status.style.cssText = "font-size:11px;color:var(--text-3);";

    // 模式切换
    var seg = OS.h("div", "nv-seg");
    seg.style.cssText = "display:flex;border:1px solid var(--line-strong);border-radius:var(--r-sm);overflow:hidden;";
    function modeBtn(key, label) {
      var b = OS.h("button", "", label);
      b.style.cssText = "background:transparent;border:0;color:var(--text-2);padding:5px 10px;" +
        "font-size:12px;cursor:pointer;";
      b._key = key;
      b.addEventListener("click", function () { setMode(key); });
      return b;
    }
    var btnAI = modeBtn("ai", "AI");
    var btnSearch = modeBtn("search", "搜索");
    seg.appendChild(btnAI); seg.appendChild(btnSearch);

    var btnCfg = OS.h("button", "nv-btn", "设置");
    var btnClear = OS.h("button", "nv-btn", "清空");
    bar.appendChild(title); bar.appendChild(status); bar.appendChild(seg);
    bar.appendChild(btnCfg); bar.appendChild(btnClear);
    wrap.appendChild(bar);

    /* ---------- AI 选项条 ---------- */
    var opts = OS.h("div", "");
    opts.style.cssText = "flex:0 0 auto;display:flex;align-items:center;gap:8px;" +
      "padding:6px 12px;background:var(--surface);border-bottom:1px solid var(--line);font-size:12px;color:var(--text-2);";
    var cbSearch = document.createElement("input");
    cbSearch.type = "checkbox";
    cbSearch.className = "nv-checkbox";
    var lblSearch = OS.h("span", "", "启用联网搜索");
    var hintAI = OS.h("span", "", "");
    hintAI.style.cssText = "margin-left:auto;color:var(--text-3);";
    opts.appendChild(cbSearch); opts.appendChild(lblSearch); opts.appendChild(hintAI);
    wrap.appendChild(opts);

    /* ---------- 消息区 ---------- */
    var list = OS.h("div", "");
    list.style.cssText = "flex:1;min-height:0;overflow:auto;padding:16px 14px;";
    wrap.appendChild(list);

    var empty = OS.h("div", "", "输入问题开始对话；搜索模式不调用 AI，直接返回来源摘要");
    empty.style.cssText = "color:var(--text-3);font-size:14px;text-align:center;margin-top:40px;";
    list.appendChild(empty);

    /* ---------- 输入区 ---------- */
    var composer = OS.h("div", "");
    composer.style.cssText = "flex:0 0 auto;display:flex;gap:8px;padding:10px;" +
      "border-top:1px solid var(--line);background:var(--surface);";
    var input = document.createElement("textarea");
    input.placeholder = "输入问题…（Enter 发送，Shift+Enter 换行）";
    input.rows = 1;
    input.style.cssText = "flex:1;min-width:0;resize:none;border:1px solid var(--line-strong);" +
      "border-radius:var(--r-sm);padding:9px;font:14px sans-serif;" +
      "background:var(--paper);color:var(--text);";
    var btnSend = OS.h("button", "nv-btn primary", "发送");
    composer.appendChild(input); composer.appendChild(btnSend);
    wrap.appendChild(composer);
    root.appendChild(wrap);

    /* ---------- 历史持久化 ---------- */
    function loadHistory() {
      var h = OS.store.get(HISTORY_KEY, []);
      return Array.isArray(h) ? h : [];
    }
    function saveHistory(h) {
      state.history = h.slice(-HISTORY_MAX);
      OS.store.set(HISTORY_KEY, state.history);
    }

    function setMode(m) {
      state.mode = m;
      OS.store.set(MODE_KEY, m);
      renderMode();
      renderHistory();
    }
    function renderMode() {
      var ai = state.mode === "ai";
      btnAI.style.background = ai ? "var(--accent)" : "transparent";
      btnAI.style.color = ai ? "#fff" : "var(--text-2)";
      btnSearch.style.background = ai ? "transparent" : "var(--accent)";
      btnSearch.style.color = ai ? "var(--text-2)" : "#fff";
      opts.style.display = ai ? "flex" : "none";
      cbSearch.checked = state.useSearch;
      hintAI.textContent = ai
        ? (state.useSearch ? "AI + 联网搜索" : "AI 直接回答（不联网）")
        : "纯搜索模式 · 不调用 AI";
      input.placeholder = ai
        ? "向 AI 提问…（Enter 发送，Shift+Enter 换行）"
        : "输入搜索关键词…（Enter 发送）";
    }

    /* ---------- 渲染 ---------- */
    function bubble(kind, text) {
      var el = OS.h("div", "");
      var mine = kind === "user";
      el.style.cssText = "max-width:86%;margin:8px 0;padding:10px 12px;" +
        "border-radius:" + (mine ? "12px 4px 12px 12px" : "4px 12px 12px 12px") + ";" +
        "background:" + (mine ? "var(--accent)" : "var(--surface)") + ";" +
        "color:" + (mine ? "#fff" : "var(--text)") + ";" +
        "box-shadow:var(--sh-1);white-space:pre-wrap;" +
        "word-break:break-word;line-height:1.55;" +
        (mine ? "margin-left:auto;" : "");
      el.textContent = esc(text);
      return el;
    }

    // 来源折叠块：默认折叠，点击标题展开
    function sourcesBlock(sources, engine, usedSearch) {
      var box = document.createElement("div");
      box.style.cssText = "margin:2px 0 10px;font-size:12.5px;color:var(--text-2);";
      var count = (sources || []).length;
      var head = document.createElement("div");
      head.style.cssText = "cursor:pointer;user-select:none;color:var(--accent);" +
        "padding:4px 0;display:flex;align-items:center;gap:6px;";
      var arrow = OS.h("span", "", "▸");
      var label = "参考来源 · " + count + " 条" +
        (engine ? "（" + engine + "）" : "") + (usedSearch === false ? "（未联网）" : "");
      head.appendChild(arrow);
      head.appendChild(OS.h("span", "", label));
      var bodyBox = document.createElement("div");
      bodyBox.style.cssText = "display:none;margin-top:2px;padding-left:14px;";
      if (!count) {
        bodyBox.appendChild(OS.h("div", "", "（无来源）"));
      } else {
        sources.forEach(function (s, i) {
          var row = document.createElement("div");
          row.style.cssText = "margin:4px 0;line-height:1.45;";
          var a = document.createElement("a");
          a.textContent = (i + 1) + ". " + (s.title || s.domain || s.url);
          a.href = s.url || "#";
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.style.cssText = "color:var(--accent);text-decoration:none;";
          row.appendChild(a);
          if (s.domain) {
            var dom = OS.h("span", "", "  " + s.domain);
            dom.style.cssText = "color:var(--text-3);";
            row.appendChild(dom);
          }
          if (s.snippet) {
            var sn = OS.h("div", "", s.snippet);
            sn.style.cssText = "color:var(--text-3);font-size:11.5px;margin-top:2px;";
            row.appendChild(sn);
          }
          bodyBox.appendChild(row);
        });
      }
      var open = false;
      head.addEventListener("click", function () {
        open = !open;
        bodyBox.style.display = open ? "block" : "none";
        arrow.textContent = open ? "▾" : "▸";
      });
      box.appendChild(head);
      box.appendChild(bodyBox);
      return box;
    }

    function showEmpty(show) { empty.style.display = show ? "" : "none"; }

    function renderHistory() {
      OS.clear(list);
      if (!state.history.length) { list.appendChild(empty); showEmpty(true); return; }
      showEmpty(false);
      state.history.forEach(function (item) {
        if (item.q) list.appendChild(bubble("user", item.q));
        if (item.a) list.appendChild(bubble("ai", item.a));
        if (item.sources && item.sources.length) {
          list.appendChild(sourcesBlock(item.sources, item.engine, item.usedSearch));
        }
      });
      list.scrollTop = list.scrollHeight;
    }

    /* ---------- 发送 ---------- */
    function finishTurn(item) {
      var h = state.history.slice();
      h.push(item);
      saveHistory(h);
    }

    function send() {
      if (state.busy) return;
      var q = input.value.trim();
      if (!q) return;
      input.value = "";
      state.busy = true;
      btnSend.disabled = true;
      showEmpty(false);
      list.appendChild(bubble("user", q));
      var answerEl = bubble("ai", "");
      var answerBox = OS.h("div", "");
      answerBox.style.cssText = "max-width:86%;";
      answerBox.appendChild(answerEl);
      list.appendChild(answerBox);
      list.scrollTop = list.scrollHeight;
      answerEl.textContent = state.mode === "search" ? "正在搜索…" : "正在思考…";
      status.textContent = state.mode === "search" ? "搜索中…" : "生成中…";

      var acc = "";
      var sources = [], engine = "", usedSearch = state.mode !== "ai" || state.useSearch;
      var sourcesEl = null;
      var mode = state.mode;

      function appendDelta(text) {
        acc += text;
        answerEl.textContent = acc;
        list.scrollTop = list.scrollHeight;
      }
      function humanize(msg) {
        var m = String(msg || "");
        if (/failed to fetch|networkerror|load failed/i.test(m)) {
          return "无法连接电脑服务（网络中断、IP 直连被拦截或在线模式已关闭）。" +
            "请检查设置页顶部的在线开关与电脑连接后重试。";
        }
        if (/HTTP 5\d\d/.test(m)) return "电脑服务内部错误：" + m;
        return m;
      }
      function fail(msg) {
        msg = humanize(msg);
        state.busy = false;
        btnSend.disabled = false;
        answerEl.textContent = "失败：" + msg;
        status.textContent = "失败";
        finishTurn({ q: q, a: "失败：" + msg, sources: sources, engine: engine,
                     usedSearch: usedSearch, at: Date.now(), mode: mode });
      }
      function done(text, srcs, eng) {
        state.busy = false;
        btnSend.disabled = false;
        if (text) { acc = text; answerEl.textContent = acc; }
        if (srcs) sources = srcs;
        if (eng) engine = eng;
        if (sourcesEl && sourcesEl.parentNode) sourcesEl.parentNode.removeChild(sourcesEl);
        sourcesEl = sourcesBlock(sources, engine, usedSearch);
        list.appendChild(sourcesEl);
        status.textContent = "完成 · " + (mode === "search" ? "搜索" : "AI") +
          (srcs && srcs.length ? " · " + srcs.length + " 条来源" : "");
        list.scrollTop = list.scrollHeight;
        finishTurn({ q: q, a: acc, sources: sources, engine: engine,
                     usedSearch: usedSearch, at: Date.now(), mode: mode });
      }

      state.cancelStream = OS.api.searchStream(q, {
        mode: mode,
        useSearch: state.useSearch,
        limit: 8
      }, function (evt) {
        if (!evt) return;
        if (evt.type === "delta") appendDelta(evt.text || "");
        else if (evt.type === "meta") { usedSearch = !!evt.usedSearch; }
        else if (evt.type === "sources") { sources = evt.sources || []; engine = evt.engine || ""; usedSearch = !!evt.usedSearch; }
        else if (evt.type === "done") {
          done(evt.text || "", evt.sources || sources, evt.engine || engine);
          if (evt.usage && evt.usage.dailyCalls) {
            status.textContent += " · 今日 " + evt.usage.used + "/" + evt.usage.dailyCalls;
          }
        } else if (evt.type === "error") fail(evt.error || "未知错误");
      });
    }

    /* ---------- 配置侧边栏 ---------- */
    function openConfigSidebar() {
      OS.api.searchStatus().then(function (st) {
        st = st || {};
        var mask = OS.h("div", "nv-mask nv-modal-top");
        var panel = OS.h("div", "");
        panel.style.cssText = "position:fixed;top:0;right:0;bottom:0;width:min(360px,88vw);" +
          "background:var(--surface);box-shadow:var(--sh-3);z-index:12000;" +
          "display:flex;flex-direction:column;padding:16px;box-sizing:border-box;overflow:auto;";
        var head = OS.h("div", "");
        head.style.cssText = "display:flex;align-items:center;margin-bottom:12px;";
        head.appendChild(OS.h("div", "", "AI 配置")).style.cssText = "font-weight:700;flex:1;";
        var bClose = OS.h("button", "nv-btn", "关闭");
        head.appendChild(bClose);
        panel.appendChild(head);

        var info = OS.h("div", "");
        info.style.cssText = "font-size:12px;color:var(--text-2);line-height:1.7;margin-bottom:12px;";
        function infoText(s) {
          return "状态：" + (s.ready ? "已就绪" : (s.enabled ? "已启用但配置不全" : "未启用")) +
            "\n模型：" + (s.model || "（未填写）") +
            "\n接口：" + (s.url || "（未填写）") +
            "\nKey：" + (s.keySet ? "已设置" : "未设置") +
            "\n今日：" + ((s.usage && s.usage.used) || 0) + "/" +
            ((s.usage && s.usage.dailyCalls) || "?") + " 次" +
            "，累计 " + ((s.usage && s.usage.tokens) || 0) + " tokens";
        }
        info.textContent = infoText(st);
        info.style.whiteSpace = "pre-wrap";
        panel.appendChild(info);

        function field(label, value, type) {
          var box = OS.h("div", "");
          box.style.cssText = "margin-bottom:10px;";
          var l = OS.h("div", "", label);
          l.style.cssText = "font-size:12px;color:var(--text-2);margin-bottom:4px;";
          var i = document.createElement("input");
          i.type = type || "text";
          i.className = "nv-input";
          i.value = value == null ? "" : value;
          i.style.cssText = "width:100%;box-sizing:border-box;padding:7px;border:1px solid var(--line-strong);" +
            "border-radius:var(--r-sm);background:var(--paper);color:var(--text);";
          box.appendChild(l); box.appendChild(i);
          return { box: box, input: i };
        }

        var fPwd = field("修改口令", "", "password");
        var fKey = field("API Key（留空不变，输入 - 清除）", "", "password");
        var fUrl = field("接口地址", st.url || "");
        var fModel = field("模型名", st.model || "");
        var fMax = field("每次回答 token 上限", (st.limits && st.limits.max_tokens) || 400);
        var fDaily = field("每日调用次数上限", (st.limits && st.limits.dailyCalls) || 50);
        [fPwd, fKey, fUrl, fModel, fMax, fDaily].forEach(function (f) {
          panel.appendChild(f.box);
        });

        var cbEnable = document.createElement("input");
        cbEnable.type = "checkbox";
        cbEnable.className = "nv-checkbox";
        cbEnable.checked = !!st.enabled;
        var enableRow = OS.h("div", "");
        enableRow.style.cssText = "display:flex;align-items:center;gap:8px;margin:6px 0 14px;" +
          "font-size:13px;color:var(--text);";
        enableRow.appendChild(cbEnable);
        enableRow.appendChild(OS.h("span", "", "启用云端 AI"));
        panel.appendChild(enableRow);

        var actions = OS.h("div", "");
        actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
        var bSave = OS.h("button", "nv-btn primary", "保存");
        actions.appendChild(bSave);
        panel.appendChild(actions);

        var tip = OS.h("div", "");
        tip.style.cssText = "margin-top:10px;font-size:11.5px;color:var(--text-3);line-height:1.6;";
        tip.textContent = "配置保存在电脑端 config.json；修改需输入口令。对话记录保存在本机。";
        panel.appendChild(tip);

        mask.appendChild(panel);
        document.body.appendChild(mask);
        function close() { if (mask.parentNode) mask.parentNode.removeChild(mask); }
        bClose.addEventListener("click", close);
        mask.addEventListener("click", function (e) { if (e.target === mask) close(); });

        bSave.addEventListener("click", function () {
          bSave.disabled = true;
          var body = { password: fPwd.input.value };
          if (fKey.input.value === "-") body.search_ai_key = "";
          else if (fKey.input.value.trim()) body.search_ai_key = fKey.input.value.trim();
          if (fUrl.input.value.trim()) body.search_ai_url = fUrl.input.value.trim();
          if (fModel.input.value.trim()) body.search_ai_model = fModel.input.value.trim();
          var n1 = parseInt(fMax.input.value, 10);
          if (!isNaN(n1) && n1 > 0) body.search_ai_max_tokens = Math.min(4000, n1);
          var n2 = parseInt(fDaily.input.value, 10);
          if (!isNaN(n2) && n2 > 0) body.search_ai_daily_calls = Math.min(1000, n2);
          body.search_ai_enable = !!cbEnable.checked;
          OS.api.searchConfig(body).then(function (r) {
            bSave.disabled = false;
            if (r && r.ok) {
              OS.toast("配置已保存");
              info.textContent = infoText(r);
              fPwd.input.value = "";
              fKey.input.value = "";
            } else {
              OS.toast((r && r.error) || "保存失败");
            }
          }, function (err) {
            bSave.disabled = false;
            OS.toast("保存失败：" + ((err && err.message) || "网络错误"));
          });
        });
      }, function (err) {
        OS.toast("读取配置失败：" + ((err && err.message) || "电脑服务不可用"));
      });
    }

    /* ---------- 事件绑定 ---------- */
    cbSearch.addEventListener("change", function () {
      state.useSearch = !!cbSearch.checked;
      OS.store.set(USESEARCH_KEY, state.useSearch);
      renderMode();
    });
    btnSend.addEventListener("click", send);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    btnCfg.addEventListener("click", openConfigSidebar);
    btnClear.addEventListener("click", function () {
      OS.dlg.confirm("清空全部对话记录？（不影响 AI 配置）", "清空历史").then(function (yes) {
        if (!yes) return;
        saveHistory([]);
        renderHistory();
        status.textContent = "已清空";
      });
    });

    renderMode();
    renderHistory();
    status.textContent = OS.net.online() ? "就绪" : "离线";
  }
})();
