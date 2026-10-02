/* ============================================================
 * Tzy OS · 计算器（完全离线）
 * 四则运算（先乘除后加减）、百分比、正负号、退格；大按键触屏友好。
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "calc",
    name: "计算器",
    icon: "🧮",
    tone: "tone-ink",
    version: "1.0.0",
    open: function (root, OS) { build(root, OS); }
  });

  function build(root, OS) {
    var wrap = OS.h("div", "nv-calc");

    var disp = OS.h("div", "nv-calc-disp");
    var elExpr = OS.h("div", "nv-calc-expr", "");
    var elMain = OS.h("div", "nv-calc-main", "0");
    disp.appendChild(elExpr);
    disp.appendChild(elMain);

    var keys = OS.h("div", "nv-calc-keys");
    wrap.appendChild(disp);
    wrap.appendChild(keys);
    root.appendChild(wrap);

    /* ---------- 状态 ---------- */
    var entry = "0";        // 当前输入
    var startNew = true;    // 下一个数字键是否开新数
    var tokens = [];        // 已确认的运算片段 [数, 符, 数, 符 …]
    var errored = false;
    var lastExprText = "";  // 等号后的回显

    var OP_SYM = { "+": "＋", "-": "−", "*": "×", "/": "÷" };

    function fmtNum(s) {
      if (s === "错误" || s === "") return s;
      var neg = s.charAt(0) === "-";
      var body = neg ? s.slice(1) : s;
      var parts = body.split(".");
      var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return (neg ? "-" : "") + intPart + (parts.length > 1 ? "." + parts[1] : "");
    }
    function render() {
      elMain.textContent = fmtNum(entry);
      var line = tokens.map(function (t) { return OP_SYM[t] || fmtNum(t); }).join(" ");
      elExpr.textContent = line + (startNew ? "" : (line ? " " : "") + fmtNum(entry));
      if (lastExprText) elExpr.textContent = lastExprText;
    }

    function reset() {
      entry = "0"; startNew = true; tokens = []; errored = false; lastExprText = "";
      render();
    }

    function inputDigit(d) {
      if (errored) reset();
      if (lastExprText) { tokens = []; lastExprText = ""; }
      if (startNew) { entry = d; startNew = false; }
      else {
        if (entry.replace(/[-.]/g, "").length >= 14) return;   // 防超长
        entry = (entry === "0") ? d : entry + d;
      }
      render();
    }
    function inputDot() {
      if (errored) reset();
      if (lastExprText) { tokens = []; lastExprText = ""; }
      if (startNew) { entry = "0."; startNew = false; }
      else if (entry.indexOf(".") < 0) entry += ".";
      render();
    }
    function backspace() {
      if (errored || lastExprText) { reset(); return; }
      if (startNew) return;
      entry = entry.length <= 1 || (entry.length === 2 && entry.charAt(0) === "-")
        ? "0" : entry.slice(0, -1);
      render();
    }
    function toggleSign() {
      if (errored || entry === "0") return;
      entry = entry.charAt(0) === "-" ? entry.slice(1) : "-" + entry;
      render();
    }
    function percent() {
      if (errored) return;
      var v = parseFloat(entry);
      if (!isFinite(v)) return;
      entry = String(parseFloat((v / 100).toPrecision(12)));
      startNew = true;
      render();
    }
    function inputOp(op) {
      if (errored) return;
      if (lastExprText) { tokens = [entry]; lastExprText = ""; }
      else if (!startNew) { tokens.push(entry); }
      // 连按运算符：替换最后一个
      var last = tokens[tokens.length - 1];
      if (last === "+" || last === "-" || last === "*" || last === "/") tokens[tokens.length - 1] = op;
      else tokens.push(op);
      entry = "0";
      startNew = true;
      render();
    }

    // 两级运算：先算 × ÷，再算 ＋ −
    function evaluate(toks) {
      var stage1 = [parseFloat(toks[0])];
      for (var i = 1; i < toks.length; i += 2) {
        var op = toks[i], num = parseFloat(toks[i + 1]);
        if (op === "*") stage1[stage1.length - 1] = stage1[stage1.length - 1] * num;
        else if (op === "/") {
          if (num === 0) return null;
          stage1[stage1.length - 1] = stage1[stage1.length - 1] / num;
        } else { stage1.push(op, num); }
      }
      var acc = stage1[0];
      for (var j = 1; j < stage1.length; j += 2) {
        if (stage1[j] === "+") acc += stage1[j + 1];
        else acc -= stage1[j + 1];
      }
      if (!isFinite(acc)) return null;
      return String(parseFloat(acc.toPrecision(12)));
    }
    function equals() {
      if (errored || startNew || !tokens.length) return;
      tokens.push(entry);
      var line = tokens.map(function (t) { return OP_SYM[t] || fmtNum(t); }).join(" ");
      var r = evaluate(tokens);
      if (r === null) {
        errored = true; entry = "错误"; tokens = []; startNew = true;
        elExpr.textContent = line + " ＝";
        elMain.textContent = "错误";
        return;
      }
      lastExprText = line + " ＝ " + fmtNum(r);
      entry = r;
      tokens = [];
      startNew = true;
      render();
    }

    /* ---------- 按键 ---------- */
    var layout = [
      { t: "C", cls: "fn", fn: reset },
      { t: "⌫", cls: "fn", fn: backspace },
      { t: "%", cls: "fn", fn: percent },
      { t: "÷", cls: "op", fn: function () { inputOp("/"); } },
      { t: "7", fn: function () { inputDigit("7"); } },
      { t: "8", fn: function () { inputDigit("8"); } },
      { t: "9", fn: function () { inputDigit("9"); } },
      { t: "×", cls: "op", fn: function () { inputOp("*"); } },
      { t: "4", fn: function () { inputDigit("4"); } },
      { t: "5", fn: function () { inputDigit("5"); } },
      { t: "6", fn: function () { inputDigit("6"); } },
      { t: "−", cls: "op", fn: function () { inputOp("-"); } },
      { t: "1", fn: function () { inputDigit("1"); } },
      { t: "2", fn: function () { inputDigit("2"); } },
      { t: "3", fn: function () { inputDigit("3"); } },
      { t: "＋", cls: "op", fn: function () { inputOp("+"); } },
      { t: "±", cls: "fn", fn: toggleSign },
      { t: "0", fn: function () { inputDigit("0"); } },
      { t: ".", fn: inputDot },
      { t: "＝", cls: "eq", fn: equals }
    ];
    layout.forEach(function (k) {
      var b = OS.h("button", "nv-calc-key " + (k.cls || ""), k.t);
      b.addEventListener("click", k.fn);
      keys.appendChild(b);
    });

    render();
  }
})();
