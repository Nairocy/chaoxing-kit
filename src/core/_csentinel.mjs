// 通用课程哨兵：视频阶段完成报喜（一次）+ 停摆报警 + 全完成报喜（一次）
// 用法（cron no_agent）：CID=266170419 TAG=career node src/_csentinel.mjs
import { CDP, sleep } from './cdp.mjs';
import { writeFileSync, existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// KILL=1：视频阶段完成时顺手停掉视频长跑（MIL 模式下长跑会在 rc=20 空转）
const KILL = process.env.KILL === '1';
function killLoops() {
  const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match ('auto-' + 'loop') -or $_.CommandLine -match ('engine' + '.mjs') } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }"`;
  try { execSync(cmd, { stdio: 'ignore', timeout: 60000 }); } catch {}
}

const CID = process.env.CID || '';
const NAME = process.env.NAME || '职业生涯规划';
const TAG = process.env.TAG || CID;
const VID_FLAG = `state/${TAG}-videos-done.flag`;
const ALL_FLAG = `state/${TAG}-all-done.flag`;
const ALERT = `state/${TAG}-alert.ts`;

function latestLog() {
  try {
    const fs = readdirSync('logs').filter((f) => /^engine-.*\.jsonl$/.test(f));
    if (!fs.length) return null;
    fs.sort((a, b) => statSync(`logs/${b}`).mtimeMs - statSync(`logs/${a}`).mtimeMs);
    const p = `logs/${fs[0]}`;
    return { p, ageMin: Math.round((Date.now() - statSync(p).mtimeMs) / 60000) };
  } catch { return null; }
}

async function snapshot(refresh = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const cdp = await CDP.attach(Number(process.env.CX_PORT || 9231), { match: (t) => t.type === 'page' });
      await cdp.send('Runtime.enable');
      // refresh=true：先 reload 拿权威目录。只在「引擎日志已停更」时调用（长跑已死/空转），不会打断真实播放
      if (refresh) { await cdp.send('Page.reload', { ignoreCache: false }).catch(() => {}); await sleep(9000); }
      const href = await cdp.eval('location.href').catch(() => '');
      const cid = (href.match(/courseId=(\d+)/) || [])[1] || '';
      const cat = await cdp.eval(`(() => [...document.querySelectorAll('.posCatalog_level li')].map((li) => {
        const hid = li.querySelector('.jobUnfinishCount');
        const sb = li.querySelector('.posCatalog_sbar');
        return { no: sb ? (sb.innerText||'').replace(/\\s+/g,' ').trim() : '', done: !!li.querySelector('.icon_Completed'),
          cnt: hid ? String(hid.value) : '' };
      }))()`).catch(() => []);
      cdp.close();
      if (Array.isArray(cat) && cat.length) return { cid, total: cat.length, done: cat.filter((n) => n.done).length, cat };
      return { cid, total: 0, done: 0, cat: [] };
    } catch {}
    await sleep(2000);
  }
  return null;
}

const now = Date.now();
let snap = await snapshot();
const log = latestLog();
// 防 stale DOM 误判（2026-10-25 实测踩过）：页面右栏目录是上次切节点时的快照，长跑停摆后不再刷新，
// 会一直显示「还有 cnt=2」→ 哨兵空等 8 小时。判据：DOM 说还有视频 + 引擎日志已停更 >10min
// 两者矛盾时 reload 一次取权威目录；日志新鲜（真在播）时绝不 reload，避免打断播放。
if (snap && log && log.ageMin > 10 && snap.cat.some((n) => !n.done && n.cnt === '2')) {
  const s2 = await snapshot(true);
  if (s2 && s2.cat.length) snap = s2;
}
const ts = () => new Date().toLocaleString('zh-CN', { hour12: false });
const msgs = [];

const onThisCourse = snap && snap.cid === CID;
const allDone = onThisCourse && snap.total > 0 && snap.done >= snap.total;
// 视频阶段完成 = 不存在「未完成且仍欠 2 个任务点」的节点。
// ⚠️ 别用 scan 快照里的 video 节点集合替代本判据：有的课视频挂在父节点 tab 上（attachments 空、scan 看不到），
// 用 scan 集合会把「父节点还欠视频+测验」误判成已完成。
const vidsDone = onThisCourse && snap.total > 0 && !snap.cat.some((n) => !n.done && n.cnt === '2');

if (vidsDone && !existsSync(VID_FLAG) && !existsSync(ALL_FLAG)) {
  if (KILL) killLoops();
  writeFileSync(VID_FLAG, new Date().toISOString());
  const left = snap.cat.filter((n) => !n.done).length;
  msgs.push(`【超星·${NAME}】🎬 视频阶段完成：目录 ${snap.done}/${snap.total}，剩 ${left} 节只欠章节测验（${ts()}）。可以开始集中清测验了。`);
}

if (allDone && !existsSync(ALL_FLAG)) {
  writeFileSync(ALL_FLAG, new Date().toISOString());
  msgs.push(`【超星·${NAME}】🎉 全部 ${snap.total} 个节点完成（${ts()}）。`);
}

const age = log ? log.ageMin : 999;
if (age > 35 && !allDone) {
  let last = 0;
  try { last = Number(readFileSync(ALERT, 'utf8').trim() || 0); } catch {}
  if (now - last > 6 * 3600 * 1000) {
    writeFileSync(ALERT, String(now));
    const prog = onThisCourse ? `${snap.done}/${snap.total}` : `当前页 courseId=${snap ? snap.cid : '?'}`;
    msgs.push(`【超星·${NAME}】⚠️ 疑似停摆：引擎日志已 ${age} 分钟无更新（目录 ${prog}，${ts()}）。`);
  }
}

if (msgs.length) console.log(msgs.join('\n'));
