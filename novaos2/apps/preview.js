/* ============================================================
 * Tzy OS · 文档查看器（只读预览，纯前端渲染）
 *   pdf  → pdf.js 3.11 逐页渲染 canvas
 *   docx → mammoth 转语义 HTML
 *   pptx → JSZip 解析幻灯片文字 + 图片
 *   xlsx → JSZip 解析共享字符串 + 表格
 *   doc/ppt/xls 旧二进制格式不支持渲染，提示并提供下载
 * 依赖（nova.html 已引入，均自托管离线可用）：
 *   lib/preview/pdf.min.js(+worker)、mammoth.browser.min.js、jszip.min.js
 * Loshop & Cpt
 * ============================================================ */
(function () {
  "use strict";

  OS.registerApp({
    id: "preview",
    name: "文档查看",
    icon: "📖",
    tone: "tone-gold",
    version: "1.0.0",
    desktop: false,   // 仅由文件管理器带参调起，不占桌面图标
    open: function (root, OS) { build(root, OS); },
    onArg: function (root, arg) {
      if (arg && arg.__preview && root.__state && root.__state.load) {
        root.__state.load(arg.payload);
      }
    }
  });

  function extOf(name) {
    return String(name || "").split(".").pop().toLowerCase();
  }

  function callGet(OS, p) {
    if (p.source === "vfs") return OS.vfs.get(p.path);
    if (p.source === "fs") return OS.api.fs("get", { path: p.path });
    if (p.source === "ftp")
      return OS.api.ftp(Object.assign({}, p.conn, { op: "get", path: p.path }));
    return OS.api.smb(Object.assign({}, p.conn, { op: "get", path: p.path }));
  }

  function asArrayBuffer(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error("读取文件内容失败")); };
      fr.readAsArrayBuffer(blob);
    });
  }

  // XML 中所有带命名空间前缀的节点，如 a:t / r:embed
  function qAll(node, local) {
    var out = [], all = node.getElementsByTagName("*");
    for (var i = 0; i < all.length; i++) {
      var tn = all[i].tagName || all[i].localName || "";
      if (tn === local || tn.slice(tn.indexOf(":") + 1) === local) out.push(all[i]);
    }
    return out;
  }
  function txt(node) { return node ? (node.textContent || "") : ""; }

  function build(root, OS) {
    var state = { payload: null, blob: null };
    root.__state = state;

    root.style.cssText = "display:-webkit-flex;display:flex;-webkit-flex-direction:column;" +
      "flex-direction:column;height:100%;background:#eceef2;";

    var bar = OS.h("div", "nv-toolbar");
    var tName = OS.h("span", "nv-crumbs", "文档查看");
    tName.style.flex = "1 1 auto";
    tName.style.overflow = "hidden";
    tName.style.whiteSpace = "nowrap";
    tName.style.textOverflow = "ellipsis";
    var btnDl = OS.h("button", "nv-btn", "下载到本机");
    btnDl.style.display = "none";
    bar.appendChild(tName);
    bar.appendChild(btnDl);

    var view = document.createElement("div");
    view.className = "nv-pv-view";

    var statusLine = OS.h("div", "nv-status-line", "就绪");
    root.appendChild(bar);
    root.appendChild(view);
    root.appendChild(statusLine);

    function setStatus(s) { statusLine.textContent = s; }
    function esc(s) {
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    state.load = function (p) {
      state.payload = p;
      OS.clear(view);
      view.scrollTop = 0;
      tName.textContent = "正在打开：" + p.name;
      btnDl.style.display = "none";
      setStatus("正在读取 " + p.name + "…");
      callGet(OS, p).then(function (r) {
        if (!r || !r.ok) {
          OS.log("preview", "预览读取失败 " + p.name + "：" +
            ((r && r.offline) ? "(离线/电脑不可达)" : ("读取失败：" + (r && r.error))), "error");
          setStatus((r && r.offline) ? "电脑服务不可达（离线）" : ("读取失败：" + (r && r.error)));
          view.appendChild(OS.h("div", "nv-empty",
            (r && r.offline) ? "电脑服务不可达（离线模式）" : ("读取失败：" + (r && r.error || "未知错误"))));
          return;
        }
        state.blob = (r.text !== undefined && r.text !== null)
          ? new Blob([r.text], { type: "text/plain;charset=utf-8" })
          : OS.b64ToBlob(r.data, r.mime || OS.mimeOf(p.name));
        tName.textContent = p.name;
        btnDl.style.display = "";
        dispatch(p.name, state.blob);
      }, function (e) {
        OS.logerr("preview", e, "预览读取异常 " + p.name);
        setStatus("读取失败");
        view.appendChild(OS.h("div", "nv-empty", "读取失败：" + (e && e.message ? e.message : e)));
      });
    };

    btnDl.addEventListener("click", function () {
      if (state.blob) OS.download(state.payload ? state.payload.name : "document", state.blob);
    });

    /* ---------------------- PDF ---------------------- */
    function renderPdf(buf) {
      if (!window.pdfjsLib) {
        OS.log("preview", "无法预览 PDF：pdfjsLib 组件未加载", "error");
        view.appendChild(OS.h("div", "nv-empty", "PDF 组件未加载"));
        return;
      }
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/preview/pdf.worker.min.js";
      } catch (e) { }
      var holder = document.createElement("div");
      holder.className = "nv-pv-pages";
      OS.clear(view);
      view.appendChild(holder);
      var task = window.pdfjsLib.getDocument({ data: new Uint8Array(buf) });
      setStatus("正在解析 PDF…");
      task.promise.then(function (pdf) {
        var total = pdf.numPages;
        var i = 0;
        function renderOne() {
          i++;
          setStatus("正在渲染第 " + i + "/" + total + " 页…");
          return pdf.getPage(i).then(function (page) {
            var vp = page.getViewport({ scale: 1.4 });
            var cv = document.createElement("canvas");
            cv.className = "nv-pv-page";
            cv.width = Math.floor(vp.width);
            cv.height = Math.floor(vp.height);
            holder.appendChild(cv);
            return page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise
              .then(function () { if (i < total) return renderOne(); });
          });
        }
        renderOne().then(function () {
          setStatus("PDF · 共 " + total + " 页");
        }, function (e) {
          OS.logerr("preview", e, "PDF 渲染失败（共 " + total + " 页，中断于第 " + i + " 页）");
          setStatus("PDF 渲染失败：" + (e && e.message));
        });
      }, function (e) {
        OS.logerr("preview", e, "PDF 解析失败（文件可能已损坏）");
        OS.clear(view);
        view.appendChild(OS.h("div", "nv-empty", "PDF 解析失败（文件可能已损坏）：" + (e && e.message)));
      });
    }

    /* ---------------------- DOCX ---------------------- */
    function renderDocx(buf) {
      if (!window.mammoth) {
        OS.log("preview", "无法预览 docx：mammoth 组件未加载", "error");
        view.appendChild(OS.h("div", "nv-empty", "docx 组件未加载"));
        return;
      }
      setStatus("正在转换 Word 文档…");
      window.mammoth.convertToHtml({ arrayBuffer: buf })
        .then(function (res) {
          var box = document.createElement("div");
          box.className = "nv-pv-doc";
          box.innerHTML = res.value || "<p>（文档内容为空）</p>";
          OS.clear(view);
          view.appendChild(box);
          var warns = (res.messages || []).length;
          setStatus("Word 预览完成" + (warns ? "（" + warns + " 条格式提示已忽略，复杂排版可能与原版有差异）" : ""));
        }, function (e) {
          OS.logerr("preview", e, "docx 解析失败");
          OS.clear(view);
          view.appendChild(OS.h("div", "nv-empty", "docx 解析失败：" + (e && e.message)));
        });
    }

    /* ---------------------- PPTX ---------------------- */
    function renderPptx(zip) {
      var names = Object.keys(zip.files).filter(function (n) {
        return /^ppt\/slides\/slide\d+\.xml$/.test(n);
      }).sort(function (a, b) {
        return parseInt(a.match(/slide(\d+)\.xml/)[1], 10) - parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      });
      if (!names.length) {
        OS.clear(view);
        view.appendChild(OS.h("div", "nv-empty", "未在 pptx 中找到幻灯片"));
        setStatus("pptx 无幻灯片");
        return;
      }
      var holder = document.createElement("div");
      holder.className = "nv-pv-slides";
      var chain = Promise.resolve();
      names.forEach(function (sn, idx) {
        chain = chain.then(function () {
          setStatus("正在解析幻灯片 " + (idx + 1) + "/" + names.length + "…");
          return Promise.all([
            zip.file(sn).async("string"),
            (function () {
              // 幻灯片关系件可能不存在（简单生成器产物），缺失时按无图片处理
              var zf = zip.file("ppt/slides/_rels/" + sn.split("/").pop() + ".rels");
              return zf ? zf.async("string")["catch"](function () { return ""; })
                        : Promise.resolve("");
            })()
          ]).then(function (pair) {
            var xml = new DOMParser().parseFromString(pair[0], "application/xml");
            var card = document.createElement("div");
            card.className = "nv-pv-slide";
            card.appendChild(OS.h("div", "nv-pv-slide-no", "第 " + (idx + 1) + " 页 / 共 " + names.length + " 页"));
            var body = document.createElement("div");
            body.className = "nv-pv-slide-body";
            qAll(xml, "t").forEach(function (t) {
              var s = txt(t);
              if (s.trim()) {
                var para = document.createElement("div");
                para.className = "nv-pv-line";
                para.textContent = s;
                body.appendChild(para);
              }
            });
            card.appendChild(body);
            // 关系表 rId -> media 目标，按 XML 中 r:embed 出现顺序取图
            var relsXml = pair[1];
            var relMap = {};
            if (relsXml) {
              var rdoc = new DOMParser().parseFromString(relsXml, "application/xml");
              var rels = rdoc.getElementsByTagName("Relationship");
              for (var i = 0; i < rels.length; i++) {
                var id = rels[i].getAttribute("Id");
                var tgt = rels[i].getAttribute("Target") || "";
                if (id && /media\//.test(tgt)) relMap[id] = tgt;
              }
            }
            var embeds = qAll(xml, "blip").map(function (b) {
              var attrs = b.attributes || [];
              for (var j = 0; j < attrs.length; j++) {
                var an = attrs[j].name || "";
                if (an === "r:embed" || an.slice(an.indexOf(":") + 1) === "embed")
                  return attrs[j].value;
              }
              return null;
            }).filter(Boolean);
            var imgChain = Promise.resolve();
            embeds.forEach(function (rid) {
              var tgt = relMap[rid];
              if (!tgt) return;
              var norm = tgt.replace(/^\/?ppt\//, "ppt/").replace(/^\.\.\//, "ppt/");
              var zf = zip.file(norm) || zip.file("ppt/" + tgt.split("/").slice(-2).join("/"));
              if (!zf) return;
              imgChain = imgChain.then(function () {
                return zf.async("base64")["catch"](function () { return ""; });
              }).then(function (b64) {
                if (!b64) return;
                var im = document.createElement("img");
                im.className = "nv-pv-img";
                im.src = "data:" + guessImgMime(norm) + ";base64," + b64;
                card.appendChild(im);
              });
            });
            holder.appendChild(card);
            return imgChain;
          });
        });
      });
      chain.then(function () {
        OS.clear(view);
        view.appendChild(holder);
        setStatus("PPT 预览完成 · 共 " + names.length + " 页（文字与图片，动画不支持）");
      }, function (e) {
        OS.logerr("preview", e, "pptx 解析失败");
        OS.clear(view);
        view.appendChild(OS.h("div", "nv-empty", "pptx 解析失败：" + (e && e.message)));
      });
    }

    function guessImgMime(n) {
      var x = n.split(".").pop().toLowerCase();
      return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" })[x] || "image/png";
    }

    /* ---------------------- XLSX ---------------------- */
    function renderXlsx(zip) {
      setStatus("正在解析表格…");
      var shared = [];
      var ssf = zip.file("xl/sharedStrings.xml");
      var sheetF = zip.file("xl/worksheets/sheet1.xml");
      if (!sheetF) {
        // 部分生成器把工作表放在别的名字下
        Object.keys(zip.files).forEach(function (n) {
          if (/^xl\/worksheets\/sheet\d+\.xml$/.test(n) && !sheetF) sheetF = zip.file(n);
        });
      }
      if (!sheetF) {
        OS.clear(view);
        view.appendChild(OS.h("div", "nv-empty", "未在 xlsx 中找到工作表"));
        return;
      }
      var pShared = ssf ? ssf.async("string")["catch"](function () { return ""; }) : Promise.resolve("");
      pShared.then(function (ssText) {
        if (ssText) {
          var sd = new DOMParser().parseFromString(ssText, "application/xml");
          var sis = sd.getElementsByTagName("si");
          for (var i = 0; i < sis.length; i++) {
            var ts = qAll(sis[i], "t");
            shared.push(ts.map(txt).join(""));
          }
        }
        return sheetF.async("string");
      }).then(function (sheetText) {
        var xml = new DOMParser().parseFromString(sheetText, "application/xml");
        var rows0 = qAll(xml, "row");
        var table = document.createElement("table");
        table.className = "nv-pv-table";
        var maxCols = 0;
        var docFrag = document.createDocumentFragment();
        rows0.forEach(function (rn) {
          var tr = document.createElement("tr");
          var cells = rn.getElementsByTagName("c");
          var colIdx = 0;
          for (var ci = 0; ci < cells.length; ci++) {
            var c = cells[ci];
            var ref = c.getAttribute("r") || "";
            var m = ref.match(/^([A-Z]+)/);
            if (m) {
              var n = 0;
              for (var k = 0; k < m[1].length; k++) n = n * 26 + (m[1].charCodeAt(k) - 64);
              while (colIdx < n - 1) {
                tr.appendChild(document.createElement("td"));
                colIdx++;
              }
            }
            var type = c.getAttribute("t") || "";
            var vNode = c.getElementsByTagName("v")[0];
            var val = vNode ? txt(vNode) : "";
            if (type === "s") val = shared[parseInt(val, 10)] || "";
            if (type === "inlineStr") {
              var isn = c.getElementsByTagName("is")[0];
              val = isn ? qAll(isn, "t").map(txt).join("") : "";
            }
            var td = document.createElement("td");
            td.textContent = val;
            tr.appendChild(td);
            colIdx++;
          }
          maxCols = Math.max(maxCols, colIdx);
          docFrag.appendChild(tr);
        });
        table.appendChild(docFrag);
        var box = document.createElement("div");
        box.className = "nv-pv-doc";
        box.appendChild(table);
        OS.clear(view);
        view.appendChild(box);
        setStatus("Excel 预览完成 · " + rows0.length + " 行（仅第一个工作表，公式显示结果值）");
      }, function (e) {
        OS.logerr("preview", e, "xlsx 解析失败");
        OS.clear(view);
        view.appendChild(OS.h("div", "nv-empty", "xlsx 解析失败：" + (e && e.message)));
      });
    }

    /* ---------------------- 旧二进制 .doc/.ppt/.xls ---------------------- */
    function renderLegacy(name) {
      var box = document.createElement("div");
      box.className = "nv-pv-doc nv-pv-unsupported";
      box.innerHTML =
        "<h3>旧版 Office 格式暂不支持在线预览</h3>" +
        "<p>文件 <b>" + esc(name) + "</b> 是 " +
        "<b>.doc / .ppt / .xls</b> 旧二进制格式，纯网页环境无法可靠渲染。</p>" +
        "<p>可在电脑上用 Word/PowerPoint/Excel「另存为」<br>" +
        ".docx / .pptx / .xlsx 后重新放入，即可预览；<br>" +
        "或点右上角「下载到本机」用其它设备打开。</p>";
      OS.clear(view);
      view.appendChild(box);
      setStatus("旧格式不支持预览，可下载后查看");
    }

    function dispatch(name, blob) {
      var ext = extOf(name);
      if (ext === "pdf") {
        asArrayBuffer(blob).then(renderPdf, function (e) {
          OS.logerr("preview", e, "PDF Blob 读取失败 " + name);
          view.appendChild(OS.h("div", "nv-empty", "读取 PDF 失败"));
        });
      } else if (ext === "docx") {
        asArrayBuffer(blob).then(renderDocx);
      } else if (ext === "pptx" || ext === "xlsx") {
        asArrayBuffer(blob).then(function (buf) {
          if (!window.JSZip) {
            OS.log("preview", "无法预览 " + ext + "：JSZip 解析组件未加载", "error");
            view.appendChild(OS.h("div", "nv-empty", "解析组件未加载"));
            return;
          }
          return window.JSZip.loadAsync(buf);
        }).then(function (zip) {
          if (ext === "pptx") renderPptx(zip);
          else renderXlsx(zip);
        }, function (e) {
          OS.logerr("preview", e, ext + " 文件解析失败（可能已损坏或加密） " + name);
          OS.clear(view);
          view.appendChild(OS.h("div", "nv-empty",
            "文件解析失败（可能已损坏或加密）：" + (e && e.message)));
          setStatus("解析失败");
        });
      } else {
        renderLegacy(name);
      }
    }
  }
})();
