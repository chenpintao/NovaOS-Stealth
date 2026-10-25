const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load', timeout: 25000 });
  await L.waitOsReady(p, 15000);
  await p.click('#nv-lock', { force: true });
  await p.waitForTimeout(600);

  // 逐个打开应用，检查主容器背景是否为深色
  const apps = await p.evaluate(() => window.OS.apps().map(a => a.id));
  for (const id of apps) {
    await p.evaluate(i => window.OS.openApp(i), id);
    await p.waitForTimeout(900);
    const r = await p.evaluate(() => {
      const root = document.querySelector('.winbox .nv-app-root, .winbox .nv-wrap, .winbox .wrap');
      const body = document.querySelector('.winbox .wb-body > *');
      const el = root || body;
      if (!el) return null;
      const c = getComputedStyle(el);
      const m = c.backgroundColor.match(/\d+/g);
      const lum = m ? (0.299*+m[0] + 0.587*+m[1] + 0.114*+m[2]) : null;
      return { bg: c.backgroundColor, lum, color: c.color };
    });
    if (r) ok(id + ' 深色底', r.lum !== null && r.lum < 120, 'lum=' + (r.lum|0) + ' ' + r.bg);
    await p.evaluate(i => window.OS.closeApp(i), id);
    await p.waitForTimeout(250);
  }
  ok('无 JS 错误', errs.length===0, errs.slice(0,2).join('|'));
  await b.close();
  R.forEach(x=>console.log((x.ok?'  PASS ':'  FAIL ')+x.n+(x.d?'  '+x.d:'')));
  process.exit(R.some(x=>!x.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
