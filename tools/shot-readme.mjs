// Dev-only. Screenshots for the README: the same page tools/shot.mjs drives, but framed
// at a fixed 1280x720 so every image in the README is the same size and looks like a
// window rather than a scrolled document. shot.mjs keeps its own tall, full-page framing
// for development; this one exists only for docs.
//
//   OUT=./assets node tools/shot-readme.mjs [http://127.0.0.1:8787]
//
// Needs a running server and any Chromium (CHROME=... to point at one).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The README frame. 1280x720 is the HD default; deviceScaleFactor 1 keeps the file
// small enough for a repo and the text crisp at 100%.
const W = 1280;
const H = 720;

function findChrome() {
  const cands = [];
  if (process.env.CHROME) cands.push(process.env.CHROME);
  const pw = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (pw && existsSync(pw)) {
    for (const d of readdirSync(pw).filter(d => d.startsWith('chromium-'))) {
      cands.push(join(pw, d, 'chrome-win64', 'chrome.exe'),
        join(pw, d, 'chrome-win', 'chrome.exe'));
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
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = Number(process.env.CDP_PORT || 9335);
const OUT = process.env.OUT || join(process.cwd(), 'assets');
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,900', '--hide-scrollbars',
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
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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

// Always the viewport, never the scrolled page: captureBeyondViewport false.
const shot = async (name, { dark = false } = {}) => {
  await cmd('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
  });
  await sleep(300);
  const { data } = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(OUT, name);
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
// Pin the viewport to the exact frame. A --window-size alone loses ~150px to the
// browser's own chrome, so the file would not be a real 1280x720.
await cmd('Emulation.setDeviceMetricsOverride', {
  width: W, height: H, deviceScaleFactor: 1, mobile: false,
});

// --- landing ---------------------------------------------------------------
await cmd('Page.navigate', { url: URL_BASE + '/' });
await sleep(1400);
await shot('landing-dark.png', { dark: true });

// --- editor: pick the first card, which scans and opens the form -----------
await evaluate(`document.querySelector('.tool-card').click()`);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.querySelector('[data-js="editor"]').hidden`)) break;
  await sleep(250);
}
await sleep(500);
await shot('editor-dark.png', { dark: true });

// --- model picker, with the live endpoint's real list ----------------------
await evaluate(`(()=>{
  const card=[...document.querySelectorAll('[data-js="editor-form"] .field-card')]
    .find(f=>f.getAttribute('data-card')==='ANTHROPIC_MODEL');
  card.querySelector('.field-card__row').querySelectorAll('button')[0].click();
})()`);
for (let i = 0; i < 60; i++) {
  if (await evaluate(`document.querySelectorAll('[data-js="model-picker-list"] .model-row').length > 0`)) break;
  await sleep(250);
}
await sleep(500);
await shot('model-picker-dark.png', { dark: true });

// The numbers the README quotes come from here, so print them.
console.log('picker note:', await evaluate(`document.querySelector('[data-js="model-picker-note"]').textContent`));
console.log('rows:', await evaluate(`document.querySelectorAll('[data-js="model-picker-list"] .model-row').length`));
console.log('page errors:', await evaluate(`JSON.stringify(window.__errs || [])`));

ws.close();
chrome.kill();
await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
