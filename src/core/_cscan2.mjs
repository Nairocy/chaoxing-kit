// 通用课程扫描器 v2：门户目录 → 点首节进 studentstudy → getTeacherAjax 逐节点读 mArg
// 用法: CID=xxx CLA=yyy node src/_cscan2.mjs  (GAP=ms 每节点等待)
import { CDP, sleep } from './cdp.mjs';
const CID = process.env.CID, CLA = process.env.CLA, CPI = process.env.CPI || '568614919';
if (!CID || !CLA) { console.log('need CID/CLA'); process.exit(1); }

const cdp = await CDP.attach(Number(process.env.CX_PORT || 9231), { match: (t) => t.type === 'page' });
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

async function frameBy(re, tries = 16, gap = 1500) {
  for (let i = 0; i < tries; i++) {
    const f = (await cdp.frameTree()).find((x) => re.test(x.url));
    if (f) return f;
    await sleep(gap);
  }
  return null;
}
const normJs = `const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();`;

const PORTAL_CAT = `(() => { ${normJs}
  return [...document.querySelectorAll('.chapter_body .catalog_level li')].map((li) => {
    const it = li.querySelector('.chapter_item'), a = li.querySelector('a.clicktitle');
    const sb = li.querySelector('.catalog_sbar'), st = li.querySelector('.catalog_state'), cnt = li.querySelector('.knowledgeJobCount');
    return { id: it && it.id ? it.id.replace(/^cur/, '') : null, no: sb ? norm(sb.innerText) : '',
      t: a ? norm(a.innerText).slice(0, 40) : '', done: !!st, todo: !!cnt, cnt: cnt ? norm(cnt.value || cnt.innerText) : '' };
  }).filter((n) => n.id);
})()`;

const url = `https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${CID}&clazzid=${CLA}&vc=1&cpi=${CPI}&ismooc2=1&v=2`;
await cdp.send('Page.navigate', { url });
await sleep(9000);
let zj = await frameBy(/studentcourse/, 4, 1500);
if (!zj) {
  await cdp.eval(`(() => { const els=[...document.querySelectorAll('a,li,div,span')].filter(e=>(e.innerText||'').trim()==='章节'); if(els.length){const e=els[els.length-1]; const r=e.getBoundingClientRect(); return [Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)];} return null; })()`).catch(() => null).then(async (xy) => { if (Array.isArray(xy)) { await cdp.click(xy[0], xy[1]); } });
  await sleep(5000);
  zj = await frameBy(/studentcourse/, 10, 1500);
}
if (!zj) { console.log('NO_PORTAL'); process.exit(1); }
const title = await cdp.eval('document.title');
const nodes = await cdp.eval(PORTAL_CAT, { frameId: zj.id });
console.log('TITLE', String(title).slice(0, 60), '| 目录节点', nodes.length);

const first = nodes.find((n) => n.id);
await cdp.eval(`(() => { const lis=[...document.querySelectorAll('.chapter_body .catalog_level li')];
  const li = lis.find(l => { const it=l.querySelector('.chapter_item'); return it && it.id === 'cur${first.id}'; });
  if (!li) return 0; const a = li.querySelector('a.clicktitle'); if(a) a.click(); return 1; })()`, { frameId: zj.id }).catch(() => {});
await sleep(12000);
const ss = await frameBy(/studentstudy/, 8, 2000);
console.log('STUDENTSTUDY', ss ? 'ok' : 'MISS', (await cdp.eval('location.href')).slice(0, 130));

const SS_CAT = `(() => { ${normJs}
  return [...document.querySelectorAll('.posCatalog_level li')].map((li) => {
    const sel = li.querySelector('.posCatalog_select'), nm = li.querySelector('.posCatalog_name');
    const sb = li.querySelector('.posCatalog_sbar'), hid = li.querySelector('.jobUnfinishCount');
    return { id: sel && sel.id ? sel.id.replace(/^cur/, '') : null, no: sb ? norm(sb.innerText) : '',
      t: nm ? norm(nm.innerText).slice(0, 40) : '', done: !!li.querySelector('.icon_Completed'),
      todo: !!li.querySelector('.catalog_points_yi'), cnt: hid ? hid.value : '' };
  }).filter((n) => n.id);
})()`;
let list = await cdp.eval(SS_CAT).catch(() => []);
if (!Array.isArray(list) || !list.length) list = nodes;
console.log('队列节点', list.length, 'done', list.filter((n) => n.done).length);
const START = Number(process.env.START || 0), LIMIT = Number(process.env.LIMIT || 999);
const allList = list;
list = list.slice(START, START + LIMIT);
console.log('本片 START', START, 'LIMIT', LIMIT, '=> 处理', list.length);

const rows = [];
for (const n of list) {
  await cdp.eval(`(() => { try { getTeacherAjax(${JSON.stringify(CID)}, ${JSON.stringify(CLA)}, ${JSON.stringify(n.id)}); return 1; } catch (e) { return 0; } })()`).catch(() => 0);
  await sleep(Number(process.env.GAP || 6500));
  const cards = await frameBy(/knowledge\/cards/, 5, 1200);
  let at = [], dct2 = false;
  if (cards) {
    at = await cdp.eval(`(() => (((window.mArg || {}).attachments) || []).map((a) => ({ jobid: a.jobid, type: a.type, isPassed: a.isPassed, head: a.headOffset, dur: a.attDuration })))()`, { frameId: cards.id }).catch(() => []);
    dct2 = await cdp.eval(`(() => !!document.getElementById('dct2'))()`).catch(() => false);
  }
  const mods = (await cdp.frameTree()).filter((f) => /ananas\/modules\/(video|pdf|work|zt)/.test(f.url)).map((f) => (f.url.match(/modules\/(\w+)\//) || [])[1]);
  const modsS = [...new Set(mods)].join('+');
  rows.push({ no: n.no, kid: n.id, t: n.t, cnt: n.cnt, done: n.done, dct2, mods: modsS, at });
  console.log(`${String(n.no).padEnd(6)} cnt=${String(n.cnt).padEnd(2)} ${n.done ? 'DONE' : 'todo'} dct2=${dct2 ? 'Y' : 'n'} mod=${modsS.padEnd(12)} | ${at.map((x) => `${x.type}(${x.jobid ? 'J' : '-'},p${x.isPassed ? 1 : 0},${x.dur || '-'}s)`).join(' ')} | ${n.t}`);
}

const vids = rows.flatMap((r) => r.at.filter((x) => x.type === 'video'));
const totalSec = vids.reduce((s, x) => s + (Number(x.dur) || 0), 0);
const kinds = {};
for (const r of rows) for (const x of r.at) kinds[x.type] = (kinds[x.type] || 0) + 1;
console.log('=== 视频任务点', vids.length, '总时长', (totalSec / 3600).toFixed(2), 'h');
console.log('=== 类型统计', JSON.stringify(kinds));
console.log('=== 带 dct2 内嵌测验节点', rows.filter((r) => r.dct2).length);
const fs = await import('node:fs');
fs.mkdirSync('state', { recursive: true });
fs.writeFileSync(`state/scan-${CID}-part${START}.json`, JSON.stringify(rows, null, 1));
console.log('SAVED state/scan-' + CID + '-part' + START + '.json (' + rows.length + ' 节)');
cdp.close();
