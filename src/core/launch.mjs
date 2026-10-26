// 启动带 CDP 的 Edge（独立 profile，不干扰用户日常 Edge）
// 用法: node src/launch.mjs [url]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { waitForBrowser } from './cdp.mjs';

const EDGE = process.env.CX_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CX_PORT || 9229);
const PROFILE = process.env.CX_PROFILE || 'D:\\Download\\chaoxing-auto\\edge-profile';
const url = process.argv[2] || 'https://i.chaoxing.com';

try {
  const v = await waitForBrowser(PORT, 1200);
  console.log('已存在 CDP 实例，复用:', v.Browser, 'port', PORT);
  process.exit(0);
} catch { /* 未启动，继续 */ }

mkdirSync(PROFILE, { recursive: true });

const args = [
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=msEdgeFirstRunExperience',
  '--disable-sync',
  '--no-service-autorun',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--start-maximized',
  url,
];

const p = spawn(EDGE, args, { detached: true, stdio: 'ignore' });
p.unref();

const v = await waitForBrowser(PORT, 45000);
console.log('CDP 就绪:', v.Browser, '| port', PORT);
console.log('profile:', PROFILE);
