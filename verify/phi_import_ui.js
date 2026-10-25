const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load', timeout: 25000 });
  await L.waitOsReady(p, 15000);
  await p.click('#nv-lock', { force: true });
  await p.waitForTimeout(500);

  // 直接构造 phi 外壳的导入面板 DOM（复用同一套 CSS 类），验证配色
  const r = await p.evaluate(() => {
    function mk(cls, html, parent) {
      const d = document.createElement('div');
      d.className = cls;
      if (html) d.innerHTML = html;
      (parent || document.body).appendChild(d);
      return d;
    }
    const mask = mk('nv-phi-mask');
    const panel = mk('nv-phi-panel', '', mask);
    mk('nv-phi-head', '从离线空间导入', panel);
    mk('nv-phi-crumbs', '离线空间 / 谱面', panel);
    const list = mk('nv-phi-list', '', panel);
    mk('nv-phi-row', '<span class="nv-phi-ic">📄</span><span class="nv-phi-nm">chart.json</span><span class="nv-phi-sz">12 KB</span>', list);
    mk('nv-phi-prog', '已发送 1/3：chart.json', panel);
    mk('nv-phi-foot', '<button class="nv-btn">取消</button>', panel);

    const lum = (c) => {
      const m = c.match(/\d+/g); if (!m) return null;
      const v = [0,1,2].map(i => { let x = +m[i]/255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
      return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2];
    };
    const pick = (sel) => {
      const el = document.querySelector(sel);
      const s = getComputedStyle(el);
      const bl = lum(s.backgroundColor), fl = lum(s.color);
      const hi = Math.max(bl, fl), lo = Math.min(bl, fl);
      return { bg: s.backgroundColor, fg: s.color, ratio: ((hi+0.05)/(lo+0.05)).toFixed(2) };
    };
    const out = { panel: pick('.nv-phi-panel'), crumbs: pick('.nv-phi-crumbs'),
                  prog: pick('.nv-phi-prog'), nm: pick('.nv-phi-nm') };
    mask.remove();
    return out;
  });
  const check = (name, o) => ok(name + ' 对比度>=4.5', +o.ratio >= 4.5,
    'ratio=' + o.ratio + ' bg=' + o.bg + ' fg=' + o.fg);
  check('面板', r.panel);
  check('面包屑', r.crumbs);
  check('进度条', r.prog);
  check('文件名', r.nm);
  await b.close();
  R.forEach(x=>console.log((x.ok?'  PASS ':'  FAIL ')+x.n+(x.d?'  '+x.d:'')));
  process.exit(R.some(x=>!x.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
