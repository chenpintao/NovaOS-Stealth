const L = require('./lib');
const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d:d||''});
(async () => {
  for (const vp of [{width:1280,height:800},{width:900,height:600},{width:760,height:1200}]) {
    const b = await L.launch();
    const ctx = await b.newContext({ viewport: vp });
    const p = await ctx.newPage();
    const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load' });
    await L.waitOsReady(p, 20000);
    await p.click('#nv-lock', { force: true });
    await p.waitForTimeout(500);
    await p.evaluate(() => window.OS.openApp('files'));
    await p.waitForTimeout(1000);

    const tag = vp.width + 'x' + vp.height;
    // A. 普通窗口默认位置不与状态栏重叠
    let g = await p.evaluate(() => {
      const sb = document.querySelector('.nv-statusbar').getBoundingClientRect();
      const wb = document.querySelector('.winbox').getBoundingClientRect();
      return { sbB: sb.bottom, winT: wb.top, overlap: !(sb.bottom <= wb.top) };
    });
    ok(tag + ' 默认不遮挡', !g.overlap, 'winTop=' + Math.round(g.winT));

    // B. 拖动到顶部受限
    const hd = await p.$('.winbox .wb-header');
    const box = await hd.boundingBox();
    await p.mouse.move(box.x + box.width/2, box.y + box.height/2);
    await p.mouse.down();
    await p.mouse.move(box.x + box.width/2, 2, { steps: 10 });
    await p.mouse.up();
    await p.waitForTimeout(400);
    g = await p.evaluate(() => {
      const sb = document.querySelector('.nv-statusbar').getBoundingClientRect();
      const wb = document.querySelector('.winbox').getBoundingClientRect();
      const el = document.elementFromPoint(wb.left + 100, wb.top + 12);
      return { winT: wb.top, sbB: sb.bottom, overlap: !(sb.bottom <= wb.top),
               hitSB: !!(el && el.closest && el.closest('.nv-statusbar')) };
    });
    ok(tag + ' 拖顶不越界', !g.overlap && !g.hitSB, 'winTop=' + Math.round(g.winT));

    // C. 最大化不裁底部
    await p.dblclick('.winbox .wb-header');
    await p.waitForTimeout(600);
    g = await p.evaluate(() => {
      const body = document.querySelector('.winbox .wb-body').getBoundingClientRect();
      const sb = document.querySelector('.nv-statusbar').getBoundingClientRect();
      const wb = document.querySelector('.winbox').getBoundingClientRect();
      return { bodyBottom: body.bottom, vh: innerHeight, winTop: wb.top,
               clipped: body.bottom > innerHeight + 1, sbB: sb.bottom };
    });
    ok(tag + ' 最大化不裁底', !g.clipped, 'bodyBottom=' + Math.round(g.bodyBottom) + '/' + g.vh);
    ok(tag + ' 最大化不遮标题', g.winTop >= g.sbB - 1, 'winTop=' + Math.round(g.winTop));
    ok(tag + ' 无 JS 错误', errs.length === 0, errs[0] || '');
    await b.close();
  }
  R.forEach(r=>console.log((r.ok?'  PASS ':'  FAIL ')+r.n+(r.d?'  '+r.d:'')));
  process.exit(R.some(r=>!r.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
