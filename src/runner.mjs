// 子进程运行器：spawn core/*.mjs，透传 CX_* 环境变量，回收本次运行的 jsonl 事件日志
import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, 'core');

export function corePath(name) {
  return join(CORE, name);
}

function newestLog(dir) {
  const d = join(dir, 'logs');
  if (!existsSync(d)) return null;
  const files = readdirSync(d).filter((f) => /^engine-.*\.jsonl$/.test(f));
  if (!files.length) return null;
  files.sort((a, b) => statSync(join(d, b)).mtimeMs - statSync(join(d, a)).mtimeMs);
  return join(d, files[0]);
}

function parseEvents(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { ev: 'unparsed', raw: l }; }
    });
  } catch { return []; }
}

/**
 * 跑一个 core 脚本。
 * @param {string} script    core 下的文件名，如 'engine.mjs'
 * @param {object} opts      { course: {courseId, clazzId, cpi}, env: {}, args: [], workdir, timeoutMs }
 * @returns {Promise<{code:number, stdout:string, stderr:string, events:object[], logPath:string|null}>}
 */
export function runCore(script, opts = {}) {
  const workdir = opts.workdir || process.cwd();
  const env = { ...process.env, ...(opts.env || {}) };
  const c = opts.course || {};
  if (c.courseId) { env.CX_COURSE_ID = String(c.courseId); env.CID = String(c.courseId); }
  if (c.clazzId) { env.CX_CLAZZID = String(c.clazzId); env.CLA = String(c.clazzId); }
  if (c.cpi) env.CX_CPI = String(c.cpi);

  const before = newestLog(workdir);
  const file = corePath(script);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...(opts.args || [])], {
      cwd: workdir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, opts.timeoutMs) : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const after = newestLog(workdir);
      const logPath = after && after !== before ? after : null;
      resolve({ code: code ?? -1, stdout, stderr, events: logPath ? parseEvents(logPath) : [], logPath });
    });
  });
}

/** 从 events 里提最后一个 summary（引擎每轮结束都会写） */
export function lastSummary(events) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].ev === 'summary') return events[i];
  return null;
}
