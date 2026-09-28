// Extracted from server.js — request/response plumbing and the two process
// helpers that go with it (browser launch, port probe).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');
const { APP_TS, ROOT } = require('./paths.js');

const MAX_BODY = 5 * 1024 * 1024;

// The browser can't run TypeScript, but node can strip the types for it. No tsc,
// no npm, no build step — the .ts file stays the only source.
let appCache = { mtimeMs: 0, js: '' };
function appJs() {
  const st = fs.statSync(APP_TS);
  if (appCache.mtimeMs !== st.mtimeMs) {
    appCache = {
      mtimeMs: st.mtimeMs,
      js: stripTypeScriptTypes(fs.readFileSync(APP_TS, 'utf8'), { mode: 'strip' }),
    };
  }
  return appCache.js;
}

// One module under app/ as stripped JS, or null when the name is unknown. The name
// arrives from a URL, so it is checked against a flat pattern before any path is built.
const appModules = new Map();
function appModule(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = path.join(ROOT, 'app', `${name}.ts`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = appModules.get(name);
  if (!hit || hit.mtimeMs !== st.mtimeMs) {
    appModules.set(name, {
      mtimeMs: st.mtimeMs,
      js: stripTypeScriptTypes(fs.readFileSync(file, 'utf8'), { mode: 'strip' }),
    });
  }
  return appModules.get(name).js;
}

const send = (res, status, body, type = 'application/json; charset=utf-8') => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'content-type': type,
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(buf);
};

// Is a copy of this editor already listening? A double-clicked shortcut must not
// die with EADDRINUSE — it should just show the window that is already there.
async function isUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok && /CONFIG READER/.test(await r.text());
  } catch {
    return false;
  }
}

// Open a URL in the user's browser. The only thing that differs per platform.
// The binary can be absent — a bare WSL or container image has no xdg-open — and a
// spawn failure is emitted asynchronously, so an unhandled 'error' event would take
// the whole server down over a convenience. A browser that does not open is not worth
// losing the editor for: the URL is already printed at startup.
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* no launcher here — the printed URL is the way in */ });
    child.unref();
  } catch { /* spawn itself refused; same answer */ }
}

// A write endpoint on localhost is reachable by any page the user visits.
// Browsers always send Origin cross-origin, so this is the CSRF / DNS-rebinding gate.
// Host is checked too: a DNS-rebinding page reaches 127.0.0.1 with Host=evil.com
// and may send no Origin (form/GET), so Origin alone is not enough.
function originOk(req, port) {
  const host = req.headers.host;
  if (host && host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const o = req.headers.origin;
  if (!o) return true; // same-origin GET / curl
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

// Cap the body by draining past the limit rather than destroying the socket —
// the client deserves the 413, and killing the connection mid-upload makes fetch
// report a bare network error instead. Pausing the stream would never emit 'end'.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0, over = false;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { over = true; chunks.length = 0; return; }  // keep draining, stop holding
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) reject(Object.assign(new Error(`body larger than ${MAX_BODY} bytes`), { status: 413 }));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function jsonBody(req, res) {
  const body = await readBody(req);
  try {
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('not an object');
    return payload;
  } catch (e) {
    send(res, 400, JSON.stringify({ error: `request body is not a JSON object: ${e.message}` }));
    return null;
  }
}

module.exports = {
  MAX_BODY,
  appJs,
  appModule,
  send,
  isUp,
  openBrowser,
  originOk,
  readBody,
  jsonBody,
};
