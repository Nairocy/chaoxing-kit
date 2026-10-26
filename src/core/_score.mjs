// 读成绩页：总分 + 每题我的答案/正确答案
import { CDP, sleep } from './cdp.mjs';
const cdp = await CDP.attach(Number(process.env.CX_PORT || 9231), { match: (t) => t.type === 'page' });
await cdp.send('Runtime.enable');
await sleep(500);
const f = (await cdp.frameTree()).find((x) => /doHomeWorkNew|selectWorkQuestion/.test(x.url));
if (!f) { console.log('no work frame'); process.exit(0); }
const out = await cdp.eval(`(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const t = norm(document.body ? document.body.innerText : '');
  const qs = [...document.querySelectorAll('.TiMu')].map((q) => {
    const m = norm(q.innerText).match(/我的答案[:：]\\s*([A-Za-z、,，]*)/);
    const c = norm(q.innerText).match(/正确答案[:：]\\s*([A-Za-z、,，]*)/);
    const s = norm(q.innerText).match(/(\\d+(?:\\.\\d+)?)\\s*分/);
    return { my: m ? m[1] : '', right: c ? c[1] : '', score: s ? s[1] : '' };
  });
  const total = t.match(/得分[:：]?\\s*(\\d+(?:\\.\\d+)?)/) || t.match(/(\\d+(?:\\.\\d+)?)\\s*\\/\\s*100/);
  return { total: total ? total[1] : '', qs, head: t.slice(0, 260) };
})()`, { frameId: f.id }).catch((e) => ({ err: e.message }));
console.log(JSON.stringify(out, null, 1));
cdp.close();
