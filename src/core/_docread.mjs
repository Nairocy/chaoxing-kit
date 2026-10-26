// 文档任务点：真实滚动阅读到末页，触发 finishJob（服务端记任务点）
// 用法: CX_NO=1.3 node src/_docread.mjs [scroll=1]
import { CDP, sleep } from './cdp.mjs';
const NO = process.env.CX_NO || '';
const KID = process.env.CX_KID || '';
const CID = process.env.CX_COURSE_ID || '';
const CLA = process.env.CX_CLAZZID || '';
const cdp = await CDP.attach(Number(process.env.CX_PORT || 9231), { match: (t) => t.type === 'page' });
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await sleep(500);

// 可选：先切节点（页面须已在该课的 studentstudy；用 scan 里的 kid）
if (KID && CID && CLA) {
  const r = await cdp.eval(`(() => { try { getTeacherAjax('${CID}','${CLA}','${KID}'); return 'ok'; } catch (e) { return String(e); } })()`).catch((e) => String(e));
  console.log('switch', NO, r);
  await sleep(8000);
}

// 多文档节点：每个文档各是一个独立 pan-yz iframe（2026-10-25 实测 9.1 = 3 个）
// CX_DOCIDX 表示「只滚第 N 个」；不传则全部滚一遍
const docIdxRaw = process.env.CX_DOCIDX;
const yzs = (await cdp.frameTree()).filter((f) => /pan-yz\.chaoxing\.com\/screen/.test(f.url));
if (!yzs.length) { console.log('NO pan-yz frame'); process.exit(1); }
const pick = (docIdxRaw !== undefined && docIdxRaw !== '') ? [yzs[parseInt(docIdxRaw, 10)]].filter(Boolean) : yzs;
console.log('pan-yz frames', yzs.length, '→ 本次滚', pick.length);
for (let i = 0; i < pick.length; i++) {
  const yz = pick[i];
  const st = await cdp.eval(`(() => ({ dh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight, y: window.scrollY }))()`, { frameId: yz.id }).catch(() => null);
  if (!st) { console.log('frame#' + i, 'read fail'); continue; }
  console.log('doc', NO, '#' + i, JSON.stringify(st));
  const max = st.dh - st.ch;
  if (max > 0) {
    for (let y = 0; y <= max; y += 600) {
      await cdp.eval(`window.scrollTo(0, ${y})`, { frameId: yz.id }).catch(() => {});
      await sleep(200);
    }
    await cdp.eval(`window.scrollTo(0, ${max + 50})`, { frameId: yz.id }).catch(() => {});
    await sleep(1200);
    await cdp.eval(`window.dispatchEvent(new Event('scroll'))`, { frameId: yz.id }).catch(() => {});
    await sleep(2500);
  }
  const after = await cdp.eval(`(() => ({ y: window.scrollY, dh: document.documentElement.scrollHeight }))()`, { frameId: yz.id }).catch(() => null);
  console.log('afterScroll #' + i, JSON.stringify(after));
}

// 看 cards 帧里 document 卡片是否已 ans-job-finished
const cards = (await cdp.frameTree()).find((f) => /knowledge\/cards/.test(f.url));
if (cards) {
  const cls = await cdp.eval(`(() => [...document.querySelectorAll('.ans-attach-ct')].map((e) => (e.className||'').toString().trim()))()`, { frameId: cards.id }).catch((e) => e.message);
  console.log('docCards', JSON.stringify(cls));
}
const pdf = (await cdp.frameTree()).find((f) => /ananas\/modules\/pdf/.test(f.url));
if (pdf) {
  const ff = await cdp.eval(`(() => { try { return { finishFlag: window.finishFlag, chk: (typeof checkJobFinish === 'function' ? checkJobFinish() : 'NA') }; } catch (e) { return { err: e.message }; } })()`, { frameId: pdf.id }).catch((e) => e.message);
  console.log('pdfModule', JSON.stringify(ff));
}
cdp.close();
