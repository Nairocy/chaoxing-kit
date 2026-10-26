// 章节测验分段截图：滚动到 work 模块，按 700px 步进截 viewport（读题用）
import { CDP, sleep } from './cdp.mjs';
const NO = process.env.CX_NO || 'x';
const cdp = await CDP.attach(Number(process.env.CX_PORT || 9231), { match: (t) => t.type === 'page' });
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await sleep(500);
const frames = await cdp.frameTree();
const cards = frames.find((f) => /knowledge\/cards/.test(f.url));
if (!cards) { console.log('no cards frame'); process.exit(1); }
const pos = await cdp.eval(`(() => {
  const cf = [...document.querySelectorAll('iframe')].find((i) => /knowledge\\/cards/.test(i.src));
  const b = cf.getBoundingClientRect();
  return { top: b.top + window.scrollY, left: b.left, w: b.width };
})()`);
const wpos = await cdp.eval(`(() => {
  const wf = [...document.querySelectorAll('iframe')].find((i) => /modules\\/work/.test(i.src));
  if (!wf) return null;
  const r = wf.getBoundingClientRect();
  return { top: r.top, h: r.height, w: r.width };
})()`, { frameId: cards.id });
if (!wpos) { console.log('no work module in cards'); process.exit(2); }
const absTop = pos.top + wpos.top;
console.log('cardsTop=', Math.round(pos.top), 'workTop=', Math.round(wpos.top), 'abs=', Math.round(absTop), 'h=', Math.round(wpos.h));
const H = Math.min(wpos.h, 8000);
let n = 0;
for (let y = 0; y < H; y += 700) {
  await cdp.eval(`window.scrollTo(0, ${Math.round(absTop + y - 10)})`).catch(() => {});
  await sleep(800);
  n++;
  const p = `shots/q${NO}-p${n}.png`;
  await cdp.screenshot(p).catch((e) => console.log('shot err', e.message));
  console.log('SHOT', p);
}
cdp.close();
