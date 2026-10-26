// 读右栏目录全表（含 cnt），用于内嵌测验课阶段判定
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach(Number(process.env.CX_PORT || 9231), { match: (t) => t.type === 'page' });
await cdp.send('Runtime.enable');
const href = await cdp.eval('location.href').catch(() => '');
const rows = await cdp.eval(`(() => [...document.querySelectorAll('.posCatalog_level li')].map((li) => {
  const sel = li.querySelector('.posCatalog_select'), nm = li.querySelector('.posCatalog_name');
  const sb = li.querySelector('.posCatalog_sbar'), hid = li.querySelector('.jobUnfinishCount');
  return { no: sb ? (sb.innerText||'').replace(/\\s+/g,' ').trim() : '', id: sel && sel.id ? sel.id.replace(/^cur/,'') : null,
    t: nm ? (nm.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30) : '',
    done: !!li.querySelector('.icon_Completed'), cnt: hid ? String(hid.value) : '' };
}).filter(n => n.id))()`).catch(() => []);
console.log('URL', String(href).slice(0, 120));
console.log('total', rows.length, 'done', rows.filter(r => r.done).length);
const c2 = rows.filter(r => !r.done && r.cnt === '2');
const c1 = rows.filter(r => !r.done && r.cnt === '1');
console.log('cnt=2(todo):', c2.map(r => r.no).join(' ') || '-');
console.log('cnt=1(todo):', c1.length, '节');
console.log('cnt=空(todo):', rows.filter(r => !r.done && !r.cnt).map(r => r.no).join(' ') || '-');
// 视频节点清单
import { readFileSync } from 'node:fs';
let vidKids = new Set();
try {
  for (const p of [0, 14, 28, 42]) {
    for (const r of JSON.parse(readFileSync(`state/scan-266987714-part${p}.json`, 'utf8'))) {
      if (r.at.some(a => a.type === 'video')) vidKids.add(r.no);
    }
  }
} catch {}
const vidPending = rows.filter(r => vidKids.has(r.no) && !r.done);
console.log('视频节点', vidKids.size, '仍 todo', vidPending.length,
  '| cnt分布', JSON.stringify(vidPending.reduce((m, r) => (m[r.cnt || 'empty'] = (m[r.cnt || 'empty'] || 0) + 1, m), {})));
cdp.close();
