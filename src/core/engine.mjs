// 超星自动刷课引擎 v1（headless + 真实播放 + 弹窗看门狗 + 完成标记驱动）
// 用法:
//   node src/engine.mjs                   # 从目录里第一个未完成节点开始
//   CX_START=8.2 node src/engine.mjs      # 从 8.2 开始
//   CX_MAX=2 node src/engine.mjs          # 最多跑 2 个节点
//   CX_DRYRUN=1 node src/engine.mjs       # 只观察，不点任何东西
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CDP, sleep, waitForBrowser, httpJson } from './cdp.mjs';

// 浏览器：默认 Edge（Windows 路径），可用 CX_BROWSER 指向任意 Chromium 内核浏览器
const EDGE = process.env.CX_BROWSER || (process.platform === 'win32'
  ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  : process.platform === 'darwin'
    ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    : 'microsoft-edge');
const HEADED = Number(process.env.CX_HEADED_PORT || 9229);
const PORT = Number(process.env.CX_PORT || 9231);
const PROFILE = process.env.CX_AUTO_PROFILE || join(homedir(), '.chaoxing-kit', 'edge-profile');
const COURSE = {
  courseId: process.env.CX_COURSE_ID || '',
  clazzid: process.env.CX_CLAZZID || '',
  cpi: process.env.CX_CPI || '',
};
if (!COURSE.courseId || !COURSE.clazzid) {
  console.error('[chaoxing-kit] 缺少课程参数：请设置 CX_COURSE_ID 与 CX_CLAZZID（也可用 --course courseId/clazzId 传入）');
  process.exit(2);
}
const shellUrl = () =>
  `https://mooc1-1.chaoxing.com/mooc-ans/visit/stucoursemiddle?courseid=${COURSE.courseId}&clazzid=${COURSE.clazzid}&vc=1&cpi=${COURSE.cpi}&ismooc2=1&v=2`;
const START = process.env.CX_START || '';
const MAX = Number(process.env.CX_MAX || 3);
const DRYRUN = !!process.env.CX_DRYRUN;
const STOP_NONVIDEO = process.env.CX_ALLOW_NONVIDEO !== '1';
// 军事理论「视频优先」模式（CX_MIL=1）：内嵌测验的课程，视频播完即算过——
// 测验未做导致的目录未翻面不算失败（不再白重播）；cnt=1（只欠测验）节点秒跳过
const MIL = process.env.CX_MIL === '1';
// 视频优先（测验是独立节点的课）：测验/讨论节点跳过、不占名额，视频刷完再集中作答
const SKIP_WORK = process.env.CX_SKIP_WORK === '1';
const WORK_FILE = `state/work-nodes.json`;
const workNodes = () => { try { return new Set(JSON.parse(readFileSync(WORK_FILE, 'utf8'))); } catch { return new Set(); } };
const workMark = (kid) => { const s = workNodes(); s.add(kid); writeFileSync(WORK_FILE, JSON.stringify([...s])); };
const STATE_DIR = 'state';
const LOG = `logs/engine-${Date.now()}.jsonl`;
const MIL_DONE = `${STATE_DIR}/mil-done.json`; // MIL：已播完节点标记（防服务端 cnt 记账延迟导致重播）
const milDone = () => { try { return new Set(JSON.parse(readFileSync(MIL_DONE, 'utf8'))); } catch { return new Set(); } };
const milMark = (kid) => { const s = milDone(); s.add(kid); writeFileSync(MIL_DONE, JSON.stringify([...s])); };
// 空壳父节点（章节标题，mArg 无任务点）→ 记住跳过，避免每轮白等 30s
const EMPTY_FILE = `${STATE_DIR}/empty-nodes.json`;
const emptyNodes = () => { try { return new Set(JSON.parse(readFileSync(EMPTY_FILE, 'utf8'))); } catch { return new Set(); } };
const emptyMark = (kid) => { const s = emptyNodes(); s.add(kid); writeFileSync(EMPTY_FILE, JSON.stringify([...s])); };
// 时间预算（秒）：到点优雅收工，可反复调用续跑（进度由目录完成标记决定）
const BUDGET = Number(process.env.CX_BUDGET || 0);
const T_START = Date.now();
const overBudget = () => BUDGET > 0 && (Date.now() - T_START) / 1000 > BUDGET;
// 白名单：只点这些按钮（刻意不含"下一节"，防跳过内容）
const BTN_WHITELIST = ['继续学习', '重试', '重新播放', '继续播放', '继续', '确定', '知道了'];

mkdirSync(STATE_DIR, { recursive: true });
const log = (o) => {
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
  const { ev, ...rest } = o;
  console.log(`[${new Date().toTimeString().slice(0, 8)}] ${ev}`, Object.keys(rest).length ? JSON.stringify(rest) : '');
};

// ---------- 1. 起 headless ----------
/** 健康检查：/json/version 会应答但渲染进程可能已卡死 → 必须真求值一次才算活 */
async function cdpHealthy(port) {
  try {
    const list = await httpJson(port, '/json/list');
    const t = list.find((x) => x.type === 'page');
    if (!t) return false;
    const c = await CDP.connect(t.webSocketDebuggerUrl, { timeoutMs: 5000 });
    const r = await c.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, { timeoutMs: 8000 });
    c.close();
    return !!(r && r.result && r.result.value === 2);
  } catch { return false; }
}

async function killHeadless() {
  try {
    const { execFileSync } = await import('node:child_process');
    if (process.platform === 'win32') {
      const pat = PROFILE.replace(/\\/g, '\\\\');
      const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match '${pat}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
    } else {
      // macOS / Linux：按 profile 路径匹配命令行后杀
      const q = "'" + PROFILE.replace(/'/g, "'\\''") + "'";
      execFileSync('bash', ['-lc', `ps ax -o pid=,command= | grep -F ${q} | grep -v grep | awk '{print $1}' | xargs -r kill -9`], { stdio: 'ignore' });
    }
    log({ ev: 'headless_killed' });
    await sleep(2500);
  } catch (e) { log({ ev: 'headless_kill_fail', err: e.message }); }
}

async function ensureHeadless() {
  if (await cdpHealthy(PORT)) { log({ ev: 'headless_reuse', port: PORT }); return; }
  const alive = await waitForBrowser(PORT, 900).then(() => true).catch(() => false);
  if (alive) { log({ ev: 'headless_unhealthy_kill' }); await killHeadless(); }
  mkdirSync(PROFILE, { recursive: true });
  const args = [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--window-size=1400,900', 'about:blank',
  ];
  let p = spawn(EDGE, args, { detached: true, stdio: 'ignore' }); p.unref();
  try { await waitForBrowser(PORT, 25000); } catch {
    log({ ev: 'headless_fallback_flag' });
    args[0] = '--headless';
    p = spawn(EDGE, args, { detached: true, stdio: 'ignore' }); p.unref();
    await waitForBrowser(PORT, 25000);
  }
  log({ ev: 'headless_launched', pid: p.pid });
  if (!(await cdpHealthy(PORT))) throw new Error('headless 启动后不健康（CDP 无响应）');
}

/** 只在 CX_SYNC_COOKIES=1 时搬 cookie；搬完立刻关掉有头实例的超星标签页
 *  —— 超星会因"多终端同时在线"弹风控页（实测：detect.chaoxing.com/api/monitor_temp） */
async function syncCookies() {
  if (process.env.CX_SYNC_COOKIES !== '1') { log({ ev: 'cookies_skip', why: 'not_requested' }); return false; }
  try {
    const v = await httpJson(HEADED, '/json/version');
    const b = await CDP.connect(v.webSocketDebuggerUrl);
    const { cookies } = await b.send('Storage.getCookies', {}); b.close();
    const v2 = await httpJson(PORT, '/json/version');
    const b2 = await CDP.connect(v2.webSocketDebuggerUrl);
    await b2.send('Storage.setCookies', { cookies }); b2.close();
    log({ ev: 'cookies_synced', n: cookies.length });
    await closeHeadedChaoxing();
    return true;
  } catch (e) { log({ ev: 'cookies_skip', err: e.message }); return false; }
}

/** 关掉有头实例里的超星标签页（避免同账号两端同时在线） */
async function closeHeadedChaoxing() {
  try {
    const list = await httpJson(HEADED, '/json/list');
    for (const t of list) {
      if (t.type === 'page' && /chaoxing/.test(t.url)) {
        await fetch(`http://127.0.0.1:${HEADED}/json/close/${t.id}`);
        log({ ev: 'headed_tab_closed', url: t.url.slice(0, 60) });
      }
    }
  } catch (e) { log({ ev: 'headed_close_fail', err: e.message }); }
}

/** 检测超星风控页；命中则把原文 mes 解出来记日志 */
async function checkRiskPage(cdp) {
  let u = '';
  try { u = await cdp.eval('location.href'); } catch { return false; }
  if (!/detect\.chaoxing\.com/.test(u)) return false;
  let mes = '';
  try { mes = decodeURIComponent(new URL(u).searchParams.get('mes') || ''); } catch {}
  log({ ev: 'RISK_PAGE', mes, url: u.slice(0, 140) });
  return true;
}

// ---------- 3. 入口（自给自足：门户 → toOld，不依赖外部状态） ----------
const frameBy = async (cdp, re, tries = 3) => {
  for (let i = 0; i < tries; i++) {
    try {
      const f = (await cdp.frameTree()).find((x) => re.test(x.url));
      if (f) return f;
    } catch (e) { if (i === tries - 1) throw e; }
    await sleep(700);
  }
  return null;
};

/** 门户页目录帧(studentcourse) → 选未完成节点 → toOld 进 studentstudy */
async function enterViaShell(cdp, wantNo) {
  log({ ev: 'enter_via_shell' });
  await cdp.send('Page.navigate', { url: shellUrl() });
  await sleep(9000);
  let zj = await frameBy(cdp, /studentcourse/, 2);
  if (!zj) {
    // 新版门户（侧边栏 任务/章节/作业…）：章节帧要点击「章节」后才异步加载
    const c = await cdp.eval(`(() => {
      const cands = [...document.querySelectorAll('a,li,div,span')].filter((e) => (e.innerText || '').trim() === '章节');
      if (!cands.length) return null;
      const el = cands[cands.length - 1];
      const r = el.getBoundingClientRect();
      return { xy: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] };
    })()`).catch(() => null);
    if (c && c.xy) { await cdp.click(c.xy[0], c.xy[1]); log({ ev: 'click_chapter_tab', xy: c.xy }); }
  }
  for (let i = 0; i < 12 && !zj; i++) { zj = await frameBy(cdp, /studentcourse/); if (!zj) await sleep(1500); }
  if (!zj) throw new Error('课程门户未出现目录帧；当前: ' + (await cdp.eval('location.href')).slice(0, 120));

  const nodes = await cdp.eval(`(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    return [...document.querySelectorAll('.chapter_body .catalog_level li')].map((li) => {
      const it = li.querySelector('.chapter_item');
      const a = li.querySelector('a.clicktitle');
      const sb = li.querySelector('.catalog_sbar');
      return { kid: it && it.id ? it.id.replace(/^cur/, '') : null,
        no: sb ? norm(sb.innerText) : '', t: a ? norm(a.innerText).slice(0, 30) : '',
        done: !!li.querySelector('.catalog_state'), todo: !!li.querySelector('.knowledgeJobCount') };
    }).filter((n) => n.kid);
  })()`, { frameId: zj.id });

  log({ ev: 'shell_catalog', n: nodes.length, done: nodes.filter((n) => n.done).length });
  let pick = null;
  if (wantNo) {
    const i0 = nodes.findIndex((n) => n.no === wantNo);
    pick = nodes.slice(i0 < 0 ? 0 : i0).find((n) => n.todo) || null;
  } else {
    pick = nodes.find((n) => n.todo) || null;
  }
  if (!pick) throw new Error('门户目录里找不到可刷的未完成节点');
  log({ ev: 'shell_pick', no: pick.no, kid: pick.kid, t: pick.t });

  const r = await cdp.eval(`(() => {
    if (typeof toOld !== 'function') return 'nofn';
    toOld(${JSON.stringify(COURSE.courseId)}, ${JSON.stringify(pick.kid)}, ${JSON.stringify(COURSE.clazzid)}, 0);
    return 'toOld';
  })()`, { frameId: zj.id });
  log({ ev: 'shell_click', r, kid: pick.kid });
  await sleep(9000);

  let cur = await cdp.eval('location.href');
  if (!/studentstudy/.test(cur)) {
    const zj2 = await frameBy(cdp, /studentcourse/);
    if (zj2) {
      const r2 = await cdp.eval(`(() => {
        const el = document.querySelector('#cur${pick.kid}');
        if (!el) return 'notfound';
        const a = el.querySelector('a.clicktitle') || el;
        a.scrollIntoView({ block: 'center' }); a.click(); return 'clicked';
      })()`, { frameId: zj2.id });
      log({ ev: 'shell_fallback_click', r: r2 });
      await sleep(9000);
      cur = await cdp.eval('location.href');
    }
  }
  if (!/studentstudy/.test(cur)) throw new Error('入口重建失败，当前: ' + cur.slice(0, 130));
  return cur;
}

/** 页面可用性探测：studentstudy URL 也可能挂着"章节未开放"空页（enc 过期/窗口关闭）→ 必须回读目录才能相信页面可用
 *  换课后还要验 courseId：旧课的 studentstudy 页对当前课程不可用 */
async function usablePage(cdp, tries = 3, waitMs = 3000) {
  for (let i = 0; i < tries; i++) {
    const cur = await cdp.eval('location.href').catch(() => '');
    if (!/studentstudy/.test(cur)) return ''; // 不在学习页 → 无需再等
    if (!cur.includes('courseId=' + COURSE.courseId)) return ''; // 别的课程 → 不可用
    const cat = await readCatalog(cdp).catch(() => []);
    if (cat.length) return cur;
    await sleep(waitMs);
  }
  return '';
}

async function openPage(cdp, wantNo) {
  let cur = await usablePage(cdp, 1);
  if (!cur) {
    const f = `${STATE_DIR}/last-url.txt`;
    if (existsSync(f) && /studentstudy/.test(readFileSync(f, 'utf8'))) {
      const u = readFileSync(f, 'utf8').trim();
      log({ ev: 'enter_from_state' });
      await cdp.send('Page.navigate', { url: u });
      await sleep(9000);
      cur = await usablePage(cdp);
      if (!cur) log({ ev: 'state_url_unusable', hint: 'enc 过期/章节未开放 → 走门户重建' });
    }
    if (!cur) cur = await enterViaShell(cdp, wantNo);
  }
  writeFileSync(`${STATE_DIR}/last-url.txt`, cur);
  log({ ev: 'page_ready', url: cur.slice(0, 110) });
}

// ---------- 4. 目录 ----------
const CATALOG = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('.posCatalog_level li')].map((li, i) => {
    const sel = li.querySelector('.posCatalog_select');
    const nm = li.querySelector('.posCatalog_name');
    const sb = li.querySelector('.posCatalog_sbar');
    const hid = li.querySelector('.jobUnfinishCount');
    return { i, id: sel && sel.id ? sel.id.replace(/^cur/, '') : null,
      no: sb ? norm(sb.innerText) : '', t: nm ? norm(nm.innerText) : '',
      done: !!li.querySelector('.icon_Completed'),
      todo: !!li.querySelector('.catalog_points_yi'),
      sched: !!li.querySelector('.catalog_points_er'),
      cnt: hid ? hid.value : '',
      active: !!(sel && sel.classList.contains('posCatalog_active')) };
  });
})()`;
const readCatalog = (cdp) => cdp.eval(CATALOG);

// ---------- 5. 视频 / 弹窗 ----------
async function videoFrame(cdp) {
  const fs = await cdp.frameTree();
  return fs.find((f) => /ananas\/modules\/video/.test(f.url)) || null;
}
const VID = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  return { t: Math.round(v.currentTime * 10) / 10, d: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
           paused: v.paused, ended: v.ended, ready: v.readyState, err: v.error ? v.error.code : null };
})()`;

/** 一个知识点可能挂多个视频任务点（实测 9.1 有 2 个）→ 返回"还没完成的那个" */
async function videoState(cdp) {
  const vfs = (await cdp.frameTree()).filter((f) => /ananas\/modules\/video/.test(f.url));
  if (!vfs.length) return null;
  let last = null;
  for (const f of vfs) {
    let s = null;
    try { s = await cdp.eval(VID, { frameId: f.id }); } catch { continue; }
    if (!s) continue;
    s.frameId = f.id;
    if (!s.ended && (s.d === null || s.t < s.d - 1)) return s;
    last = s;
  }
  return last;
}

// 有的课把「视频」挂在父节点的 tab 上（本课 1.1：dct1=学习目标 / dct2=视频 / dct3=章节测验）。
// 未激活 tab 时 video 帧不存在，mArg.attachments 也是空数组 → 会被误判成空壳父节点。
async function tryVideoTab(cdp) {
  try {
    const r = await cdp.eval(`(() => {
      const li = document.getElementById('dct2');
      if (!li) return 0;
      const txt = (li.innerText || '').replace(/\\s+/g, '');
      if (!/视频/.test(txt)) return 0;          // 别的课 dct2 是章节测验，绝不冒点
      if (/active/.test(li.className || '')) return 1;
      li.click();
      return 2;
    })()`);
    if (r === 2) await sleep(4000);
    return r > 0;
  } catch { return false; }
}

const POPS = `(() => {
  const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const out = [];
  for (const id of ['freezePage2', 'workpop', 'hintPop', 'worktoast']) {
    const el = document.getElementById(id);
    if (!el || !vis(el)) continue;
    out.push({ id, txt: norm(el.innerText).slice(0, 140),
      btns: [...el.querySelectorAll('a,button,div[class*=btn],span[class*=btn]')].filter(vis).map((b) => {
        const r = b.getBoundingClientRect();
        return { txt: norm(b.innerText).slice(0, 18), cls: (b.className || '').toString().slice(0, 60),
                 xy: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] };
      }).filter((b) => b.txt || /btn|keepLearning|continue|retry/i.test(b.cls)) });
  }
  const jf = document.querySelector('.jobFinishTip');
  if (jf && vis(jf)) out.push({ id: 'jobFinishTip', txt: norm(jf.innerText).slice(0, 140), btns: [] });
  return out;
})()`;

const seenPop = new Set();
async function handlePops(cdp, pops) {
  for (const p of pops) {
    const sig = p.id + '|' + p.txt;
    if (!seenPop.has(sig)) {
      seenPop.add(sig);
      log({ ev: 'popup_seen', id: p.id, txt: p.txt, btns: p.btns.map((b) => b.txt || b.cls) });
      try { await cdp.screenshot(`shots/popup-${Date.now()}.png`); } catch {}
    }
    if (DRYRUN) continue;
    // 只点白名单按钮，优先顺序按白名单
    for (const want of BTN_WHITELIST) {
      const b = p.btns.find((x) => (x.txt || '').includes(want));
      if (!b) continue;
      if (b.xy[0] <= 0 || b.xy[1] <= 0) continue;
      await cdp.click(b.xy[0], b.xy[1]);
      log({ ev: 'popup_click', id: p.id, btn: b.txt, xy: b.xy });
      await sleep(1200);
      break;
    }
  }
}

async function kick(cdp, frameId) {
  let fid = frameId;
  if (!fid) { const s = await videoState(cdp); fid = s && s.frameId; }
  if (!fid) return 'novideo';
  const JS = `(async () => {
    const v = document.querySelector('video');
    if (!v) return 'novideo';
    if (v.ended || (v.duration && v.currentTime >= v.duration - 0.5)) return 'ended';
    const b = document.querySelector('button.vjs-big-play-button');
    if (b) b.click();
    await new Promise((r) => setTimeout(r, 700));
    if (v.paused) { try { await v.play(); return 'jsplay'; } catch (e) { return 'err:' + e.message; } }
    return 'playing';
  })()`;
  try { return await cdp.eval(JS, { frameId: fid }); } catch (e) { return 'err:' + e.message; }
}

// ---------- 6. 切节点 ----------
async function switchTo(cdp, kid) {
  const ok = await cdp.eval(`(() => {
    if (typeof getTeacherAjax !== 'function') return false;
    getTeacherAjax(${JSON.stringify(COURSE.courseId)}, ${JSON.stringify(COURSE.clazzid)}, ${JSON.stringify(kid)});
    return true;
  })()`).catch(() => false);
  if (ok) { log({ ev: 'switch_ajax', kid }); return true; }
  const cur = await cdp.eval('location.href');
  const url = cur.replace(/chapterId=\d+/, `chapterId=${kid}`);
  if (url === cur) throw new Error('切节点失败：URL 无 chapterId');
  log({ ev: 'switch_url', kid });
  await cdp.send('Page.navigate', { url });
  await sleep(8000);
  return true;
}

// ---------- 7. 单节点 ----------
// 微课（microCourse）：多页 PPT + 每页一段 MP3，播完自动翻下一页；点 .annex-audio-top 起播
async function microState(cdp) {
  const vf = (await cdp.frameTree()).find((f) => /appswh\.chaoxing\.com\/screen\/vclass\/view/.test(f.url));
  if (!vf) return null;
  const s = await cdp.eval(`(() => {
    const sl = document.querySelector('.swiper-slide-active');
    const a = sl ? sl.querySelector('audio') : null;
    const all = document.querySelectorAll('.swiper-slide');
    return { page: sl ? Number(sl.getAttribute('filepagenum')) : null, total: all.length,
      t: a ? Math.round(a.currentTime * 10) / 10 : null, d: a ? Math.round(a.duration) : null,
      paused: a ? a.paused : null, ended: a ? a.ended : null };
  })()`, { frameId: vf.id }).catch(() => null);
  if (s) s.frameId = vf.id;
  return s;
}

async function microKick(cdp, frameId) {
  if (!frameId) return 'noframe';
  return cdp.eval(`(() => {
    const sl = document.querySelector('.swiper-slide-active');
    if (!sl) return 'noslide';
    const a = sl.querySelector('audio');
    if (a && !a.paused) return 'playing';
    const t = sl.querySelector('.annex-audio-top') || sl.querySelector('.annex-audio');
    if (!t) return 'notop';
    t.click();
    return 'clicked';
  })()`, { frameId }).catch((e) => 'err:' + e.message);
}

async function runMicro(cdp, node) {
  const t0 = Date.now();
  let lastPage = -1, lastAdv = Date.now(), kicks = 0, lastLog = 0, hiccups = 0, budgetNoted = false;
  while (true) {
    await sleep(2000);
    let s = null;
    try { s = await microState(cdp); } catch (e) {
      hiccups++;
      log({ ev: 'cdp_hiccup', no: node.no, n: hiccups, err: e.message });
      if (hiccups > 5) return 'cdp_error';
      continue;
    }
    if (!s) { log({ ev: 'micro_lost', no: node.no }); return 'lost'; }
    if (s.page !== lastPage) {
      lastPage = s.page; lastAdv = Date.now(); kicks = 0;
      log({ ev: 'micro_page', no: node.no, page: s.page, total: s.total, t: s.t, d: s.d });
    }
    if (Date.now() - lastLog > 60000) { lastLog = Date.now(); log({ ev: 'progress', no: node.no, page: s.page, total: s.total, t: s.t, d: s.d }); }
    const atEnd = s.page !== null && s.page === s.total && s.d !== null && (s.ended || s.t >= s.d - 0.5);
    if (atEnd) { log({ ev: 'micro_done', no: node.no, page: s.page, secs: Math.round((Date.now() - t0) / 1000) }); await sleep(3000); return 'done'; }
    if (s.paused) {
      await sleep(2500); // 页间自动翻页的短暂停顿
      const s2 = await microState(cdp).catch(() => null);
      if (s2 && !s2.paused) { s = s2; lastAdv = Date.now(); continue; }
      kicks++;
      log({ ev: 'micro_paused', no: node.no, page: s2 ? s2.page : s.page, t: s2 ? s2.t : s.t, kick: kicks });
      if (kicks > 10) { try { await cdp.screenshot(`shots/micro-stuck-${Date.now()}.png`); } catch {} return 'stuck'; }
      if (!DRYRUN) log({ ev: 'micro_kick', r: await microKick(cdp, (s2 && s2.frameId) || s.frameId) });
      continue;
    }
    if (Date.now() - lastAdv > 180000) { log({ ev: 'micro_stall', no: node.no, page: s.page }); return 'stuck'; }
    if (Date.now() - t0 > 95 * 60 * 1000) { log({ ev: 'node_timeout', no: node.no, page: s.page }); return 'timeout'; }
    if (overBudget() && !budgetNoted) { budgetNoted = true; log({ ev: 'budget_soft', no: node.no, page: s.page, hint: '预算已到，跑完当前节点再收工' }); }
  }
}

async function runNode(cdp, node) {
  log({ ev: 'node_start', no: node.no, id: node.id, title: node.t.slice(0, 30) });
  await switchTo(cdp, node.id);
  let v = null;
  for (let i = 0; i < 20; i++) { await sleep(1500); v = await videoState(cdp); if (v) break; }
  if (!v) {
    // 视频可能挂在父节点的「视频」tab 上（未激活时帧不存在、attachments 也为空）
    if (await tryVideoTab(cdp)) {
      log({ ev: 'video_tab_activated', no: node.no });
      for (let i = 0; i < 20; i++) { await sleep(1500); v = await videoState(cdp); if (v) break; }
    }
  }
  if (!v) {
    // 微课（microCourse）：PPT 多页 + 每页音频，播完自动翻页 → 点一次即可连载到末页
    const ms = await microState(cdp).catch(() => null);
    if (ms) {
      log({ ev: 'micro_found', no: node.no, page: ms.page, total: ms.total, d: ms.d });
      if (!DRYRUN) log({ ev: 'micro_kick', r: await microKick(cdp, ms.frameId) });
      const r = await runMicro(cdp, node);
      if (r === 'done' && !DRYRUN) {
        // 微课任务点完成后页面会显示「任务点已完成」，但右栏目录 DOM 不自动刷新 → 必须重载再回读标记
        log({ ev: 'micro_reload_after_done', hint: '刷新目录后核验完成标记' });
        await cdp.send('Page.reload', {}).catch(() => {});
        await sleep(8000);
      }
      return r;
    }
    // 区分「空壳父节点」（mArg 无任何任务点，如 1.2/1.3 这类章节标题）与真非视频节点（测验/文档）
    let att = null;
    try {
      const cards = (await cdp.frameTree()).find((f) => /knowledge\/cards/.test(f.url));
      if (cards) att = await cdp.eval(`(() => (((window.mArg || {}).attachments) || []).map((a) => a.type))()`, { frameId: cards.id });
    } catch {}
    if (Array.isArray(att) && att.length === 0) {
      emptyMark(node.id);
      log({ ev: 'empty_node_skip', no: node.no, hint: '空壳父节点（无任务点）→ 跳过，继续下一节' });
      return 'empty';
    }
    log({ ev: 'nonvideo_node', no: node.no, att });
    try { await cdp.screenshot(`shots/nonvideo-${node.no.replace(/\./g, '_')}-${Date.now()}.png`); } catch {}
    if (SKIP_WORK) {
      workMark(node.id);
      log({ ev: 'work_node_skip', no: node.no, att, hint: 'CX_SKIP_WORK：测验/阅读/问卷节点跳过，视频优先' });
      return 'skipped';
    }
    return 'nonvideo';
  }
  log({ ev: 'video_found', no: node.no, d: v.d });
  if (!DRYRUN) log({ ev: 'kick', r: await kick(cdp) });

  const t0 = Date.now();
  let kicks = 0, lastT = -1, stall = 0, lastLog = 0, hiccups = 0, budgetNoted = false;
  let lastAdvance = Date.now(), recoveries = 0; // 无进展看门狗：≥120s 不动 → 整页重载恢复
  while (true) {
    await sleep(2000);
    try {
      v = await videoState(cdp);
    } catch (e) {
      hiccups++;
      log({ ev: 'cdp_hiccup', no: node.no, n: hiccups, err: e.message });
      if (hiccups > 5) { log({ ev: 'cdp_dead', no: node.no }); return 'cdp_error'; }
      continue;
    }
    if (!v) { log({ ev: 'lost_video_frame', no: node.no }); return 'lost'; }

    const pops = await cdp.eval(POPS).catch(() => []);
    if (pops && pops.length) await handlePops(cdp, pops);

    if (v.ended || (v.d !== null && v.t >= v.d - 1)) {
      log({ ev: 'video_done', no: node.no, t: v.t, d: v.d, secs: Math.round((Date.now() - t0) / 1000) });
      await sleep(3000);
      return 'done';
    }
    if (v.t !== lastT) lastAdvance = Date.now();
    if (v.paused) {
      kicks++;
      log({ ev: 'paused_detected', no: node.no, t: v.t, d: v.d, kick: kicks });
      if (kicks > 8) { log({ ev: 'give_up', no: node.no }); try { await cdp.screenshot(`shots/stuck-${Date.now()}.png`); } catch {} return 'stuck'; }
      await sleep(1500);
      if (!DRYRUN) log({ ev: 're_kick', r: await kick(cdp) });
    } else {
      if (v.t === lastT) { stall++; } else { stall = 0; }
      if (stall >= 15) { log({ ev: 'stalled_position', no: node.no, t: v.t }); stall = 0; }
      // 播放中 ≥120s 无进展 = 视频流卡死（paused-rekick 救不了）→ 整页重载恢复
      if (!DRYRUN && Date.now() - lastAdvance > 120000) {
        recoveries++;
        log({ ev: 'stall_recover', no: node.no, t: v.t, n: recoveries });
        if (recoveries > 2) { try { await cdp.screenshot(`shots/stuck-${Date.now()}.png`); } catch {} return 'stuck'; }
        await cdp.send('Page.reload', {}).catch(() => {});
        await sleep(3000);
        let rv = null;
        for (let i = 0; i < 20; i++) { await sleep(1500); rv = await videoState(cdp).catch(() => null); if (rv) break; }
        if (!rv) { log({ ev: 'stall_recover_novideo', no: node.no }); return 'lost'; }
        log({ ev: 'stall_recover_kick', r: await kick(cdp) });
        lastAdvance = Date.now(); lastT = -1; stall = 0; kicks = 0;
        continue;
      }
    }
    lastT = v.t;
    if (Date.now() - t0 > 95 * 60 * 1000) { log({ ev: 'node_timeout', no: node.no, t: v.t }); return 'timeout'; }
    if (overBudget() && !budgetNoted) { budgetNoted = true; log({ ev: 'budget_soft', no: node.no, hint: '预算已到，跑完当前节点再收工' }); }
    if (Date.now() - lastLog > 60000) { lastLog = Date.now(); log({ ev: 'progress', no: node.no, t: v.t, d: v.d }); }
  }
}

// ---------- 8. 主流程 ----------
await ensureHeadless();
await syncCookies();
const cdp = await CDP.attach(PORT, { match: (t) => t.type === 'page' });
// 只开 Page + Runtime：视频流会让 Network 事件洪水般涌来，拉高 WS 负载
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await openPage(cdp, process.env.CX_KID || '');
await checkRiskPage(cdp);

let cat = await readCatalog(cdp);
log({ ev: 'catalog_read', total: cat.length, done: cat.filter((n) => n.done).length });

let queue = cat.filter((n) => !n.done && n.todo);
if (START) {
  const idx = cat.findIndex((n) => n.no === START);
  if (idx < 0) throw new Error('目录里找不到节号 ' + START);
  queue = cat.slice(idx).filter((n) => !n.done && n.todo);
}
// CX_FORCE_LIST=8.2,8.3：强制处理指定节，无视目录 done 标记。
// 用于「目录显示 ✅ 但 knowledge/cards 的卡片没有 ans-job-finished、mArg 里也没有 isPassed」的假完成节点
// （2026-10-26 无机化学 8.2 实测：目录 done=29/29，但 3 个视频任务点一个都没记账）。
{
  const force = (process.env.CX_FORCE_LIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (force.length) {
    const picked = cat.filter((n) => force.includes(n.no));
    if (!picked.length) throw new Error('CX_FORCE_LIST 里的节号不在目录：' + force.join(','));
    queue = picked;
    log({ ev: 'force_list', n: queue.length, nodes: queue.map((n) => n.no) });
  }
}
{
  const es = emptyNodes();
  const skipped = queue.filter((n) => es.has(n.id));
  if (skipped.length) log({ ev: 'skip_known_empty', n: skipped.length, nodes: skipped.map((n) => n.no) });
  queue = queue.filter((n) => !es.has(n.id));
}
if (SKIP_WORK) {
  const ws = workNodes();
  const sk = queue.filter((n) => ws.has(n.id));
  if (sk.length) log({ ev: 'skip_known_work', n: sk.length, nodes: sk.map((n) => n.no) });
  queue = queue.filter((n) => !ws.has(n.id));
}
log({ ev: 'queue', n: queue.length, first: queue.slice(0, 6).map((n) => n.no) });

const results = [];
let hitNonvideo = false; // 遇非视频节点(测验)停手 → 以退出码 10 结束，供续跑器识别
let runList = queue;
if (MIL) {
  const md = milDone();
  const skips = queue.filter((n) => n.cnt === '1' || md.has(n.id));
  if (skips.length) log({ ev: 'mil_skip_list', n: skips.length, first: skips.slice(0, 4).map((n) => n.no) });
  runList = queue.filter((n) => !(n.cnt === '1' || md.has(n.id)));
}
for (const node of runList.slice(0, MAX)) {
  if (overBudget()) { log({ ev: 'budget_reached_at_node', no: node.no }); break; }
  let r = '', flipped = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await runNode(cdp, node);
    if (r !== 'done') break;
    // 外部核验：完成标记是否真的翻面
    await sleep(2000);
    const c2 = await readCatalog(cdp);
    const same = c2.find((n) => n.id === node.id);
    flipped = !!(same && same.done);
    log({ ev: 'marker_check', no: node.no, attempt, flipped, todoLeft: same ? same.cnt : null });
    if (flipped) { if (MIL) milMark(node.id); break; }
    if (MIL) {
      // 军事理论：视频已播完但目录未翻 = 内嵌测验未做，不算失败 → 标记后跳过，绝不重播
      milMark(node.id);
      log({ ev: 'mil_video_done_unflipped', no: node.no, attempt, hint: '视频已播完，测验留待集中作答' });
      break;
    }
    // 未翻面 = 本节点还有别的任务点（如 9.1 有 2 个）→ 重开本节点继续
    log({ ev: 'node_not_flipped_retry', no: node.no, attempt });
    if (overBudget()) break;
  }
  results.push({ no: node.no, r, flipped });
  if (r === 'nonvideo' && STOP_NONVIDEO) {
    hitNonvideo = true;
    log({ ev: 'stop_on_nonvideo', no: node.no, hint: '非视频节点（可能是章节测验），已停手等你拍板' });
    break;
  }
  if (await checkRiskPage(cdp)) { log({ ev: 'stop_on_risk_page', no: node.no }); break; }
  if (r === 'stuck' || r === 'lost' || r === 'cdp_error') { log({ ev: 'stop_on_error', no: node.no, r }); break; }
}

// 收尾：浏览器可能已经卡死，此处任何 CDP 调用都必须能失败而不炸脚本
const catEnd = await readCatalog(cdp).catch(() => null);
const doneEnd = catEnd ? catEnd.filter((n) => n.done).length : cat.filter((n) => n.done).length;
log({ ev: 'summary', results, done: doneEnd, total: cat.length, log: LOG });
console.log('\n=== 本轮结果 ===');
for (const x of results) console.log(`  ${x.no} → ${x.r}${x.r === 'done' ? (x.flipped ? ' [已翻面]' : ' [未翻面]') : ''}`);
console.log(`目录完成度: ${doneEnd}/${cat.length}`);
console.log('日志:', LOG);
if (hitNonvideo) process.exitCode = 10; // 约定：10 = 遇非视频节点（测验）停手
else if (runList.length === 0 || doneEnd >= cat.length) process.exitCode = 20; // 约定：20 = 本课程已无可刷节点（跑完）
cdp.close();
