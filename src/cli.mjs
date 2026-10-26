#!/usr/bin/env node
// chaoxing-kit CLI —— 视频 / 文档 / 测验全流程
// 用法: chaoxing <command> --course <courseId>/<clazzId> [options]
import { runCore, lastSummary } from './runner.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];

function parseFlags(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const f = parseFlags(argv.slice(1));
const json = !!f.json;

function course() {
  if (!f.course) fail('缺少 --course <courseId>/<clazzId>');
  const [courseId, clazzId] = String(f.course).split('/');
  if (!courseId || !clazzId) fail('--course 格式应为 courseId/clazzId');
  return { courseId, clazzId, cpi: f.cpi || process.env.CX_CPI || '' };
}

function baseEnv() {
  const env = {};
  if (f.port) env.CX_PORT = String(f.port);
  if (f.profile) env.CX_AUTO_PROFILE = String(f.profile);
  if (f.browser) env.CX_BROWSER = String(f.browser);
  return env;
}

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(2);
}

function show(res, title) {
  if (json) { console.log(JSON.stringify(res, null, 2)); return; }
  if (title) console.log('== ' + title + ' ==');
  if (res.stdout) process.stdout.write(res.stdout);
  const s = lastSummary(res.events);
  if (s) console.log(`\n[summary] done=${s.done}/${s.total}` + (s.results && s.results.length ? ' | ' + JSON.stringify(s.results) : ''));
  if (res.code !== 0 && res.code !== 10 && res.code !== 20) console.log(`[exit ${res.code}]`);
  if (res.logPath) console.log('[log] ' + res.logPath);
}

const H = `
chaoxing-kit —— 超星学习通自动化（真实播放 / 文档记账 / 测验辅助）

命令:
  login                          打开有头 Edge 扫码登录（profile 持久化）
  scan      --start 0 --limit 18 扫描课程结构（节点/任务点/时长）
  run       --start 3.1 --max 8  跑视频节点（默认连续跑到队列空）
  status                         目录完成度 + 任务点欠账分布
  stage                          阶段判定（PLAYING / VIDEOS_DONE / VIDEOS_LEFT / BUSY）
  doc <no>  --kid <id>           文档任务点：滚动到末页触发记账
  quiz <no> --shots              测验分段截图（交给视觉模型读题）
  quiz <no> --perq 4,4,2 --ans 1:B,2:AC --submit   点选并提交
  score                          读当前成绩页（逐题 my/right/score）
  sentinel --tag x               哨兵：视频阶段完成/停摆检查

通用参数:
  --course <courseId>/<clazzId>  必填（login 除外）
  --cpi <cpi>                    班级 cpi（部分学校需要）
  --port 9231 --profile <dir>    浏览器调试端口 / 用户目录
  --json                         以 JSON 输出（给 agent 用）

run 参数:
  --mil          视频优先模式（内嵌测验课：播完即过，测验另做）
  --skip-work    跳过独立测验/讨论节点
  --budget 1800  单轮时间预算（秒，节点边界生效）
  --dry-run      只观察不操作
`;

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') { console.log(H); return; }
  const env = baseEnv();

  if (cmd === 'login') {
    const res = await runCore('launch.mjs', { env });
    show(res, 'login（有头浏览器，扫码后回终端 Ctrl+C）');
    return;
  }

  const c = course();

  if (cmd === 'scan') {
    env.START = String(f.start ?? 0);
    env.LIMIT = String(f.limit ?? 18);
    env.GAP = String(f.gap ?? 4000);
    const res = await runCore('_cscan2.mjs', { course: c, env });
    show(res, `scan ${c.courseId}/${c.clazzId}`);
    return;
  }

  if (cmd === 'run') {
    if (f.start) env.CX_START = String(f.start);
    if (f.max) env.CX_MAX = String(f.max);
    if (f.mil) env.CX_MIL = '1';
    if (f['skip-work']) env.CX_SKIP_WORK = '1';
    if (f.budget) env.CX_BUDGET = String(f.budget);
    if (f['dry-run']) env.CX_DRYRUN = '1';
    if (f.force) env.CX_FORCE_LIST = String(f.force);
    const res = await runCore('engine.mjs', { course: c, env, timeoutMs: f.timeout ? Number(f.timeout) * 1000 : undefined });
    show(res, `run ${c.courseId}/${c.clazzId}`);
    process.exitCode = res.code;
    return;
  }

  if (cmd === 'status') {
    const res = await runCore('_cntall.mjs', { course: c, env });
    show(res, 'status');
    return;
  }

  if (cmd === 'stage') {
    const res = await runCore('_stage.mjs', { course: c, env });
    show(res, 'stage');
    return;
  }

  if (cmd === 'doc') {
    const no = f._[0];
    if (!no) fail('用法: chaoxing doc <节号> --kid <knowledgeId>');
    env.CX_NO = String(no);
    if (f.kid) env.CX_KID = String(f.kid);
    if (f.docidx !== undefined) env.CX_DOCIDX = String(f.docidx);
    const res = await runCore('_docread.mjs', { course: c, env });
    show(res, `doc ${no}`);
    return;
  }

  if (cmd === 'quiz') {
    const no = f._[0];
    if (!no) fail('用法: chaoxing quiz <节号> [--shots] 或 [--perq ... --ans ...]');
    env.CX_NO = String(no);
    if (f.shots) {
      const res = await runCore('_quizshot.mjs', { course: c, env });
      show(res, `quiz shots ${no}`);
      return;
    }
    if (f.perq) env.CX_PERQ = String(f.perq);
    if (f.ans) env.CX_ANS = String(f.ans);
    if (f.submit) env.CX_SUBMIT = '1';
    if (f['submit-only']) env.CX_SUBMIT_ONLY = '1';
    if (f.confirm) env.CX_CONFIRM_ONLY = '1';
    const res = await runCore('quiz-answer.mjs', { course: c, env });
    show(res, `quiz answer ${no}`);
    return;
  }

  if (cmd === 'score') {
    const res = await runCore('_score.mjs', { course: c, env });
    show(res, 'score');
    return;
  }

  if (cmd === 'sentinel') {
    env.TAG = String(f.tag || c.courseId);
    env.CID = String(c.courseId);
    if (f.name) env.NAME = String(f.name);
    if (f.kill) env.KILL = '1';
    const res = await runCore('_csentinel.mjs', { course: c, env });
    show(res, 'sentinel');
    return;
  }

  fail('未知命令: ' + cmd + '（chaoxing --help 看用法）');
}

main().catch((e) => { console.error(e); process.exit(1); });
