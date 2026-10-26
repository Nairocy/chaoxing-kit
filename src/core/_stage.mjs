// 阶段判定（防 stale DOM）：结合引擎日志新鲜度 + 目录 DOM 判「视频阶段是否完成」
// 用法：CID=266987706 node src/_stage.mjs
// 输出：STAGE=PLAYING（长跑在真播，勿动页面）| VIDEOS_DONE | VIDEOS_LEFT <节号> | BUSY（有别的执行体在操作）
// 设计要点：只有在「长跑已停/空转」且「无 quiz 锁」时才 Page.reload 复核目录，
//          避免在真实播放或测验作答中刷新页面导致进度中断。
import { CDP, sleep } from './cdp.mjs';
import { statSync, readdirSync, readFileSync, existsSync } from 'node:fs';

const CID = process.env.CID || '';
const FORCE = process.env.CX_FORCE_RELOAD === '1';

function latestLog() {
  try {
    const fs = readdirSync('logs').filter((f) => /^engine-.*\.jsonl$/.test(f));
    if (!fs.length) return null;
    fs.sort((a, b) => statSync(`logs/${b}`).mtimeMs - statSync(`logs/${a}`).mtimeMs);
    const p = `logs/${fs[0]}`;
    return { p, ageMin: (Date.now() - statSync(p).mtimeMs) / 60000 };
  } catch { return null; }
}

function lastEvents(p, n = 12) {
  try {
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// 1) 锁：有人在操作浏览器（本喵手工/推进器）→ 不动页面
let lockAge = 999;
if (existsSync('state/quiz-lock.txt')) {
  lockAge = (Date.now() - statSync('state/quiz-lock.txt').mtimeMs) / 60000;
  if (lockAge < 12 && !FORCE) { console.log('BUSY locked age=' + lockAge.toFixed(1) + 'min'); process.exit(0); }
}

// 2) 日志判活：最近 3 分钟内有 progress/kick → 长跑在真播
const log = latestLog();
const evs = log ? lastEvents(log.p) : [];
const last = evs[evs.length - 1];
const playing = !!(log && log.ageMin < 3 && last && ['progress', 'kick', 're_kick', 'paused_detected', 'video_done'].includes(last.ev));

const CAT = `(() => [...document.querySelectorAll('.posCatalog_level li')].map((li) => {
  const sel = li.querySelector('.posCatalog_select'), sb = li.querySelector('.posCatalog_sbar'), hid = li.querySelector('.jobUnfinishCount');
  return { no: sb ? (sb.innerText||'').replace(/\\s+/g,' ').trim() : '', id: sel && sel.id ? sel.id.replace(/^cur/,'') : null,
    done: !!li.querySelector('.icon_Completed'), cnt: hid ? String(hid.value) : '' };
}).filter(n => n.id))()`;

function summarize(rows, href) {
  const cid = (String(href).match(/courseId=(\d+)/) || [])[1] || '';
  const c2 = rows.filter((r) => !r.done && r.cnt === '2');
  const c1 = rows.filter((r) => !r.done && r.cnt === '1');
  console.log('course=' + cid, 'total=' + rows.length, 'done=' + rows.filter((r) => r.done).length);
  console.log('cnt=2(todo):', c2.map((r) => r.no).join(' ') || '-');
  console.log('cnt=1(todo):', c1.length);
  if (CID && cid && cid !== CID) { console.log('COURSE_MISMATCH want=' + CID); return; }
  if (!rows.length) { console.log('STAGE=UNKNOWN no catalog'); return; }
  if (c2.length) console.log('STAGE=VIDEOS_LEFT ' + c2.map((r) => r.no).join(' '));
  else console.log('STAGE=VIDEOS_DONE');
}

const cdp = await CDP.attach(Number(process.env.CX_PORT || 9231), { match: (t) => t.type === 'page' });
await cdp.send('Runtime.enable');
const href = await cdp.eval('location.href').catch(() => '');

if (playing) {
  // 在播：只读，不刷新
  const rows = await cdp.eval(CAT).catch(() => []);
  console.log('STAGE=PLAYING last=' + last.ev + ' logAge=' + log.ageMin.toFixed(1) + 'min');
  summarize(rows, href);
  cdp.close();
  process.exit(0);
}

// 3) 长跑不在播 → reload 复核（权威读数）
console.log('reload for fresh catalog (logAge=' + (log ? log.ageMin.toFixed(1) : 'none') + 'min, last=' + (last ? last.ev : '-') + ')');
await cdp.send('Page.reload', { ignoreCache: false }).catch(() => {});
let rows = [];
for (let i = 0; i < 20; i++) {
  await sleep(1500);
  rows = await cdp.eval(CAT).catch(() => []);
  if (Array.isArray(rows) && rows.length) break;
}
const href2 = await cdp.eval('location.href').catch(() => href);
summarize(rows || [], href2);
cdp.close();
