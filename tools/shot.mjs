// Dev-only. Screenshots the real page through Chrome DevTools Protocol so layout
// and wording can be looked at instead of guessed. No dependencies: node has a
// global WebSocket, and any Chromium will do.
//   OUT=./tools/shots node tools/shot.mjs [http://127.0.0.1:8787]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Find a browser. Env override first, then whatever playwright already downloaded,
// then the browsers that ship with Windows. Nothing hardcoded to one machine.
function findChrome() {
  const cands = [];
  if (process.env.CHROME) cands.push(process.env.CHROME);
  const pw = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (pw && existsSync(pw)) {
    for (const d of readdirSync(pw).filter(d => d.startsWith('chromium-'))) {
      cands.push(join(pw, d, 'chrome-win64', 'chrome.exe'),
        join(pw, d, 'chrome-win', 'chrome.exe'));
    }
    for (const d of readdirSync(pw).filter(d => d.startsWith('chromium_headless_shell-'))) {
      cands.push(join(pw, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'));
    }
  }
  for (const p of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']) {
    const base = process.env[p];
    if (base) cands.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return cands.find(p => existsSync(p)) || null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('No Chromium found. Set CHROME=/path/to/chrome and try again.');
  process.exit(1);
}
console.log('browser:', CHROME);
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = Number(process.env.CDP_PORT || 9333);
const OUT = process.env.OUT || join(process.cwd(), 'tools', 'shots');
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1180,1000', '--hide-scrollbars',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* chrome still starting */ }
    await sleep(250);
  }
  throw new Error('chrome never came up');
}

const ws = new WebSocket(await target());
await new Promise(r => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m);
});
const cmd = (method, params = {}, ms = 20000) => new Promise((res, rej) => {
  const n = ++id;
  const t = setTimeout(() => {
    pending.delete(n);
    rej(new Error(`${method}: no reply in ${ms}ms (chrome may have died)`));
  }, ms);
  pending.set(n, m => {
    clearTimeout(t);
    if (m.error) rej(new Error(`${method}: ${m.error.message}`)); else res(m.result);
  });
  ws.send(JSON.stringify({ id: n, method, params }));
});
ws.addEventListener('close', () => {
  for (const [n, fn] of pending) fn({ error: { message: 'socket closed' } });
});

const evaluate = async expr => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

const shot = async (file, { dark = false, full = true } = {}) => {
  await cmd('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  });
  await sleep(250);
  const { data } = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('wrote', file);
};

const bail = async e => {
  console.error('FAILED:', e.message);
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  process.exit(1);
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

await cmd('Page.enable');
await cmd('Runtime.enable');

// --- landing ---
await cmd('Page.navigate', { url: URL_BASE + '/' });
await sleep(1200);
await shot(join(OUT, '01-landing.png'));
await shot(join(OUT, '02-landing-dark.png'), { dark: true });

// --- editor: press Scan, wait for the form ---
await evaluate(`document.getElementById('scanbtn').click()`);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.getElementById('editor').hidden`)) break;
  await sleep(250);
}
await sleep(400);
await shot(join(OUT, '03-editor.png'));
await shot(join(OUT, '04-editor-dark.png'), { dark: true });

// --- models tab: load the real list ---
await evaluate(`[...document.querySelectorAll('.tab')].find(t=>t.textContent==='Models').click()`);
await sleep(200);
await shot(join(OUT, '05-models-empty.png'));
await evaluate(`document.getElementById('loadmodels').click()`);
for (let i = 0; i < 60; i++) {
  if (await evaluate(`document.getElementById('modellist').children.length > 0`)) break;
  await sleep(250);
}
await sleep(400);
const n = await evaluate(`document.getElementById('modellist').children.length`);
console.log('models rendered:', n);
await shot(join(OUT, '06-models.png'));
await shot(join(OUT, '07-models-dark.png'), { dark: true });

// --- a filter that matches nothing ---
await evaluate(`(()=>{const f=document.getElementById('modelfilter');f.value='zzz';f.dispatchEvent(new Event('input'));})()`);
await sleep(300);
await shot(join(OUT, '08-filter-miss.png'), { full: false });

// --- hover reveals the Assign button (mouse only) ---
await evaluate(`(()=>{const f=document.getElementById('modelfilter');f.value='claude-opus-5';f.dispatchEvent(new Event('input'));})()`);
await sleep(250);
const box = await evaluate(`(()=>{const r=document.getElementById('modellist').children[0].getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`);
const { x, y } = JSON.parse(box);
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
await sleep(400);
await shot(join(OUT, '09-assign-hover.png'), { full: false });

// --- a narrow viewport, to check the layout does not break on a phone ---
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(400);
await shot(join(OUT, '10-phone-models.png'), { full: false });
await evaluate(`document.querySelectorAll('.tab')[0].click()`);
await sleep(300);
await shot(join(OUT, '11-phone-env.png'));
await cmd('Emulation.clearDeviceMetricsOverride');

// --- the 1M marker: assign a 1M model and read back what landed in env ---------
// Claude Code only honours a 1M window when the model name ends in [1m], so this
// asserts the editor adds it — and leaves it off for a model below 1M.
await evaluate(`(()=>{const f=document.getElementById('modelfilter');f.value='';f.dispatchEvent(new Event('input'));})()`);
await evaluate(`[...document.querySelectorAll('.tab')].find(t=>t.textContent==='Models').click()`);
await sleep(200);
const marked = await evaluate(`(()=>{
  const rows=[...document.getElementById('modellist').children];
  const pick=id=>{const r=rows.find(r=>r.querySelector('code').textContent===id);if(!r)return 'row missing';
    r.querySelectorAll('button')[0].click();return document.getElementById('f_ANTHROPIC_MODEL').value;};
  const oneM=pick('knr/deepseek-v4-1-flash');
  const small=pick('knr/agnes-2-0-flash:free');
  return JSON.stringify({oneM,small});
})()`);
console.log('marker check:', marked);
await shot(join(OUT, '12-marker.png'), { full: false });

// --- a non-Claude tool: three fields, patched into its own config format ------
// Back to the landing first, then pick Codex from the tool cards. The switch guard
// is a confirm(), which blocks a headless renderer until it is answered.
await evaluate(`window.confirm = () => true; document.getElementById('switch').click()`);
await sleep(300);
await shot(join(OUT, '13-landing-picker.png'), { full: false });
const picked = await evaluate(`(()=>{
  const card=[...document.querySelectorAll('.tool')].find(c=>c.textContent.includes('Codex'));
  if(!card) return 'card missing';
  card.click();
  document.getElementById('scanbtn').click();
  return card.textContent;
})()`);
console.log('picked:', picked);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.getElementById('editor').hidden`)) break;
  await sleep(250);
}
await sleep(400);
await shot(join(OUT, '14-codex.png'));
await shot(join(OUT, '15-codex-dark.png'), { dark: true });
const simple = await evaluate(`JSON.stringify({
  title: document.getElementById('title').textContent,
  fields: [...document.querySelectorAll('#form .fkey')].map(e=>e.textContent),
  others: document.getElementById('others').hidden,
  targets: document.getElementById('modeltarget').children.length,
})`);
console.log('codex editor:', simple);

// --- console errors? ---
const errs = await evaluate(`JSON.stringify(window.__errs||[])`);
console.log('page errors:', errs);

ws.close();
chrome.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
