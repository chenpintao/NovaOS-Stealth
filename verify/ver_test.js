const L = require('./lib');
(async () => {
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load', timeout: 25000 });
  await L.waitOsReady(p, 15000);
  await p.click('#nv-lock', { force: true });
  await p.waitForTimeout(500);
  await p.evaluate(() => window.OS.openApp('settings'));
  for (let i=0;i<20;i++){
    const ok = await p.evaluate(()=>[...document.querySelectorAll('.nv-set-card h4')].some(h=>h.textContent.includes('关于')));
    if (ok) break; await p.waitForTimeout(400);
  }
  const v = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.nv-set-row')];
    const r = rows.find(x => x.textContent.includes('系统版本'));
    return r ? r.textContent.replace(/\s+/g,' ').trim() : null;
  });
  console.log('版本行:', v);
  console.log('errors:', errs.slice(0,2));
  await b.close();
  process.exit(/2\.1\.0/.test(v||'') ? 0 : 1);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
