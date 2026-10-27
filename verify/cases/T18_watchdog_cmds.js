/*
 * T18 维护终端 watchdog 指令（真实 Chromium）
 *
 * 验证 OS.dev.exec 的 watchdog 命令组（与终端同一全权限路由）：
 *   - url      返回快照绝对地址
 *   - status   可达、200、长缓存、带 content-length
 *   - verify   合法脚本 js=true
 *   - refresh  经 loader 在宿主父页面触发快照刷新（网络层新增请求）
 *   - verify 负控：快照被 CDN HTML 错误页覆盖时 ok=false、js=false
 */
const L = require('../lib');
(async () => {
  const bad = [];
  const srv = await L.hostPageServer(8088);
  const b = await L.launch({ hostLocal: 8088 });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const reqs = [];
  p.on('request', r => { if (r.url().includes('__boot__.snapshot.js')) reqs.push(Date.now()); });

  await p.goto('http://host.local:8088/column.html');
  await L.injectStub(p);
  await p.waitForTimeout(3500);
  await L.activate(p);
  const f = await L.waitOsReady(p, 25000);
  if (!f) { await b.close(); srv.close(); return L.done(false, 'OS 未启动'); }
  await p.waitForTimeout(600);

  const R = await f.evaluate(async () => {
    const run = (op) => window.OS.dev.exec('watchdog', { op });
    return { url: await run('url'), status: await run('status'), verify: await run('verify') };
  });

  if (!R.url || !/__boot__\.snapshot\.js$/.test(R.url.url || '')) bad.push('url 异常: ' + JSON.stringify(R.url));
  if (!R.status || !R.status.reachable || R.status.status !== 200) bad.push('status 不可达: ' + JSON.stringify(R.status));
  if (!R.status || R.status.longCached !== true) bad.push('status 未识别长缓存: ' + (R.status && R.status.cc));
  if (!R.verify || !R.verify.ok || R.verify.js !== true) bad.push('verify 未通过: ' + JSON.stringify(R.verify));

  // refresh：观察宿主侧是否新增快照请求
  const t0 = Date.now();
  await f.evaluate(() => window.OS.dev.exec('watchdog', { op: 'refresh' }));
  await p.waitForTimeout(1800);
  const afterRefresh = reqs.filter(x => x >= t0).length;
  if (afterRefresh < 1) bad.push('refresh 未触发宿主快照刷新请求');

  // 负控：把快照替换成 CDN HTML，verify 必须拒绝
  await ctx.route('**/__boot__.snapshot.js', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<html>CDN Access Denied</html>'
  }));
  const neg = await f.evaluate(() => window.OS.dev.exec('watchdog', { op: 'verify' }));
  await ctx.unroute('**/__boot__.snapshot.js');
  if (!neg || neg.ok !== false || neg.js !== false) bad.push('verify 负控未拒绝错误页: ' + JSON.stringify(neg));

  await L.shot(p, 'T18_watchdog_cmds');
  await b.close(); srv.close();
  L.done(bad.length === 0,
    bad.length ? bad.join('; ') :
      'ok: status.cc=' + R.status.cc + ' bytes=' + R.status.bytes +
      '; verify.js=' + R.verify.js + '; refreshReqs=' + afterRefresh + '; negJs=' + neg.js,
    { status: R.status, verify: R.verify, neg, afterRefresh });
})().catch(e => L.done(false, '异常: ' + e.message));
