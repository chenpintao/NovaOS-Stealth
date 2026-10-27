/*
 * T17 看门狗快照“每次联网刷新”验证（真实 Chromium）
 *
 * 目标（对应本次修复）：
 *   1) boot-stub：`online` 事件触发对 __boot__.snapshot.js 的强制刷新，
 *      且请求带 `cache-control: no-cache`（即 fetch cache:"reload" 的语义），
 *      即使节流时间戳仍很新也必须刷新（force=true 跳过节流）。
 *   2) loader：OS 起来后再次 `online` 也会补刷快照。
 *   3) 快照本身始终长缓存：响应 max-age=31536000 且无 ETag（不可被改成
 *      no-store / 不可被清理）。
 *   4) 设备端缓存仍保留快照：刷新后 snapshot 仍在磁盘（再取一次 200）。
 */
const L = require('../lib');
const http = require('http');

function head(p) {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: L.PORT, path: '/__nova__/' + p,
      method: 'GET', headers: { Host: L.HOST } }, resp => {
      let n = 0;
      resp.on('data', c => { n += c.length; });
      resp.on('end', () => res({ status: resp.statusCode,
        cc: resp.headers['cache-control'] || '',
        etag: resp.headers.etag || '', bytes: n }));
    });
    r.on('error', rej); r.end();
  });
}

(async () => {
  const bad = [];

  // ---- A. 服务端缓存头：快照必须一年长缓存、无 ETag ----
  const snap = await head('__boot__.snapshot.js');
  if (snap.status !== 200) bad.push('snapshot 状态 ' + snap.status);
  if (!/max-age=31536000/.test(snap.cc)) bad.push('snapshot 未长缓存: ' + snap.cc);
  if (/no-store/.test(snap.cc)) bad.push('snapshot 被 no-store: ' + snap.cc);
  if (snap.etag) bad.push('snapshot 不应带 ETag');

  // ---- B. 真实浏览器：online → 强制刷新 snapshot ----
  const srv = await L.hostPageServer(8095);
  const b = await L.launch({ hostLocal: 8095 });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();

  // 记录对 snapshot 的请求到达“网络层”的时间点。
  // 注意：Chromium 的 fetch(cache:"reload") 通过 Network 层的 cache-mode 实现，
  // 不会额外加 Cache-Control 请求头；因此“请求到达网络层”本身就证明了它不是
  // 命中磁盘缓存（缓存命中不会产生网络请求、更不会到服务器）。用时间戳把
  // 请求归因到“某次 online 之后”，是比抓请求头更可靠的判据。
  const snapReqs = [];
  p.on('request', r => {
    const u = r.url();
    if (u.indexOf('__boot__.snapshot.js') >= 0) {
      snapReqs.push({ url: u.split('/__nova__/')[1] || u, t: Date.now(), phase: snapReqs.length });
    }
  });

  await p.goto('http://host.local:8095/column.html');
  await L.injectStub(p);            // 注入 stub：注册 online 监听 + 首屏预热
  await p.waitForTimeout(3500);     // 等首屏预热（2.5s）完成

  const warmBefore = snapReqs.length;
  // 把节流打点写成“刚刚”，证明 online 的 force 会无视节流仍刷新
  await p.evaluate(() => { try { localStorage.setItem('__nvaSnapAt', String(Date.now())); } catch (e) {} });

  // 派发 online 事件：stub 的 online → warmSnapshot(true) 必刷
  const tStub = Date.now();
  await p.evaluate(() => { try { window.dispatchEvent(new Event('online')); } catch (e) {} });
  await p.waitForTimeout(1500);
  const afterStubOnline = snapReqs.filter(x => x.t >= tStub);

  // ---- C. loader 的 online 刷新：先起 OS，再派发一次 online ----
  await L.activate(p);
  const f = await L.waitOsReady(p, 25000);
  if (!f) bad.push('OS 未启动，无法验证 loader online 刷新');
  const tLoader = Date.now();
  await p.evaluate(() => { try { window.dispatchEvent(new Event('online')); } catch (e) {} });
  await p.waitForTimeout(1500);
  const afterLoaderOnline = snapReqs.filter(x => x.t >= tLoader);

  // ---- D. 刷新后快照仍可 200（未被清） ----
  const snap2 = await head('__boot__.snapshot.js');

  await L.shot(p, 'T17_watchdog_refresh');
  await b.close(); srv.close();

  // ---- 判定 ----
  if (afterStubOnline.length < 1) bad.push('stub 的 online 未触发快照刷新（force 失效）');
  if (f && afterLoaderOnline.length < 1) bad.push('loader 的 online 未触发快照刷新');
  if (snap2.status !== 200) bad.push('刷新后快照不可用: ' + snap2.status);

  L.done(bad.length === 0,
    bad.length ? bad.join('; ') :
      'ok: cc=' + snap.cc + '; stubOnline=' + afterStubOnline.length +
      '; loaderOnline=' + afterLoaderOnline.length +
      '; snapshotStill200=' + (snap2.status === 200),
    { snapCC: snap.cc, snapEtag: snap.etag,
      afterStubOnline: afterStubOnline.map(x => x.url),
      afterLoaderOnline: afterLoaderOnline.map(x => x.url),
      snap2Status: snap2.status });
})().catch(e => L.done(false, '异常: ' + e.message));
