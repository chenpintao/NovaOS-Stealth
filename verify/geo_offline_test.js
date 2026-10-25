const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load', timeout: 25000 });
  await L.waitOsReady(p, 15000);

  const files = [
    'web3d/web3d.nocache.js',
    'web3d/29EB0586CD5B749E221F6BB019F1B206.cache.js',
    'css/fonts.css',
    'css/greek-font.css',
    'web3d/js/properties_keys_zh-CN.js',
    'web3d/clear.cache.gif',
    'web3d/deferredjs/29EB0586CD5B749E221F6BB019F1B206/1.cache.js',
    'web3d/deferredjs/29EB0586CD5B749E221F6BB019F1B206/2.cache.js'
  ];
  for (const f of files) {
    const st = await p.evaluate(async (url) => {
      try { const r = await fetch(url, { method: 'HEAD' }); return r.status; }
      catch (e) { return 'ERR:' + e.message.slice(0,20); }
    }, L.MOUNT + 'lib/geogebra/' + f);
    ok(f.split('/').pop(), st === 200, String(st));
  }
  // 入口清理测试
  await b.close();
  R.forEach(x=>console.log((x.ok?'  PASS ':'  FAIL ')+x.n+(x.d?'  '+x.d:'')));
  process.exit(R.some(x=>!x.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
