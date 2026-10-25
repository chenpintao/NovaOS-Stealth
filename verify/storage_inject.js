const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  const srv = await L.hostPageServer(8096);
  const b = await L.launch({ hostLocal: 8096 });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://host.local:8096/column.html');
  // 给宿主页面造点存储
  await p.evaluate(() => {
    for (let i = 0; i < 6; i++) localStorage.setItem('host_key_' + i, 'y'.repeat(500));
  });
  await L.injectStub(p);
  await L.activate(p);
  const f = await L.waitOsReady(p, 25000);
  ok('注入后 OS 启动', !!f);

  const info = await f.evaluate(async () => {
    const u = await window.OS.vfs.usage();
    return await window.OS.storage('total', u);
  });
  ok('识别为 WebView/嵌入态', info.env.webview === true, JSON.stringify(info.env));
  ok('可读宿主页面存储', info.hostPage.sameOrigin === true,
     JSON.stringify(info.hostPage && {bytes: info.hostPage.bytes, keys: info.hostPage.keys}));
  ok('宿主存储字节 > 3000', (info.hostPage.bytes || 0) > 3000, String(info.hostPage.bytes));
  ok('系统自身有值', info.osTotal >= 0, String(info.osTotal));
  ok('无 JS 错误', errs.length===0, errs[0]||'');
  await b.close(); srv.close();
  R.forEach(r=>console.log((r.ok?'  PASS ':'  FAIL ')+r.n+(r.d?'  '+r.d:'')));
  process.exit(R.some(r=>!r.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
