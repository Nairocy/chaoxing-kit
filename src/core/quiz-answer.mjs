// 章节测验作答器（超星字体混淆 → 只能按"位置索引"点选，不能按文字匹配）
// 用法:
//   CX_ANS="1:B,2:B,3:A,4:C,5:BCD" node src/quiz-answer.mjs        # 只勾选，不提交
//   CX_ANS="..." CX_SUBMIT=1 node src/quiz-answer.mjs               # 勾选后点提交
//   node src/quiz-answer.mjs --map                                  # 只打印题目/选项结构，不点
//
// 结构（实测）：选项行 = 作业帧内 div.fl.after，按 DOM 顺序 每题4行连续排列；
//              末尾两个按钮为「暂时保存」「提交」（文字未混淆，可读）
import { CDP, sleep } from './cdp.mjs';

const PORT = Number(process.env.CX_PORT || 9231);
const ANS = process.env.CX_ANS || '';
const SUBMIT = process.env.CX_SUBMIT === '1';
const MAP_ONLY = process.argv.includes('--map');

const cdp = await CDP.attach(PORT, { match: (t) => t.type === 'page' });
await cdp.enableDomains();
await sleep(600);

const frames = await cdp.frameTree();
const wf = frames.find((f) => /work\/doHomeWorkNew/.test(f.url));
if (!wf) {
  console.error('找不到作业帧，现有帧:');
  for (const f of frames) console.log('  ', f.url.slice(0, 90));
  process.exit(1);
}
console.log('作业帧:', wf.id.slice(0, 8), wf.url.slice(0, 90));

// 在作业帧内：收集选项行 + 按钮，并把坐标换算到顶层视口
const MAP = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const abs = (el) => {
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2, y = r.top + r.height / 2, w = window, hops = 0;
    while (w !== w.top && hops++ < 10) {
      const fe = w.frameElement; if (!fe) break;
      const fr = fe.getBoundingClientRect(); const cs = getComputedStyle(fe);
      x += fr.left + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0');
      y += fr.top + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0');
      w = w.parent;
    }
    return [Math.round(x), Math.round(y)];
  };
  const opts = [...document.querySelectorAll('a.fl.after')].map((e, i) => ({
    i, txt: norm(e.innerText).slice(0, 24), xy: abs(e), vis: !!(e.offsetWidth || e.offsetHeight),
    checked: !!e.querySelector('input:checked') || /cur|active|selected/.test((e.className || '').toString()),
  }));
  const btns = [...document.querySelectorAll('a,button,div[class*=btn],span[class*=btn],input[type=button],input[type=submit]')]
    .filter((e) => !!(e.offsetWidth || e.offsetHeight))
    .map((e) => ({ txt: norm(e.innerText || e.value).slice(0, 20), cls: (e.className || '').toString().slice(0, 50), xy: abs(e) }))
    .filter((b) => b.txt);
  return { opts, btns, qCount: document.querySelectorAll('a.fl.after').length };
})()`;

let map = await cdp.eval(MAP, { frameId: wf.id });
console.log('选项行数:', map.qCount);
for (const o of map.opts) console.log(`  #${o.i} "${o.txt}" xy=${o.xy} vis=${o.vis} ${o.checked ? '[已选?]' : ''}`);
console.log('按钮:');
for (const b of map.btns) console.log(`  [${b.txt}] cls=${b.cls} xy=${b.xy}`);

if (MAP_ONLY) { cdp.close(); process.exit(0); }
// CX_SUBMIT_ONLY=1：只提交，不再点选项（重复点选会把多选题的已选项取消掉）
const SUBMIT_ONLY = process.env.CX_SUBMIT_ONLY === '1';
if (!ANS && !SUBMIT_ONLY) { console.error('未给 CX_ANS 也未给 CX_SUBMIT_ONLY，退出'); cdp.close(); process.exit(1); }

/** 每题选项数：CX_PERQ="4,4,2"（默认全 4）；索引 = 前面各题选项数累加 + 字母序号 */
const perQ = (process.env.CX_PERQ || '4').split(',').map((x) => Number(x.trim()));
const base = [];
for (let i = 0, acc = 0; i < 40; i++) { const n = perQ[i] ?? perQ[perQ.length - 1]; base.push(acc); acc += n; }
const plan = [];
for (const part of ANS.split(',')) {
  const m = part.trim().match(/^(\d+)\s*[:：]\s*([A-Za-z]+)$/);
  if (!m) { console.error('无法解析:', part); continue; }
  const q = Number(m[1]);
  for (const ch of m[2].toUpperCase()) {
    const li = ch.charCodeAt(0) - 65;
    if (li < 0 || li > 25) continue;
    plan.push({ q, letter: ch, idx: base[q - 1] + li });
  }
}

const absOf = async (idx) => cdp.eval(`(() => {
  const e = document.querySelectorAll('a.fl.after')[${idx}];
  if (!e) return null;
  e.scrollIntoView({ block: 'center' });            // 关键：元素不在视口内点击会落到空处
  const r = e.getBoundingClientRect();
  let x = r.left + r.width / 2, y = r.top + r.height / 2, w = window, hops = 0;
  while (w !== w.top && hops++ < 10) {
    const fe = w.frameElement; if (!fe) break;
    const fr = fe.getBoundingClientRect(); const cs = getComputedStyle(fe);
    x += fr.left + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0');
    y += fr.top + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0');
    w = w.parent;
  }
  return { xy: [Math.round(x), Math.round(y)], txt: (e.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
           topVw: window.top.innerWidth, topVh: window.top.innerHeight };
})()`, { frameId: wf.id });

if (!SUBMIT_ONLY) for (const p of plan) {
  const o = await absOf(p.idx);
  if (!o) { console.log(`跳过 Q${p.q}${p.letter}（无第 ${p.idx} 行）`); continue; }
  if (o.xy[0] <= 0 || o.xy[1] <= 0 || o.xy[0] > o.topVw || o.xy[1] > o.topVh) {
    console.log(`⚠ Q${p.q}${p.letter} 坐标越界 ${o.xy}（视口 ${o.topVw}x${o.topVh}），跳过`);
    continue;
  }
  await cdp.click(o.xy[0], o.xy[1]);
  console.log(`点击 Q${p.q}${p.letter} → 行#${p.idx} @ ${o.xy} "${o.txt}"`);
  await sleep(400);
}

await sleep(800);
map = await cdp.eval(MAP, { frameId: wf.id });
console.log('\n=== 点击后状态 ===');
for (const o of map.opts) if (o.checked) console.log(`  #${o.i} "${o.txt}" → 已选中`);

const shot = `shots/quiz-answered-${Date.now()}.png`;
await cdp.eval('window.scrollTo(0,0)').catch(() => {});
await sleep(600);
try { await cdp.screenshot(shot, { fullPage: true }); console.log('截图:', shot); } catch (e) { console.log('截图失败', e.message); }

/** 在指定帧里按 JS 找元素 → scrollIntoView → 换算到顶层视口 → 真实点击
 *  ⚠ 必须先 scrollIntoView：元素在视口外时，即便算出坐标点出去也落空（实测提交按钮就这么丢的） */
async function clickIn(frameId, jsFinder) {
  const xy = await cdp.eval(`(() => {
    const el = ${jsFinder};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2, y = r.top + r.height / 2, w = window, hops = 0;
    while (w !== w.top && hops++ < 10) {
      const fe = w.frameElement; if (!fe) break;
      const fr = fe.getBoundingClientRect(); const cs = getComputedStyle(fe);
      x += fr.left + parseFloat(cs.borderLeftWidth || '0') + parseFloat(cs.paddingLeft || '0');
      y += fr.top + parseFloat(cs.borderTopWidth || '0') + parseFloat(cs.paddingTop || '0');
      w = w.parent;
    }
    return [Math.round(x), Math.round(y)];
  })()`, frameId ? { frameId } : {});
  if (!xy) return null;
  await cdp.click(xy[0], xy[1]);
  return xy;
}

if (SUBMIT) {
  const CONFIRM_ONLY = process.env.CX_CONFIRM_ONLY === '1';
  const BT = `[...document.querySelectorAll('a,button,div[class*=btn],span[class*=btn]')].find((e) => /^提交$/.test((e.innerText || '').trim()) && (e.offsetWidth || e.offsetHeight))`;
  const xy = CONFIRM_ONLY ? 'skip' : await clickIn(wf.id, BT);
  if (!CONFIRM_ONLY) console.log(xy ? `已点击「提交」 @ ${xy}` : '找不到「提交」按钮');
  if (xy || CONFIRM_ONLY) {
    if (!CONFIRM_ONLY) await sleep(2000);
    // 二次确认弹窗（实测按钮文字是「提交/取消」，不叫"确定"）→ 优先在弹窗容器里找
    const CONF = `(() => {
      const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight));
      const boxes = [...document.querySelectorAll('[class*=mask],[id*=Pop],[id*=pop],[class*=popup],[class*=dialog]')].filter(vis);
      for (const c of boxes.reverse()) {
        const b = [...c.querySelectorAll('a,button,div,span')].find((e) => (e.innerText || '').trim() === '提交' && vis(e));
        if (b) return b;
      }
      const all = [...document.querySelectorAll('a,button,div,span')].filter((e) => (e.innerText || '').trim() === '提交' && vis(e));
      return all.length > 1 ? all[all.length - 1] : null;
    })()`;
    for (const fid of [undefined, wf.id]) {
      const c = await clickIn(fid, CONF);
      if (c) { console.log('已点二次确认', fid ? '(作业帧)' : '(顶层帧)', '@', c); await sleep(2500); break; }
    }
    if (!await cdp.eval(`document.readyState`)) {}
    await sleep(2500);
    const after = `shots/quiz-submitted-${Date.now()}.png`;
    try { await cdp.screenshot(after); console.log('提交后截图:', after); } catch {}
  }
}
cdp.close();
