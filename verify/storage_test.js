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

  await p.evaluate(() => { localStorage.setItem('nova2.testdata', 'x'.repeat(2000)); });
  await p.waitForTimeout(300);

  await p.evaluate(() => window.OS.openApp('settings'));
  // 轮询等待“存储占用”卡片渲染完成（首次构建应用可能较慢）
  for (let i = 0; i < 20; i++) {
    const ready = await p.evaluate(() => [...document.querySelectorAll('.nv-set-card h4')]
      .some(h => h.textContent.includes('存储占用')));
    if (ready) break;
    await p.waitForTimeout(500);
  }
  await p.waitForTimeout(1200);

  const readRows = () => p.evaluate(() => {
    const card = [...document.querySelectorAll('.nv-set-card')]
      .find(c => c.querySelector('h4') && c.querySelector('h4').textContent.includes('存储占用'));
    if (!card) return null;
    return [...card.querySelectorAll('.nv-set-row')].map(r => ({
      k: (r.querySelector('.nv-set-k')||{}).textContent || '',
      v: (r.querySelector('.nv-set-v')||{}).textContent || '',
      hidden: r.style.display === 'none'
    }));
  });
  const clickSeg = (label) => p.evaluate((l) => {
    const card = [...document.querySelectorAll('.nv-set-card')]
      .find(c => c.querySelector('h4') && c.querySelector('h4').textContent.includes('存储占用'));
    const b = [...card.querySelectorAll('.nv-seg button')].find(x => x.textContent === l);
    if (b) b.click();
  }, label);

  let st = await readRows();
  ok('存储卡片存在', !!st);
  const get = k => ((st.find(r => r.k.includes(k)) || {}).v || '');

  ok('环境有结果', /WebView|浏览器/.test(get('运行环境')), get('运行环境'));
  ok('默认储存视图隐藏总计', (st.find(r=>r.k.includes('本源总计'))||{}).hidden === true);
  ok('系统自身已出值', !/统计中|—/.test(get('系统自身')), get('系统自身'));
  ok('离线空间已出值', !/统计中|—/.test(get('离线空间')), get('离线空间'));
  ok('原页面有结论', /不可读取|B|KB/.test(get('原页面')), get('原页面'));

  await clickSeg('总体占用');
  await p.waitForTimeout(2000);
  st = await readRows();
  ok('总体显示本源总计', (st.find(r=>r.k.includes('本源总计'))||{}).hidden === false);
  ok('总体显示配额', (st.find(r=>r.k.includes('配额'))||{}).hidden === false);
  const barW = await p.evaluate(() => {
    const card = [...document.querySelectorAll('.nv-set-card')]
      .find(c => c.querySelector('h4') && c.querySelector('h4').textContent.includes('存储占用'));
    return card.querySelector('.nv-set-bar i').style.width;
  });
  ok('进度条有宽度', /%/.test(barW), barW);

  await clickSeg('储存');
  await p.waitForTimeout(1500);
  st = await readRows();
  ok('切回储存隐藏总计', (st.find(r=>r.k.includes('本源总计'))||{}).hidden === true);

  ok('无 JS 错误', errs.length===0, errs[0]||'');
  await p.evaluate(()=>{ try { localStorage.removeItem('nova2.testdata'); } catch(e){} });
  await b.close();
  R.forEach(r=>console.log((r.ok?'  PASS ':'  FAIL ')+r.n+(r.d?'  '+r.d:'')));
  process.exit(R.some(r=>!r.ok)?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
