// Dev-only. Screenshots the real page through Chrome DevTools Protocol so layout
// and wording can be looked at instead of guessed. No dependencies: node has a
// global WebSocket, and any Chromium will do.
//   OUT=./tools/shots node tools/shot.mjs [http://127.0.0.1:8787]
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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
  try { globalThis.__restoreConnections?.(); } catch { /* nothing to put back yet */ }
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

// --- the landing on a phone: the header stack and the footer ---
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(500);
await shot(join(OUT, '17-phone-landing.png'), { full: false });
await cmd('Emulation.clearDeviceMetricsOverride');
await sleep(400);

// --- the landing card lifts on hover ----------------------------------------–
// Guards the entrance animation: with fill-mode `both` the finished animation keeps
// applying translate: 0 0, and an applied animation outranks the hover rule, so the
// card would never move. Read the computed value, not the pixels.
const cardBox = JSON.parse(await evaluate(`(()=>{const r=document.querySelector('.tool-card').getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardBox.x, y: cardBox.y, buttons: 0 });
await sleep(400);
console.log('landing card hover:', await evaluate(`getComputedStyle(document.querySelector('.tool-card')).translate`));

// --- editor: pick the first card, which scans and opens the form ---
await evaluate(`document.querySelector('.tool-card').click()`);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.querySelector('[data-js="editor"]').hidden`)) break;
  await sleep(250);
}
await sleep(400);
await shot(join(OUT, '03-editor.png'));
await shot(join(OUT, '04-editor-dark.png'), { dark: true });

// --- the description behind the "?" -------------------------------------------
// The hint is a row's only prose now, so it has to survive being hovered.
const hintBox = JSON.parse(await evaluate(`(()=>{const r=document.querySelector('.hint').getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`));
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hintBox.x, y: hintBox.y, buttons: 0 });
await sleep(400);
console.log('hint tip:', await evaluate(`getComputedStyle(document.querySelector('.hint'), '::after').opacity`),
  await evaluate(`document.querySelector('.hint').getAttribute('data-tip')`));
await shot(join(OUT, '19-hint.png'), { full: false });

// --- the form's own test button, on the row that holds the model --------------
const probeBtn = await evaluate(`(()=>{
  const card=[...document.querySelectorAll('[data-js="editor-form"] .field-card')]
    .find(f=>f.getAttribute('data-card')==='ANTHROPIC_DEFAULT_OPUS_MODEL');
  const btn=card.querySelector('.field-card__test');
  if(!btn) return 'no test button';
  btn.click();
  return 'clicked';
})()`);
console.log('form test:', probeBtn);
await sleep(8000);
console.log('form test result:', await evaluate(`(()=>{
  const card=[...document.querySelectorAll('[data-js="editor-form"] .field-card')]
    .find(f=>f.getAttribute('data-card')==='ANTHROPIC_DEFAULT_OPUS_MODEL');
  const btn=card.querySelector('.field-card__test');
  return JSON.stringify({ cls: btn.className, title: btn.title, hasIcon: !!btn.querySelector('.icon') });
})()`));
await shot(join(OUT, '23-form-test.png'), { full: false });

// --- scrolled: the header lifts and the back-to-top button shows itself ------–
// The two things a static shot cannot show, asserted rather than eyeballed.
await evaluate(`window.scrollTo({ top: 1400, behavior: 'auto' })`);
await sleep(500);
console.log('scroll chrome:', await evaluate(`JSON.stringify({
  top: document.querySelector('[data-js="to-top"]').classList.contains('to-top--shown'),
  stuck: document.querySelector('[data-js="actionbar"]').classList.contains('actionbar--stuck'),
  barTop: Math.round(document.querySelector('[data-js="actionbar"]').getBoundingClientRect().top),
})`));
await shot(join(OUT, '16-scrolled.png'), { full: false });
await evaluate(`window.scrollTo({ top: 0, behavior: 'auto' })`);
await sleep(300);

// --- models: open the picker dialog from the Model field's fetch button ------
// The picker is a modal now, so this is the one field button, not a tab.
const openPicker = async key => {
  await evaluate(`(()=>{
    const card=[...document.querySelectorAll('[data-js="editor-form"] .field-card')]
      .find(f=>f.getAttribute('data-card')===${JSON.stringify(key)});
    card.querySelector('.field-card__row').querySelectorAll('button')[0].click();
  })()`);
  for (let i = 0; i < 60; i++) {
    // Wait for actual rows: the loading state is a child of the list too, so a
    // "children.length > 0" check passes before any model has arrived.
    if (await evaluate(`document.querySelectorAll('[data-js="model-picker-list"] .model-row').length > 0`)) break;
    await sleep(250);
  }
  await sleep(400);
};
await openPicker('ANTHROPIC_MODEL');
const n = await evaluate(`document.querySelectorAll('[data-js="model-picker-list"] .model-row').length`);
console.log('models rendered:', n);
// What the live endpoint made the picker say: the note's counts, the badges on the
// rows, and one row's tooltip. Printed so a real gateway is verified by reading.
console.log('picker note:', await evaluate(`document.querySelector('[data-js="model-picker-note"]').textContent`));
console.log('picker badges:', await evaluate(`(()=>{
  const rows=[...document.querySelectorAll('[data-js="model-picker-list"] .model-row')];
  const n=cls=>rows.filter(r=>r.querySelector('.'+cls)).length;
  return JSON.stringify({ rows: rows.length, free: n('badge--free'), sunset: n('badge--warn'),
    chips: rows.reduce((a,r)=>a+r.querySelectorAll('.cap').length,0),
    // A filter that looks on but is off would show the wrong list under a wrong box.
    filters: { oneM: document.querySelector('[data-js="filter-1m"]').checked,
               vision: document.querySelector('[data-js="filter-vision"]').checked } });
})()`));
console.log('a row tooltip:', await evaluate(`(()=>{
  const r=[...document.querySelectorAll('[data-js="model-picker-list"] .model-row')].find(x=>x.querySelector('.badge--free'));
  return r ? r.querySelector('.model-row__use').title.replace(/\\n/g,' | ') : 'no free model in this list';
})()`));
await shot(join(OUT, '05-picker.png'));
await shot(join(OUT, '06-picker-dark.png'), { dark: true });

// --- the filter narrows it, and the provider grouping -----------------------
await evaluate(`(()=>{const f=document.querySelector('[data-js="model-picker-filter"]');f.value='claude';f.dispatchEvent(new Event('input'));})()`);
await sleep(300);
console.log('filtered to:', await evaluate(`document.querySelectorAll('[data-js="model-picker-list"] .model-row').length`));
await shot(join(OUT, '08-filter.png'), { full: false });
await evaluate(`(()=>{const f=document.querySelector('[data-js="model-picker-filter"]');f.value='';f.dispatchEvent(new Event('input'));})()`);
await sleep(200);
console.log('groups:', await evaluate(`JSON.stringify([...document.querySelectorAll('.provider-group__name')].map(n=>n.textContent))`));

// --- the health check: one tiny request, to a model the gateway says is free ----
// Free models cost nothing, so a failure means the endpoint is down rather than out
// of credit. Which ones are free differs per gateway, so the list decides, not us.
const tested = await evaluate(`(async()=>{
  const rows=[...document.querySelectorAll('[data-js="model-picker-list"] .model-row')];
  const free=rows.find(r=>r.querySelector('.badge--free')) || rows.find(r=>/free/i.test(r.dataset.model)) || rows[0];
  if(!free) return 'no rows to test';
  const btn=free.querySelector('.model-row__test');
  btn.click();
  for (let i=0;i<120;i++){ if(!btn.classList.contains('model-row__test--busy')) break; await new Promise(r=>setTimeout(r,250)); }
  return JSON.stringify({ model: free.dataset.model, label: btn.title, cls: btn.className });
})()`);
console.log('health check:', tested);
await shot(join(OUT, '18-test.png'), { full: false });

// --- hover reveals the lift (mouse only) ---
// The name comes off the loaded list: the endpoint is whatever this machine points at,
// so a hardcoded model id is a screenshot that only works on one laptop.
const firstModel = await evaluate(`document.querySelector('[data-js="model-picker-list"] .model-row code').textContent`);
await evaluate(`(()=>{const f=document.querySelector('[data-js="model-picker-filter"]');f.value=${JSON.stringify(firstModel)};f.dispatchEvent(new Event('input'));})()`);
await sleep(250);
const box = await evaluate(`(()=>{const r=document.querySelector('[data-js="model-picker-list"] .model-row').getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});})()`);
const { x, y } = JSON.parse(box);
await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
await sleep(400);
await shot(join(OUT, '09-assign-hover.png'), { full: false });

// --- a narrow viewport, to check the layout does not break on a phone ---
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(400);
console.log('phone picker overflow:', await evaluate(`(()=>{
  const list=document.querySelector('[data-js="model-picker-list"]');
  const rows=[...list.querySelectorAll('.model-row')];
  const box=list.getBoundingClientRect();
  const worst=rows.reduce((m,r)=>Math.max(m, r.getBoundingClientRect().right), 0);
  return JSON.stringify({ listRight: Math.round(box.right), worstRowRight: Math.round(worst),
    overflow: Math.round(worst - box.right), docScroll: document.documentElement.scrollWidth });
})()`));
await shot(join(OUT, '10-phone-picker.png'), { full: false });
await evaluate(`document.querySelector('[data-js="model-picker-close"]').click()`);
await sleep(300);
await shot(join(OUT, '11-phone-env.png'));
await cmd('Emulation.clearDeviceMetricsOverride');

// --- the 1M marker: assign a model and read back what landed in env ------------
// Claude Code only honours a 1M window when the model name ends in [1m], so this
// reports what the editor wrote for the first two models the endpoint offers.
await openPicker('ANTHROPIC_MODEL');
const marked = await evaluate(`(()=>{
  const rows=[...document.querySelectorAll('[data-js="model-picker-list"] .model-row')];
  // The row is a div; the button inside it is what assigns.
  const pick=r=>{r.querySelector('.model-row__use').click();return document.querySelector('[data-field="ANTHROPIC_MODEL"]').value;};
  const first=pick(rows[0]);
  rows[0].querySelector('.model-row__use').click();
  const second=pick(rows[1]||rows[0]);
  return JSON.stringify({first, second});
})()`);
console.log('marker check:', marked);
await shot(join(OUT, '12-marker.png'), { full: false });

// --- a non-Claude tool: three fields, patched into its own config format ------
// Back to the landing first, then pick Codex from the tool cards. The switch guard
// is a confirm(), which blocks a headless renderer until it is answered.
await evaluate(`window.confirm = () => true; document.querySelector('[data-js="editor-back"]').click()`);
await sleep(300);
await shot(join(OUT, '13-landing-picker.png'), { full: false });
const picked = await evaluate(`(()=>{
  const card=[...document.querySelectorAll('.tool-card')].find(c=>c.textContent.includes('Codex'));
  if(!card) return 'card missing';
  card.click();
  return card.textContent;
})()`);
console.log('picked:', picked);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.querySelector('[data-js="editor"]').hidden`)) break;
  await sleep(250);
}
await sleep(400);
await shot(join(OUT, '14-codex.png'));
await shot(join(OUT, '15-codex-dark.png'), { dark: true });
const simple = await evaluate(`JSON.stringify({
  title: document.querySelector('[data-js="editor-title"]').textContent,
  fields: [...document.querySelectorAll('[data-js="editor-form"] .field-card')].map(e=>e.getAttribute('data-card')),
  others: document.querySelector('[data-js="other-vars"]').hidden,
  pickers: document.querySelectorAll('[data-js="editor-form"] .field-card__row button').length,
})`);
console.log('codex editor:', simple);

// --- Hermes: the default model plus the role slots it reads -------------------
await evaluate(`window.confirm = () => true; document.querySelector('[data-js="editor-back"]').click()`);
await sleep(300);
const pickedHermes = await evaluate(`(()=>{
  const card=[...document.querySelectorAll('.tool-card')].find(c=>c.textContent.includes('Hermes'));
  if(!card) return 'card missing';
  card.click();
  return card.textContent;
})()`);
console.log('picked:', pickedHermes);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.querySelector('[data-js="editor"]').hidden`)) break;
  await sleep(250);
}
await sleep(400);
console.log('hermes editor:', await evaluate(`JSON.stringify({
  fields: [...document.querySelectorAll('[data-js="editor-form"] .field-card')].map(e=>e.getAttribute('data-card')),
  groups: [...document.querySelectorAll('.field-group__title')].map(e=>e.textContent),
})`));
await shot(join(OUT, '20-hermes.png'));
await shot(join(OUT, '21-hermes-dark.png'), { dark: true });

// --- routing: a link straight to a tool opens it, and Back closes it ----------
await cmd('Page.navigate', { url: URL_BASE + '/#hermes' });
await sleep(1500);
console.log('cold load #hermes:', await evaluate(`JSON.stringify({
  hash: location.hash,
  editorOpen: !document.querySelector('[data-js="editor"]').hidden,
  title: document.querySelector('[data-js="editor-title"]').textContent,
})`));
await evaluate(`document.querySelector('[data-js="editor-back"]').click()`);
await sleep(500);
console.log('after back:', await evaluate(`JSON.stringify({
  hash: location.hash,
  editorOpen: !document.querySelector('[data-js="editor"]').hidden,
})`));

// Two tools deep, the sidebar's back is still the way out to the picker.
await evaluate(`document.querySelectorAll('[data-js="tool-picker"] .tool-card')[0].click()`);
await sleep(1200);
await evaluate(`document.querySelectorAll('[data-js="tool-picker"] .tool-card')[1].click()`);
await sleep(1200);
console.log('two deep:', await evaluate(`JSON.stringify({ hash: location.hash, title: document.querySelector('[data-js="editor-title"]').textContent })`));
await evaluate(`document.querySelector('[data-js="editor-back"]').click()`);
await sleep(500);
console.log('back from two deep:', await evaluate(`JSON.stringify({
  hash: location.hash,
  editorOpen: !document.querySelector('[data-js="editor"]').hidden,
})`));
await shot(join(OUT, '22-routing.png'), { full: false });

// --- saved endpoints: the dialog, empty then with two rows, both themes ---------
// A real store on this machine is what the dialog reads, so seed one through the
// running server and then clean it up: the file is the user's, not the tool's.
// A tool has to be open first: Apply only exists where there is a form to fill.
await evaluate(`document.querySelectorAll('[data-js="tool-picker"] .tool-card')[0].click()`);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.querySelector('[data-js="editor"]').hidden`)) break;
  await sleep(250);
}
const connFile = join(homedir(), '.config-reader', 'connections.json');
const connBackup = existsSync(connFile) ? readFileSync(connFile, 'utf8') : null;
// This script writes a store into the real home, so the restore has to survive a
// crash: bail() runs the same cleanup, or a failed run leaves demo rows behind.
const restoreConnections = () => {
  try {
    if (connBackup === null) rmSync(join(homedir(), '.config-reader'), { recursive: true, force: true });
    else writeFileSync(connFile, connBackup);
  } catch { /* the file is the user's; a failed restore must not mask the real error */ }
};
await evaluate(`(async()=>{ await fetch('/api/connections',{method:'POST',headers:{'content-type':'application/json'},
  body: JSON.stringify({ profiles: [
    { name: 'local gateway', baseUrl: 'http://localhost:20128', model: 'kenari/ka-free', apiKey: 'sk-demo-token' },
    { name: 'ai.ka4.dev', baseUrl: 'https://ai.ka4.dev', model: 'kenari/deepseek-v4-1-flash' },
  ] }) }); })()`);
await evaluate(`document.querySelector('[data-js="connections-open"]').click()`);
for (let i = 0; i < 40; i++) {
  if (await evaluate(`document.querySelectorAll('[data-js="connections-list"] .conn').length === 2`)) break;
  await sleep(250);
}
await sleep(500);
console.log('connections dialog:', await evaluate(`JSON.stringify({
  rows: document.querySelectorAll('[data-js="connections-list"] .conn').length,
  apply: document.querySelectorAll('[data-js="connections-list"] .conn__apply').length,
  note: document.querySelector('[data-js="connections-note"]').textContent,
})`));
await shot(join(OUT, '24-connections.png'));
await shot(join(OUT, '25-connections-dark.png'), { dark: true });
// Phone: the row's label column folds, and the dialog becomes the screen.
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
await sleep(500);
await shot(join(OUT, '26-connections-phone.png'), { full: false });
await cmd('Emulation.clearDeviceMetricsOverride');
await sleep(400);
// Apply, and read back what the form holds: the one thing the UI test cannot show.
await evaluate(`document.querySelectorAll('[data-js="connections-list"] .conn__apply')[0].click()`);
await sleep(1200);
console.log('after apply:', await evaluate(`JSON.stringify({
  dialogOpen: document.querySelector('[data-js="connections"]').open,
  base: document.querySelector('[data-card="ANTHROPIC_BASE_URL"] input').value,
  model: document.querySelector('[data-card="ANTHROPIC_MODEL"] input').value,
  token: document.querySelector('[data-card="ANTHROPIC_AUTH_TOKEN"] input').value.slice(0, 6) + '…',
  dirty: document.querySelector('[data-js="actionbar-dot"]').className.includes('dirty'),
})`));
await shot(join(OUT, '27-after-apply.png'), { full: false });
// Put the store back the way it was found.
restoreConnections();

// --- console errors? ---
const errs = await evaluate(`JSON.stringify(window.__errs||[])`);
console.log('page errors:', errs);

ws.close();
chrome.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
