/* GeoGebra 健壮性回归：异常关闭 / 缓存缺失 / 加载失败 / 离线
 * 断言：不出现永久白屏；失败时给出可见提示与“重试”；正常时可绘图。 */
const L = require('./lib');
const R = []; const ok = (n, c, d) => R.push({ n, ok: !!c, d: d || '' });

async function withPage(fn, routeFn) {
  const b = await L.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message.slice(0, 100)));
  if (routeFn) await ctx.route('**/*', routeFn);
  await p.goto(L.MOUNT + 'nova.html', { waitUntil: 'load', timeout: 25000 });
  await L.waitOsReady(p, 15000);
  await p.click('#nv-lock', { force: true });
  await p.waitForTimeout(400);
  await p.evaluate(async () => {
    const cat = await (await fetch('sys/app-catalog')).json();
    const it = (cat.apps || []).find(a => a.id === 'geogebra');
    const r = await fetch('sys/app-package?f=' + encodeURIComponent(it.file));
    await window.OS.pkg.install(await r.blob());
  });
  try { await fn(p, ctx); } finally { await b.close(); }
  return errs;
}

function state(p) {
  return p.evaluate(() => {
    const fr = [...document.querySelectorAll('iframe')].find(f => /lib\/geogebra/.test(f.src || ''));
    let c = 0, tip = '', btn = false;
    try {
      const d = fr.contentDocument;
      c = d.querySelectorAll('#applet canvas').length;
      tip = (d.getElementById('tip') || {}).innerText || '';
      btn = !!d.querySelector('#tip button');
    } catch (e) { tip = 'INACCESSIBLE'; }
    const panel = document.querySelector('.nv-geo-fail');
    return { canvases: c, tip: tip.slice(0, 40), tipBtn: btn, outerBtn: !!panel };
  });
}

(async () => {
  // 1) 异常关闭：加载中连续快速开关，最终重开必须可用
  {
    const errs = await withPage(async p => {
      for (let i = 0; i < 6; i++) {
        await p.evaluate(() => window.OS.openApp('geogebra'));
        await p.waitForTimeout(1200 + i * 200);
        await p.evaluate(() => window.OS.closeApp('geogebra'));
        await p.waitForTimeout(300);
      }
      await p.evaluate(() => window.OS.openApp('geogebra'));
      await p.waitForTimeout(16000);
      const st = await state(p);
      ok('异常关闭后可重开', st.canvases > 0, JSON.stringify(st));
    });
    ok('异常关闭无致命错误', errs.length === 0, errs[0] || '');
  }

  // 2) 缓存缺失 / 加载失败：引擎脚本被拦截时必须给出重试，恢复后可打开
  {
    let block = true;
    const errs = await withPage(async p => {
      await p.evaluate(() => window.OS.openApp('geogebra'));
      await p.waitForTimeout(23000);
      const bad = await state(p);
      ok('加载失败不白屏', bad.tipBtn || bad.outerBtn, JSON.stringify(bad));
      block = false;
      await p.evaluate(() => {
        const b = [...document.querySelectorAll('.winbox button')].find(x => x.textContent.trim() === '重试');
        if (b) return b.click();
        const fr = [...document.querySelectorAll('iframe')].find(f => /lib\/geogebra/.test(f.src || ''));
        const t = fr && fr.contentDocument && fr.contentDocument.querySelector('#tip button');
        t && t.click();
      });
      await p.waitForTimeout(18000);
      const good = await state(p);
      ok('恢复后重试成功', good.canvases > 0, JSON.stringify(good));
    }, async r => {
      const u = r.request().url();
      if (block && /web3d\/.*\.js$/.test(u)) return r.abort();
      return r.continue();
    });
    ok('加载失败场景无致命错误', errs.length === 0, errs[0] || '');
  }

  R.forEach(x => console.log((x.ok ? '  PASS ' : '  FAIL ') + x.n + (x.d ? '  ' + x.d : '')));
  process.exit(R.some(x => !x.ok) ? 1 : 0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
