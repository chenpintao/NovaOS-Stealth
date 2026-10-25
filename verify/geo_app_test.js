const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const ext=[]; const errs=[];
  p.on('request', r => { const u=r.url(); if (/geogebra\.org/.test(u) && !u.includes('127.0.0.1') && !u.includes('web-alicdn')) ext.push(u); });
  p.on('pageerror', e => errs.push(e.message));

  await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load', timeout: 25000 });
  await L.waitOsReady(p, 15000);
  await p.click('#nv-lock', { force: true });
  await p.waitForTimeout(500);

  // 安装 geogebra 包
  const inst = await p.evaluate(async () => {
    try {
      const cat = await (await fetch('sys/app-catalog')).json();
      const it = (cat.apps || []).find(a => a.id === 'geogebra');
      if (!it) return 'NO_CATALOG_ENTRY';
      const r = await fetch('sys/app-package?f=' + encodeURIComponent(it.file)).catch(() => null);
      if (!r || !r.ok) return 'FETCH ' + (r ? r.status : 'null');
      const blob = await r.blob();
      await window.OS.pkg.install(blob);
      return 'ok';
    } catch (e) { return 'ERR ' + e.message; }
  });
  console.log('安装结果:', inst);
  await p.waitForTimeout(1500);

  const listed = await p.evaluate(() => window.OS.apps().some(a => a.id === 'geogebra'));
  ok('geogebra 已注册', listed);

  if (listed) {
    await p.evaluate(() => window.OS.openApp('geogebra'));
    await p.waitForTimeout(22000);
    const st = await p.evaluate(() => {
      const fr = [...document.querySelectorAll('iframe')].find(f => /lib\/geogebra/.test(f.src || ''));
      let inner = null;
      try {
        const d = fr.contentDocument;
        inner = d ? { canvases: d.querySelectorAll('#applet canvas').length,
                      tip: (() => { const t = d.getElementById('tip'); return t ? getComputedStyle(t).display : 'none'; })() } : null;
      } catch (e) { inner = 'cross-origin'; }
      return { hasFrame: !!fr, src: fr ? fr.src.split('/__nova__/')[1] : null, inner };
    });
    console.log('应用状态:', JSON.stringify(st));
    ok('iframe 指向本地页面', !!st.hasFrame && /lib\/geogebra\/index\.html/.test(st.src || ''), st.src);
    ok('引擎画布已创建', st.inner && st.inner.canvases > 0, JSON.stringify(st.inner));
  }
  ok('无外网引擎请求', ext.length === 0, 'ext=' + ext.length);
  ok('无 JS 错误', errs.length === 0, errs[0] || '');
  await b.close();
  R.forEach(x=>console.log((x.ok?'  PASS ':'  FAIL ')+x.n+(x.d?'  '+x.d:'')));
  process.exit(R.some(x=>!x.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
