const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  const ext=[];
  p.on('request', r => {
    const u = r.url();
    if (/geogebra\.org|geogebra\.com/.test(u) && !u.includes('127.0.0.1') && !u.includes('web-alicdn')) ext.push(u);
  });
  const failed=[];
  p.on('requestfailed', r => failed.push(r.url().split('/').slice(-2).join('/')));

  const t0 = Date.now();
  await p.goto(L.MOUNT + 'lib/geogebra/index.html', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(20000);
  const dt = Date.now() - t0;

  const st = await p.evaluate(() => ({
    tipVisible: (() => { const t = document.getElementById('tip'); return t && getComputedStyle(t).display !== 'none'; })(),
    canvases: document.querySelectorAll('#applet canvas').length,
    hasApplet: !!document.querySelector('.appletScaling, #applet > div'),
    title: document.title,
    bodyText: (document.body.innerText || '').slice(0, 80)
  }));
  console.log('加载耗时:', (dt/1000).toFixed(1) + 's');
  console.log('状态:', JSON.stringify(st));
  console.log('外网 geogebra 请求:', ext.length, ext.slice(0,3));
  console.log('失败请求:', failed.length, failed.slice(0,4));
  console.log('errors:', errs.slice(0,3));
  ok('无致命错误', errs.length === 0, errs[0] || '');
  ok('未请求外网引擎', ext.length === 0, 'ext=' + ext.length);
  ok('画布已创建', st.canvases > 0 || st.hasApplet, 'canvas=' + st.canvases);
  await b.close();
  R.forEach(x=>console.log((x.ok?'  PASS ':'  FAIL ')+x.n+(x.d?'  '+x.d:'')));
  process.exit(R.some(x=>!x.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
