#!/usr/bin/env node
// chaoxing-kit MCP server（stdio）—— 把刷课能力暴露给支持 MCP 的 agent
// 注意：stdout 只用于协议帧，调试信息一律走 stderr
import { createInterface } from 'node:readline';
import { runCore, lastSummary } from './runner.mjs';

const log = (...a) => console.error('[chaoxing-kit]', ...a);
const VERSION = '0.1.0';

function courseArgs() {
  return {
    course: { type: 'string', description: '课程参数，格式 "courseId/clazzId"，例如 "266987706/154444476"' },
    cpi: { type: 'string', description: '班级 cpi（部分学校需要，可从课程页 URL 里取）' },
    port: { type: 'number', description: '浏览器调试端口，默认 9231' },
    profile: { type: 'string', description: '浏览器用户目录（登录态持久化），默认 ~/.chaoxing-kit/edge-profile' },
  };
}

const TOOLS = [
  {
    name: 'cx_login',
    description: '打开有头 Edge 让用户扫码登录超星；登录态写入 profile，后续无头实例复用。',
    inputSchema: { type: 'object', properties: { port: { type: 'number' } } },
  },
  {
    name: 'cx_scan',
    description: '扫描课程结构：逐个节点读 mArg，输出任务点类型/时长/完成态。用于判断课型（纯视频 / 内嵌测验 / 复合任务点）并估算总时长。',
    inputSchema: {
      type: 'object',
      properties: { ...courseArgs(), start: { type: 'number', description: '起始位置（默认 0）' }, limit: { type: 'number', description: '本次扫描节点数（默认 18，太长会超时）' } },
      required: ['course'],
    },
  },
  {
    name: 'cx_run',
    description: '跑视频节点：真实 1x 播放，播完回读目录确认翻面。遇非视频节点默认停手（退出码 10）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...courseArgs(),
        start: { type: 'string', description: '起始节号，如 "3.1"' },
        max: { type: 'number', description: '本次最多跑几个节点' },
        mil: { type: 'boolean', description: '视频优先模式：播完即过，不等测验翻面（内嵌测验课用）' },
        skipWork: { type: 'boolean', description: '跳过独立测验/讨论节点（课型 D 用）' },
        force: { type: 'string', description: '强制处理的节号列表（逗号分隔），用于目录假完成的补课' },
        budget: { type: 'number', description: '单轮时间预算（秒）' },
      },
      required: ['course'],
    },
  },
  {
    name: 'cx_status',
    description: '读右栏目录完成度与任务点欠账分布（cnt=2 视频+测验都欠 / cnt=1 只欠测验）。',
    inputSchema: { type: 'object', properties: { ...courseArgs() }, required: ['course'] },
  },
  {
    name: 'cx_stage',
    description: '阶段判定：PLAYING（在播，勿扰） / VIDEOS_DONE（可开始测验） / VIDEOS_LEFT <节号> / BUSY（有别的执行体在操作）。会在安全时机 reload 复核，避免目录 stale 误判。',
    inputSchema: { type: 'object', properties: { ...courseArgs() }, required: ['course'] },
  },
  {
    name: 'cx_doc',
    description: '文档任务点：把该节点所有文档 iframe 滚到末页，触发服务端 finishJob 记账。多文档节点会逐个 iframe 处理。',
    inputSchema: {
      type: 'object',
      properties: { ...courseArgs(), no: { type: 'string', description: '节号，如 "9.1"' }, kid: { type: 'string', description: 'knowledgeId（可选，用于先切节点）' }, docIdx: { type: 'number', description: '只处理第 N 个文档 iframe（默认全部）' } },
      required: ['course', 'no'],
    },
  },
  {
    name: 'cx_quiz_shots',
    description: '测验分段截图：把 work 模块按 700px 分段截成多张 png，返回文件路径。交给具备视觉能力的模型（如 DeepSeek 4.1 系列）读题。',
    inputSchema: { type: 'object', properties: { ...courseArgs(), no: { type: 'string' } }, required: ['course', 'no'] },
  },
  {
    name: 'cx_quiz_answer',
    description: '按行索引点选答案并（可选）提交。超星有字体混淆，不能按文字匹配，只能按位置：perq 给每题选项数，ans 给"题号:字母"。提交后应再用 cx_score 核验。',
    inputSchema: {
      type: 'object',
      properties: {
        ...courseArgs(),
        no: { type: 'string' },
        perq: { type: 'string', description: '每题选项数，逗号分隔，如 "4,4,2"；有排序题时首项写 0' },
        ans: { type: 'string', description: '答案，如 "1:B,2:AC,3:A"' },
        submit: { type: 'boolean', description: '选完直接提交（含二次确认）' },
      },
      required: ['course', 'no', 'perq', 'ans'],
    },
  },
  {
    name: 'cx_score',
    description: '读成绩页：返回总分与每题的 my/right/score。提交后用它确认"已完成"而不是"待完成"。',
    inputSchema: { type: 'object', properties: { ...courseArgs() }, required: ['course'] },
  },
];

function parseCourse(s) {
  if (!s) return null;
  const [courseId, clazzId] = String(s).split('/');
  if (!courseId || !clazzId) return null;
  return { courseId, clazzId };
}

function text(res) {
  const s = lastSummary(res.events);
  const parts = [];
  if (res.stdout) parts.push(res.stdout.trim());
  if (s) parts.push(`[summary] done=${s.done}/${s.total}` + (s.results?.length ? ' | ' + JSON.stringify(s.results) : ''));
  if (res.code !== 0 && res.code !== 10 && res.code !== 20) parts.push(`[exit ${res.code}]` + (res.stderr ? '\n' + res.stderr.trim() : ''));
  if (res.logPath) parts.push('[log] ' + res.logPath);
  return { content: [{ type: 'text', text: parts.join('\n') || '(no output)' }], isError: res.code !== 0 && res.code !== 10 && res.code !== 20 };
}

async function callTool(name, a = {}) {
  const c = parseCourse(a.course);
  const env = {};
  if (a.port) env.CX_PORT = String(a.port);
  if (a.profile) env.CX_AUTO_PROFILE = String(a.profile);
  const opts = { course: c, env: { ...env, ...(a.cpi ? { CX_CPI: String(a.cpi) } : {}) }, timeoutMs: 180000 };

  if (name === 'cx_login') return text(await runCore('launch.mjs', { env }));
  if (!c) return { content: [{ type: 'text', text: '缺少或格式错误的 course（应为 "courseId/clazzId"）' }], isError: true };

  if (name === 'cx_scan') {
    opts.env.START = String(a.start ?? 0);
    opts.env.LIMIT = String(a.limit ?? 18);
    return text(await runCore('_cscan2.mjs', opts));
  }
  if (name === 'cx_run') {
    if (a.start) opts.env.CX_START = String(a.start);
    if (a.max) opts.env.CX_MAX = String(a.max);
    if (a.mil) opts.env.CX_MIL = '1';
    if (a.skipWork) opts.env.CX_SKIP_WORK = '1';
    if (a.force) opts.env.CX_FORCE_LIST = String(a.force);
    if (a.budget) opts.env.CX_BUDGET = String(a.budget);
    return text(await runCore('engine.mjs', opts));
  }
  if (name === 'cx_status') return text(await runCore('_cntall.mjs', opts));
  if (name === 'cx_stage') return text(await runCore('_stage.mjs', opts));
  if (name === 'cx_doc') {
    opts.env.CX_NO = String(a.no);
    if (a.kid) opts.env.CX_KID = String(a.kid);
    if (a.docIdx !== undefined) opts.env.CX_DOCIDX = String(a.docIdx);
    return text(await runCore('_docread.mjs', opts));
  }
  if (name === 'cx_quiz_shots') {
    opts.env.CX_NO = String(a.no);
    return text(await runCore('_quizshot.mjs', opts));
  }
  if (name === 'cx_quiz_answer') {
    opts.env.CX_NO = String(a.no);
    opts.env.CX_PERQ = String(a.perq);
    opts.env.CX_ANS = String(a.ans);
    if (a.submit) { opts.env.CX_SUBMIT_ONLY = '1'; opts.env.CX_SUBMIT = '1'; }
    return text(await runCore('quiz-answer.mjs', opts));
  }
  if (name === 'cx_score') return text(await runCore('_score.mjs', opts));

  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
}

function reply(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }
function error(id, code, message) { return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }); }

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      process.stdout.write(reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'chaoxing-kit', version: VERSION },
      }) + '\n');
      return;
    }
    if (method === 'tools/list') {
      process.stdout.write(reply(id, { tools: TOOLS }) + '\n');
      return;
    }
    if (method === 'tools/call') {
      const r = await callTool(params?.name, params?.arguments || {});
      process.stdout.write(reply(id, r) + '\n');
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') { process.stdout.write(reply(id, {}) + '\n'); return; }
    process.stdout.write(error(id, -32601, 'method not found: ' + method) + '\n');
  } catch (e) {
    log('tool error', e.message);
    process.stdout.write(error(id, -32603, e.message) + '\n');
  }
});
rl.on('close', () => process.exit(0));
log('MCP server ready (stdio)');
