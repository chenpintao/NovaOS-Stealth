const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  // 用同一域名 + 同端口，模拟真实注入（宿主页与 OS 同源）
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load', timeout: 25000 });
  await L.waitOsReady(p, 15000);

  // 在同一源下模拟“宿主页面 + iframe”结构
  const r = await p.evaluate(async () => {
    // 造宿主页存储（当前源）
    for (let i = 0; i < 5; i++) localStorage.setItem('hostk_' + i, 'z'.repeat(400));
    // 建一个同源 iframe 充当 OS，验证它能否读到父页面存储
    const f = document.createElement('iframe');
    f.src = location.pathname;
    f.style.cssText = 'position:absolute;left:-9999px;width:10px;height:10px';
    document.body.appendChild(f);
    await new Promise(res => { f.onload = res; setTimeout(res, 6000); });
    let out;
    try {
      const w = f.contentWindow;
      const ls = w.parent.localStorage;
      let bytes = 0, n = 0;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i); bytes += (k + (ls.getItem(k) || '')).length; n++;
      }
      out = { sameOrigin: true, bytes, keys: n };
    } catch (e) { out = { sameOrigin: false, err: e.message }; }
    return out;
  });
  ok('同源可读父页面存储', r.sameOrigin === true, JSON.stringify(r));
  ok('读到宿主键', (r.keys || 0) >= 5, 'keys=' + r.keys);
  await p.evaluate(()=>{ for (let i=0;i<5;i++) localStorage.removeItem('hostk_'+i); });
  await b.close();
  R.forEach(x=>console.log((x.ok?'  PASS ':'  FAIL ')+x.n+(x.d?'  '+x.d:'')));
  process.exit(R.some(x=>!x.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
