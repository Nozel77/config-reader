// CONFIG READER — local web editor. Zero npm deps, Node stdlib only.
//   node server.js [--port 8787] [--open] [--selftest]
'use strict';

// Needs Node 22+: stripTypeScriptTypes, global fetch, AbortSignal.timeout.
// Fail with a sentence instead of a stack trace on an older runtime.
const [NODE_MAJOR] = process.versions.node.split('.').map(Number);
if (NODE_MAJOR < 22) {
  console.error(`CONFIG READER needs Node.js 22 or newer (running ${process.versions.node}).`);
  process.exit(1);
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');

const HERE = __dirname;
const INDEX = path.join(HERE, 'index.html');
const APP_TS = path.join(HERE, 'app.ts');
const ICONS = path.join(HERE, 'icons');

// CLAUDE_CONFIG_DIR overrides ~/.claude entirely. Check it before homedir().
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

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

// Claude Code writes LF on every platform (verified on Windows). Detect per file
// anyway rather than trusting that — a CRLF file must not be silently rewritten.
const detectEol = text => (text.includes('\r\n') ? '\r\n' : '\n');

// ---------------------------------------------------------------- the file

// The one file this editor works on. Fixed server-side on purpose: no path ever
// arrives from the browser, so there is no path to validate and nothing to
// traverse out of. CLAUDE_CONFIG_DIR still moves it, which is Claude Code's own
// rule for where user settings live.
const settingsFile = () => path.join(configDir(), 'settings.json');

// ------------------------------------------------------------------- tools

// The tools this editor can point at another endpoint. Claude Code is the only one
// with a full env editor: its settings file is JSON, and the env block is exactly
// what decides where requests go. The other three need the same three values —
// endpoint, token, model — so they get the same three fields rather than a
// hand-rolled editor for a config format this project does not own.
//
// `mode` is the whole difference. 'env' round-trips the parsed document; 'simple'
// patches only the keys below and leaves every other byte of the file alone.
const TOOLS = [
  { id: 'claude', name: 'Claude Code', mode: 'env' },
  { id: 'codex', name: 'Codex', mode: 'simple' },
  { id: 'opencode', name: 'OpenCode', mode: 'simple' },
  { id: 'hermes', name: 'Hermes Agent', mode: 'simple' },
];

const toolById = id => TOOLS.find(t => t.id === id) || null;

// Every path is derived here, server-side. The browser names a tool and never a
// file, so there is still no path arriving from the client to validate or traverse.
function toolPaths(id) {
  const home = os.homedir();
  if (id === 'claude') return { file: path.join(configDir(), 'settings.json') };
  if (id === 'codex') return { file: path.join(home, '.codex', 'config.toml') };
  if (id === 'opencode') return { file: path.join(home, '.config', 'opencode', 'opencode.json') };
  if (id === 'hermes') return { file: path.join(home, '.hermes', 'config.yaml'), envFile: path.join(home, '.hermes', '.env') };
  throw Object.assign(new Error(`unknown tool: ${id}`), { status: 400 });
}

// The provider id these tools get pointed at. Kept as 9router rather than something
// neutral so a config another 9router install already wrote is edited in place
// instead of gaining a second, competing provider entry.
const PROVIDER = '9router';
const PROVIDER_LABEL = '9Router';

// What the landing screen reports for a tool: the one file it will edit, whether it
// is there, and enough context to shorten the path for display.
function scanInfo(tool) {
  const { file } = toolPaths(tool.id);
  let st = null;
  try { st = fs.statSync(file); } catch { /* absent is the normal first-run case */ }
  return {
    tool: tool.id,
    found: !!st,
    file,
    size: st ? st.size : 0,
    mtime: st ? st.mtimeMs : null,
    configDir: configDir(),
    home: os.homedir(),
    platform: process.platform,
  };
}

// ---------------------------------------------------------------- read / write

function readSettings(file) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }

  if (raw === null) {
    return { file, exists: false, raw: '', parsed: {}, eol: '\n', mtimeMs: 0, normalized: false, parseError: null };
  }

  const st = fs.statSync(file);
  const eol = detectEol(raw);
  try {
    const parsed = JSON.parse(raw);
    // Round-trip is semantic, not byte-level. If re-serialising would change the
    // file, say so — a silent reformat beats a silent key drop, but visible beats both.
    const canonical = JSON.stringify(parsed, null, 2).replace(/\n/g, eol) + eol;
    return { file, exists: true, raw, parsed, eol, mtimeMs: st.mtimeMs, normalized: canonical !== raw, parseError: null };
  } catch (e) {
    // Broken file is a supported state: hand back the raw text so the UI can say so.
    return { file, exists: true, raw, parsed: null, eol, mtimeMs: st.mtimeMs, normalized: false, parseError: e.message };
  }
}

// Keep the last few versions of whatever we are about to overwrite. Claude Code
// does the same for ~/.claude.json, and this editor has no undo: a save built from
// a stale or wrong document is otherwise unrecoverable. Cheap insurance.
const BACKUPS = 5;
// Monotonic within this process: two saves inside the same millisecond must not
// share one name, and the names must still sort oldest-first for pruning.
let backupSeq = 0;
function backupBeforeWrite(file) {
  if (!fs.existsSync(file)) return null;
  const dir = path.join(path.dirname(file), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}.${String(process.pid).padStart(6, '0')}.${String(backupSeq++).padStart(6, '0')}`;
  const dest = path.join(dir, `${path.basename(file)}.backup.${stamp}`);
  fs.copyFileSync(file, dest);
  // Prune oldest first. Names sort lexicographically by timestamp, which is also
  // chronological — Date.now() is fixed-width until the year 2286, pid and seq are
  // zero-padded so the sort holds across processes and same-millisecond saves.
  const mine = fs.readdirSync(dir)
    .filter(f => f.startsWith(`${path.basename(file)}.backup.`))
    .sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS))) {
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* already gone */ }
  }
  return dest;
}

// Synchronous sleep. renameSync has no retry option, so back off by hand.
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// tmp sits beside the target so rename stays same-device (atomic on Windows + POSIX).
// The Claude Code file watcher can read a half-written file, so this is correctness, not caution.
// Random suffix: two saves in the same process must not share one tmp name.
function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows can hold the target briefly (antivirus, another writer). Back off, then give up.
      if (attempt >= 3) {
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw e;
      }
      sleep(100 * (attempt + 1));
    }
  }
}

// ------------------------------------------------------- simple-mode formats

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// The three tools below each own a config format with a real parser (TOML, YAML,
// JSONC). This project has no npm dependency and is not going to grow one for
// three files, so each format is handled with the narrowest possible text surgery:
// only the keys this editor owns are ever matched or replaced, and every other
// byte of the file is carried through untouched. The trade is that an exotic
// hand-written config — a multi-line TOML string, a model: block nested inside
// another key — may not be read back correctly. It is still never clobbered: a
// value that cannot be parsed reads as empty, and an empty field is not written.

// These tools all want a base URL that ends in /v1, and adding a second one is the
// classic failure. Same rule as the model-list URL: normalise, never append blindly.
// ponytail: trailing slash is stripped before the /v1 check, so 'http://h/v1/' stays
// 'http://h/v1' instead of growing into 'http://h/v1/v1'.
const withV1 = base => {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/v1') ? b : `${b}/v1`;
};

const tomlString = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const tomlUnquote = v => v.replace(/\\(["\\])/g, '$1');

// A top-level `key = "value"` in a TOML file, ignoring anything inside a [section].
function tomlTopValue(text, key) {
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) { section = head[1]; continue; }
    if (section) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`).exec(line);
    if (m) return tomlUnquote(m[1]);
  }
  return '';
}

// Every `key = "value"` inside one [section], stopping at the next section header.
function tomlSectionValues(text, section) {
  const out = {};
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) { inside = head[1] === section; continue; }
    if (!inside) continue;
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m) out[m[1]] = tomlUnquote(m[2]);
  }
  return out;
}

// Replace a top-level `key = "value"` in place, or insert it above the first
// section. Returns the text unchanged when the value is empty — clearing a key
// this editor owns is not worth a special case, and a blank line is worse than a
// stale one.
function tomlSetTop(text, key, value) {
  const line = `${key} = ${tomlString(value)}`;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*".*"\\s*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const firstSection = text.search(/^\s*\[/m);
  if (firstSection === -1) return `${text.replace(/\s*$/, '')}\n${line}\n`;
  const at = text.lastIndexOf('\n', firstSection) + 1;
  return `${text.slice(0, at)}${line}\n${text.slice(at)}`;
}

// Replace one whole [section] with `body` (which must start with its own header),
// or append it when the file has none. Everything outside the section is kept.
function tomlSetSection(text, section, body) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${section.replace(/\./g, '\\.')}\\]`).test(l));
  if (start === -1) {
    const head = text.replace(/\s*$/, '');
    return `${head ? `${head}\n\n` : ''}${body.replace(/\s*$/, '')}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  // Swallow the blank line that separated the old section from the next one.
  while (end < lines.length && lines[end].trim() === '') end++;
  const head = lines.slice(0, start).join('\n').replace(/\s*$/, '');
  const tail = lines.slice(end).join('\n').replace(/^\s*/, '');
  return `${head ? `${head}\n\n` : ''}${body.replace(/\s*$/, '')}\n${tail ? `\n${tail}` : ''}`;
}

// Codex CLI: ~/.codex/config.toml. The key travels in the provider block, because
// a custom provider ignores auth.json — a key placed there is simply not read.
function codexRead(text) {
  const src = text || '';
  const prov = tomlSectionValues(src, `model_providers.${PROVIDER}`);
  return {
    baseUrl: prov.base_url || '',
    apiKey: prov.experimental_bearer_token || prov.api_key || '',
    model: tomlTopValue(src, 'model'),
  };
}

function codexWrite(text, v) {
  let out = text || '';
  out = tomlSetTop(out, 'model_provider', PROVIDER);
  if (v.model) out = tomlSetTop(out, 'model', v.model);
  const lines = [
    `[model_providers.${PROVIDER}]`,
    `name = ${tomlString(PROVIDER_LABEL)}`,
    `base_url = ${tomlString(withV1(v.baseUrl))}`,
    'wire_api = "responses"',
  ];
  if (v.apiKey) lines.push(`experimental_bearer_token = ${tomlString(v.apiKey)}`);
  return tomlSetSection(out, `model_providers.${PROVIDER}`, lines.join('\n'));
}

// OpenCode: ~/.config/opencode/opencode.json. JSONC in the wild, so trailing
// commas are stripped before parsing — the same tolerance 9router has.
function jsoncParse(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

function opencodeRead(text) {
  let cfg;
  try { cfg = jsoncParse(text || '{}'); } catch { return { baseUrl: '', apiKey: '', model: '', broken: true }; }
  const p = cfg?.provider?.[PROVIDER];
  const model = typeof cfg?.model === 'string' && cfg.model.startsWith(`${PROVIDER}/`)
    ? cfg.model.slice(PROVIDER.length + 1) : '';
  return { baseUrl: p?.options?.baseURL || '', apiKey: p?.options?.apiKey || '', model };
}

function opencodeWrite(text, v) {
  const cfg = jsoncParse(text || '{}');
  if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};
  // An existing entry keeps its model list; this editor only owns the three values.
  const p = cfg.provider[PROVIDER] || { npm: '@ai-sdk/openai-compatible', name: PROVIDER_LABEL, models: {} };
  p.options = { ...(p.options || {}), baseURL: withV1(v.baseUrl) };
  if (v.apiKey) p.options.apiKey = v.apiKey;
  if (!p.models || typeof p.models !== 'object') p.models = {};
  if (v.model) p.models[v.model] = { name: v.model };
  cfg.provider[PROVIDER] = p;
  if (v.model) cfg.model = `${PROVIDER}/${v.model}`;
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

// Hermes: ~/.hermes/config.yaml holds a top-level `model:` block, and the key lives
// in ~/.hermes/.env as OPENAI_API_KEY — the block references it as ${OPENAI_API_KEY}.
const HERMES_MODEL_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;

function hermesRead(text) {
  const m = HERMES_MODEL_RE.exec(text || '');
  if (!m) return { baseUrl: '', apiKey: '', model: '' };
  const body = m[1] || '';
  const get = key => {
    const hit = new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, 'm').exec(body);
    return hit ? hit[1].trim() : '';
  };
  return { baseUrl: get('base_url'), apiKey: '', model: get('default') };
}

function hermesWrite(text, v) {
  const block = `model:\n  default: ${JSON.stringify(v.model)}\n  provider: "custom"\n`
    + `  base_url: ${JSON.stringify(withV1(v.baseUrl))}\n  api_key: \${OPENAI_API_KEY}\n`;
  const out = text || '';
  const m = HERMES_MODEL_RE.exec(out);
  if (!m) return out.length > 0 ? `${block}\n${out}` : block;
  // The pattern's trailing blank-line arm is greedy, so it swallows the empty line
  // that separated the old block from whatever follows. That is still valid YAML,
  // but it reflows a file this editor does not own — so the separator goes back
  // whenever there is a next key to separate from.
  const head = out.slice(0, m.index);
  const rest = out.slice(m.index + m[0].length);
  return `${head}${block}${rest ? `\n${rest}` : ''}`;
}

// Upsert/remove a single KEY=VALUE line in a .env file.
function envVarSet(text, key, value) {
  const src = text || '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(src)) return src.replace(re, line);
  return src.length > 0 && !src.endsWith('\n') ? `${src}\n${line}\n` : `${src}${line}\n`;
}

// One shape for both modes: what to show in the form, and what a save would write.
// Hermes' key lives in .env, not in the YAML, so it is read from there — but the
// field is handed back empty on purpose: a secret does not belong on a page, and
// an empty field means "leave the stored key alone" rather than "erase it".
function readSimple(tool, paths) {
  const raw = readText(paths.file);
  if (tool.id === 'codex') return { values: codexRead(raw), exists: raw !== null, parseError: null };
  if (tool.id === 'opencode') {
    const v = opencodeRead(raw);
    return { values: v, exists: raw !== null, parseError: v.broken ? 'this file is not valid JSON' : null };
  }
  return { values: hermesRead(raw), exists: raw !== null, parseError: null };
}

function writeSimple(tool, paths, values) {
  const raw = readText(paths.file) || '';
  if (tool.id === 'opencode') {
    try { jsoncParse(raw || '{}'); } catch (e) { throw Object.assign(new Error(`existing opencode.json is not valid JSON: ${e.message}`), { status: 409 }); }
  }
  const text = tool.id === 'codex' ? codexWrite(raw, values)
    : tool.id === 'opencode' ? opencodeWrite(raw, values)
    : hermesWrite(raw, values);
  atomicWrite(paths.file, text);
  // Hermes reads its key from .env, and only there. Blank means "leave the key be".
  if (tool.id === 'hermes' && values.apiKey) {
    atomicWrite(paths.envFile, envVarSet(readText(paths.envFile) || '', 'OPENAI_API_KEY', values.apiKey));
  }
  return text;
}

// ---------------------------------------------------------------- http helpers

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
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
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

// Where the model list lives, given a configured base URL. A base that already
// ends in /v1 must not become /v1/v1/models. One rule covers every tool here:
// Anthropic and the OpenAI-compatible ones all serve the list at <base>/v1/models.
// Throws on a URL that will not parse.
function modelsUrl(base) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const u = new URL(root);
  return new URL(/\/v1\/?$/.test(u.pathname) ? 'models' : 'v1/models', root);
}

// Quote a value as a PowerShell single-quoted string. Single quotes are literal
// in PowerShell, so doubling any embedded quote is the whole escaping rule — a
// path with an apostrophe (C:\Users\O'Brien) would otherwise break the command.
const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;

// ------------------------------------------------------------------ shortcut

// A .lnk to `node server.js` would flash a console window for as long as the
// editor is open, because node is a console program. A .vbs run by wscript.exe is
// a GUI program, so nothing flashes — it starts node hidden and opens the browser.
// VBScript is deprecated but wscript.exe ships on every Windows and this is the
// one launcher that needs no shortcut binary and no extra dependency.
//
// ASCII only, on purpose: wscript.exe reads a .vbs as ANSI, so a UTF-8 em-dash
// would arrive as three garbage bytes. Comments are still parsed text.
function vbsLauncher(port) {
  return [
    'Option Explicit',
    "' CONFIG READER - starts the server hidden, then opens the browser.",
    "' Run it again while the editor is open and it just opens the tab.",
    'Dim sh, fso, here, node',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'here = fso.GetParentFolderName(WScript.ScriptFullName)',
    'node = "node.exe"',
    'If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe") Then',
    '  node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe"',
    'End If',
    `sh.CurrentDirectory = here`,
    // One wrapping pair of quotes around each path, and no quotes stored in the
    // variables — the Run line below adds exactly one pair to each.
    `sh.Run """" & node & """ """ & here & "\\server.js"" --port ${port} --open", 0, False`,
    '',
  ].join('\r\n');
}

// The .lnk itself. The WScript.Shell COM object that writes it is a Windows
// feature, so this whole function is Windows-only by construction — and the
// PowerShell that calls it is left as text so nothing here needs to escape it.
function installShortcutWindows(dir, port, name, vbs) {
  const lnk = path.join(dir, `${name}.lnk`);
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut(${psQuote(lnk)})`,
    `$s.TargetPath = ${psQuote(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'))}`,
    `$s.Arguments = ${psQuote(`"${vbs}"`)}`,
    `$s.WorkingDirectory = ${psQuote(HERE)}`,
    `$s.Description = ${psQuote('CONFIG READER')}`,
    '$s.Save()',
  ].join('; ');
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `powershell exited ${r.status}`);
  if (!fs.existsSync(lnk)) throw new Error('the shortcut was not created');
  return lnk;
}

// A .desktop file is the Linux equivalent and needs no COM. `chmod +x` plus
// gio's trusted flag is what stops the desktop from opening it in a text editor.
function installShortcutLinux(dir, port, name) {
  const file = path.join(dir, `${name}.desktop`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=CONFIG READER',
    'Comment=Edit the env block of ~/.claude/settings.json',
    `Exec=node ${path.join(HERE, 'server.js')} --port ${port} --open`,
    `Path=${HERE}`,
    'Terminal=false',
    'Icon=utilities-terminal',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  try {
    spawnSync('gio', ['set', file, 'metadata::trusted', 'true'], { windowsHide: true });
  } catch { /* gio is optional; the file still works when launched from a file manager */ }
  return file;
}

// --dir, or null for "use the platform default". A relative path is relative to
// the editor's folder, so `--dir .` and a USB path both behave predictably.
const resolveDirArg = raw => (raw ? path.resolve(HERE, raw) : null);

// Where the Desktop really is. The registry is the only authoritative answer:
// OneDrive and corporate folder redirection both move it, and ~/Desktop may still
// exist as a stale leftover — so probing that first is how a shortcut ends up in a
// folder the user never sees. Falls back only if the registry says nothing useful.
function desktopDirWin() {
  const r = spawnSync('reg', ['query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '/v', 'Desktop'], { encoding: 'utf8', windowsHide: true });
  const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(r.stdout || '');
  if (m) {
    // The value is usually REG_EXPAND_SZ: %USERPROFILE%\Desktop or %OneDrive%\Desktop.
    const p = m[1].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
    if (fs.existsSync(p)) return p;
  }
  for (const d of [path.join(process.env.OneDrive || '', 'Desktop'), path.join(os.homedir(), 'Desktop')]) {
    if (d && fs.existsSync(d)) return d;
  }
  return null;
}

// Where the shortcut goes. Windows gets a desktop .lnk; Linux gets the .desktop
// file in the applications dir. macOS would need an .app bundle, so it is told
// so rather than given a broken file. No home directory anywhere -> the launcher
// is still written, and the user is told where it is.
function installShortcut(port, name = 'CONFIG READER', dirOverride = null) {
  const vbs = path.join(HERE, 'launch.vbs');
  let dir = null, file = null, note = '';
  if (process.platform === 'win32') {
    fs.writeFileSync(vbs, vbsLauncher(port));
    dir = dirOverride || desktopDirWin();
    if (!dir) note = 'no Desktop folder found — launcher written instead';
    else {
      fs.mkdirSync(dir, { recursive: true });
      file = installShortcutWindows(dir, port, name, vbs);
    }
  } else if (process.platform === 'linux') {
    dir = dirOverride || path.join(os.homedir(), '.local', 'share', 'applications');
    file = installShortcutLinux(dir, port, name);
    note = 'also available from the application menu';
  } else {
    note = 'macOS needs an .app bundle; not written. The launcher is at ' + vbs;
  }
  return { file: file || vbs, dir, vbs, note };
}

// The context window each model advertises, by id. Claude Code assumes 200K unless
// the model name carries a trailing [1m], so the editor needs this to decide whether
// to add that marker on assign. Two shapes are in the wild — a flat context_length
// and a nested capabilities.contextWindow — and some entries carry neither, which is
// why a missing window is left out rather than guessed at.
function modelWindows(rows) {
  const out = {};
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name || m.model;
    const w = m.context_length || (m.capabilities && m.capabilities.contextWindow);
    if (typeof id === 'string' && id && Number.isFinite(w) && w > 0) out[id] = w;
  }
  return out;
}

// Whether each model takes image input, by id. Same honesty rule as windows:
// only explicit capability fields count — a missing signal is left out rather
// than guessed from the model name, so the card shows no vision badge for it.
// Three shapes are in the wild (OpenRouter-style gateways send the latter two):
//   a boolean flag (vision / supports_vision / capabilities.vision / ...),
//   a modality list (modalities / input_modalities / architecture.input_modalities),
//   a modality string ("text+image->text" in architecture.modality).
const VISION_TRUE_TOKENS = new Set(['image', 'images', 'vision', 'visual']);

// A modality value (array or string) as true/false/undefined. Names an image
// modality -> vision; a non-empty value naming none -> text-only. Anything else
// (absent, empty, non-strings) is unknown, not a no.
function visionFromModalities(v) {
  const toks = Array.isArray(v)
    ? v.filter(x => typeof x === 'string').map(x => x.toLowerCase())
    : typeof v === 'string' && v
      ? v.toLowerCase().split(/[^a-z]+/).filter(Boolean)
      : [];
  if (!toks.length) return undefined;
  return toks.some(t => VISION_TRUE_TOKENS.has(t));
}

const VISION_BOOL_KEYS = ['vision', 'supports_vision', 'supportsVision', 'supports_image',
  'supportsImage', 'image_input', 'supports_image_input', 'multimodal', 'has_vision', 'is_vision'];
const VISION_MOD_KEYS = ['modalities', 'modality', 'input_modalities', 'inputModalities',
  'supported_modalities', 'supportedModalities'];

function rowVision(m) {
  if (!m || typeof m !== 'object') return undefined;
  const scopes = [m, m.capabilities, m.architecture, m.info].filter(s => s && typeof s === 'object');
  for (const s of scopes) {
    for (const k of VISION_BOOL_KEYS) {
      if (typeof s[k] === 'boolean') return s[k];
    }
  }
  for (const s of scopes) {
    for (const k of VISION_MOD_KEYS) {
      if (k in s) {
        const r = visionFromModalities(s[k]);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

function modelVision(rows) {
  const out = {};
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name || m.model;
    const v = rowVision(m);
    if (typeof id === 'string' && id && typeof v === 'boolean') out[id] = v;
  }
  return out;
}

// ------------------------------------------------------------------- selftest

function selftest() {
  const checks = [];
  const ok = (name, pass, detail = '') => checks.push({ name, pass, detail });

  // 1. round-trip the real file, if there is one
  const target = toolPaths('claude').file;
  const s = readSettings(target);
  if (s.exists && !s.parseError) {
    const again = JSON.parse(JSON.stringify(s.parsed, null, 2));
    ok('round-trip deep-equal', JSON.stringify(again) === JSON.stringify(s.parsed));
    ok('key order preserved', Object.keys(again).join() === Object.keys(s.parsed).join());
  } else {
    ok('round-trip deep-equal', true, 'no settings.json on this machine — skipped');
  }

  // 2. an unknown key must survive a round-trip. This is requirement #1.
  const probe = { ...(s.parsed || {}), __probe: { a: 1, nested: [1, 'x'] } };
  const back = JSON.parse(JSON.stringify(probe, null, 2));
  ok('unknown key survives', JSON.stringify(back.__probe) === JSON.stringify({ a: 1, nested: [1, 'x'] }));

  // 3. atomic write leaves no .tmp behind
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-'));
  const probeFile = path.join(dir, 'probe.json');
  atomicWrite(probeFile, '{"ok":true}');
  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  ok('atomic write, no .tmp left', leftovers.length === 0 && fs.readFileSync(probeFile, 'utf8') === '{"ok":true}', leftovers.join());
  fs.rmSync(dir, { recursive: true, force: true });

  // 4. CLAUDE_CONFIG_DIR is honoured
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const fakeDir = path.join(os.tmpdir(), 'csui-cfg');
  process.env.CLAUDE_CONFIG_DIR = fakeDir;
  const after = configDir();
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  ok('CLAUDE_CONFIG_DIR honoured', after === fakeDir && configDir() === (saved || path.join(os.homedir(), '.claude')));

  // 4b. the scan finds ~/.claude/settings.json on all three platforms. Two things
  // make that work, and each is checked separately because they fail differently:
  //   (a) os.homedir() reads the env var that platform actually uses
  //   (b) path.join picks the host separator, so the path is well-formed per OS
  // (b) cannot be simulated on Windows with the host `path` module — path.join is
  // host-flavoured by design — so it is checked against each platform's own flavour.
  const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

  // (a) the real os.homedir(), on this machine, follows this platform's variable
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env[homeVar] = process.platform === 'win32' ? 'C:\\fake\\win' : '/fake/posix';
  ok(`${process.platform}: os.homedir() follows ${homeVar}`, os.homedir() === process.env[homeVar], os.homedir());
  ok(`${process.platform}: settingsFile() lands in that home`,
    toolPaths('claude').file === path.join(process.env[homeVar], '.claude', 'settings.json'), toolPaths('claude').file);

  // (b) the composition is well-formed under every platform's separator rules
  for (const [plat, flavour, fakeHome, expected] of [
    ['win32', path.win32, 'C:\\Users\\nozell', 'C:\\Users\\nozell\\.claude\\settings.json'],
    ['darwin', path.posix, '/Users/nozell', '/Users/nozell/.claude/settings.json'],
    ['linux', path.posix, '/home/nozell', '/home/nozell/.claude/settings.json'],
  ]) {
    const composed = flavour.join(fakeHome, '.claude', 'settings.json');
    ok(`${plat}: path composes as ${expected}`, composed === expected, composed);
    ok(`${plat}: composed path is absolute`, flavour.isAbsolute(composed), composed);
  }

  // CLAUDE_CONFIG_DIR wins over the home dir on every platform.
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'csui-elsewhere');
  const overridden = toolPaths('claude').file;
  ok('CLAUDE_CONFIG_DIR overrides home everywhere',
    overridden === path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), overridden);
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
  for (const [k, v] of Object.entries(savedHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  ok('home env restored after the simulation',
    (savedHome[homeVar] || '') === (process.env[homeVar] || ''), `${homeVar}=${process.env[homeVar]}`);

  // 4c. nothing platform-specific is hardcoded in the path logic. A Windows-only
  // string here would silently break macOS and Linux. Only the runtime half of the
  // file is scanned — this selftest legitimately contains platform literals.
  const src = fs.readFileSync(__filename, 'utf8');
  const runtime = src.slice(0, src.indexOf('function selftest'));
  const pathLines = runtime.split('\n').filter(l => /toolPaths|configDir\s*=/.test(l) && !l.trim().startsWith('//'));
  ok('no hardcoded Windows path in the settings path logic',
    !pathLines.some(l => /ProgramData|AppData|[A-Z]:\\/.test(l)), `${pathLines.length} lines checked`);

  // 5. app.ts strips to something the browser can actually parse
  try {
    const js = appJs();
    new Function(js);
    ok('app.ts strips to valid JS', js.length > 1000, `${js.length} bytes`);
    ok('types are gone from the output', !/\binterface Field\b/.test(js));
  } catch (e) {
    ok('app.ts strips to valid JS', false, e.message);
  }

  // 6. EOL is detected per file, not assumed from the platform. Claude Code writes
  // LF even on Windows; assuming CRLF there would reformat every save.
  ok('detectEol LF', detectEol('{\n  "a": 1\n}\n') === '\n');
  ok('detectEol CRLF', detectEol('{\r\n  "a": 1\r\n}\r\n') === '\r\n');

  // 7. a real file survives a load -> write -> load cycle byte-for-byte
  if (s.exists && !s.parseError) {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-rt-'));
    const rt = path.join(dir2, 'settings.json');
    fs.writeFileSync(rt, s.raw);
    const before = fs.readFileSync(rt, 'utf8');
    atomicWrite(rt, JSON.stringify(JSON.parse(before), null, 2).replace(/\n/g, detectEol(before)) + detectEol(before));
    const after = fs.readFileSync(rt, 'utf8');
    ok('real file byte-identical after rewrite', before === after, before === after ? '' : `${before.length} -> ${after.length} bytes`);
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // 8. the scan reports the one file and whether it is there. There is no path
  // input to validate any more — the browser never names a file.
  const scan = scanInfo(toolById('claude'));
  ok('scan names an absolute settings path', path.isAbsolute(scan.file), scan.file);
  ok('scan path is the config dir settings.json', scan.file === path.join(configDir(), 'settings.json'));
  ok('scan reports existence as a boolean', typeof scan.found === 'boolean');
  ok('scan found agrees with the filesystem', scan.found === fs.existsSync(scan.file));
  ok('scan reports home for path shortening', scan.home === os.homedir());

  // 8b. every tool resolves to a path under the user's home, and no two tools share
  // one. A registry entry that named the wrong file would silently edit the wrong
  // config, so the shape is checked rather than each path by hand.
  ok('every tool has a path', TOOLS.every(t => {
    try { return path.isAbsolute(toolPaths(t.id).file); } catch { return false; }
  }), TOOLS.map(t => toolPaths(t.id).file).join(' | '));
  ok('tool paths are all distinct', new Set(TOOLS.map(t => toolPaths(t.id).file)).size === TOOLS.length);
  // Case is folded only for this comparison: the paths all come from os.homedir(),
  // so they agree on case by construction and the check is about containment.
  ok('every tool path sits under the home dir',
    TOOLS.every(t => toolPaths(t.id).file.toLowerCase().startsWith(os.homedir().toLowerCase())),
    TOOLS.map(t => toolPaths(t.id).file).join(' | '));
  ok('an unknown tool is refused', (() => { try { toolPaths('nope'); return false; } catch { return true; } })());
  ok('claude is the full env editor, the rest are simple',
    toolById('claude').mode === 'env' && TOOLS.filter(t => t.mode === 'simple').length === 3,
    TOOLS.map(t => `${t.id}:${t.mode}`).join());
  // The picker draws /icon/<id>.png for every tool, so a missing file is a broken
  // card. Checked here rather than at request time, which would only 404 in a browser.
  ok('every tool has an icon', TOOLS.every(t => fs.existsSync(path.join(ICONS, `${t.id}.png`))),
    TOOLS.map(t => `${t.id}:${fs.existsSync(path.join(ICONS, `${t.id}.png`))}`).join(' '));

  // 9. the /v1/models URL is composed from the base, and a base that already ends
  // in /v1 must not grow a second one. This is the one bit of the model-list
  // feature that is pure logic, so it is the one bit worth a check.
  for (const [base, expected] of [
    ['http://localhost:20128', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/v1', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/v1/', 'http://localhost:20128/v1/models'],
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/models'],
    ['http://host/openai/v1', 'http://host/openai/v1/models'],
  ]) {
    let got = '';
    try { got = modelsUrl(base).href; } catch (e) { got = e.message; }
    ok(`models URL for ${base}`, got === expected, got);
  }
  // The other three tools speak the OpenAI shape, but the rule is the same one: the
  // list sits at <base>/v1/models whether or not the base already carried the /v1.
  for (const [base, expected] of [
    ['http://localhost:20128', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/v1', 'http://localhost:20128/v1/models'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/models'],
  ]) {
    let got = '';
    try { got = modelsUrl(base).href; } catch (e) { got = e.message; }
    ok(`openai-shape models URL for ${base}`, got === expected, got);
  }
  let threw = false;
  try { modelsUrl('not a url'); } catch { threw = true; }
  ok('a non-URL base throws instead of fetching', threw);

  // 9b. the context window each model advertises. The editor turns this into the
  // [1m] suffix Claude Code needs, so reading it wrong means telling Claude Code a
  // model has a 1M window when it does not — or missing one that does.
  const probeRows = [
    { id: 'flat', context_length: 1000000 },
    { id: 'nested', capabilities: { contextWindow: 200000 } },
    { id: 'both', context_length: 1000000, capabilities: { contextWindow: 200000 } },
    { id: 'neither' },
    { id: 'byname', name: 'named-model', context_length: 262144 },
    { name: 'name-only', context_length: 500000 },
    { id: 'zero', context_length: 0 },
    { id: 'junk', context_length: 'lots' },
    null,
    'a bare string row',
  ];
  const wins = modelWindows(probeRows);
  ok('a flat context_length is read', wins.flat === 1000000, String(wins.flat));
  ok('a nested capabilities.contextWindow is read', wins.nested === 200000, String(wins.nested));
  ok('context_length wins when both are present', wins.both === 1000000, String(wins.both));
  ok('a model with no window is left out, not guessed', !('neither' in wins));
  ok('id wins over name when both are present', wins.byname === 262144, String(wins.byname));
  ok('a row with only a name still contributes', wins['name-only'] === 500000, String(wins['name-only']));
  ok('a row with no usable id is skipped', Object.keys(wins).length === 5, Object.keys(wins).join());
  ok('a zero window is not recorded', !('zero' in wins));
  ok('a non-numeric window is not recorded', !('junk' in wins));
  ok('null and string rows are skipped without throwing', !('null' in wins));

  // 9c. vision support per model. Same honesty rule as windows: only an explicit
  // capability field counts — a missing signal is left out rather than guessed,
  // so the card shows no vision badge for it instead of a wrong one.
  const visionRows = [
    { id: 'flag', vision: true },
    { id: 'noflag', vision: false },
    { id: 'alt', supports_vision: true },
    { id: 'cap', capabilities: { vision: true } },
    { id: 'arch', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'str', architecture: { modality: 'text+image->text' } },
    { id: 'textonly', modalities: ['text'] },
    { id: 'empty', modalities: [] },
    { id: 'neither' },
    { id: 'junk', vision: 'yes' },
    null,
  ];
  const vis = modelVision(visionRows);
  ok('a vision flag is read', vis.flag === true, String(vis.flag));
  ok('an explicit false is kept, not dropped', vis.noflag === false, String(vis.noflag));
  ok('an alternate flag key is read', vis.alt === true, String(vis.alt));
  ok('a nested capabilities flag is read', vis.cap === true, String(vis.cap));
  ok('a modality list naming image is vision', vis.arch === true, String(vis.arch));
  ok('a modality string naming image is vision', vis.str === true, String(vis.str));
  ok('a text-only modality list is not vision', vis.textonly === false, String(vis.textonly));
  ok('an empty modality list is unknown, not a no', !('empty' in vis));
  ok('a model with no signal is left out, not guessed', !('neither' in vis));
  ok('a non-boolean flag is not recorded', !('junk' in vis));
  ok('vision map holds exactly the explicit reports', Object.keys(vis).length === 7, Object.keys(vis).join());

  // 12. the double-click launcher. The .lnk is written by PowerShell and cannot be
  // checked from here, but the launcher it points at can: it must start node
  // hidden (0) and open the browser (--open), from the editor's own folder.
  const vbs = vbsLauncher(8787);
  ok('the launcher starts node hidden', /sh\.Run .*, 0, False/.test(vbs));
  ok('the launcher passes --open', vbs.includes('--port 8787 --open'));
  ok('the launcher sets its working directory to the editor',
    vbs.includes('sh.CurrentDirectory = here'), vbs.match(/sh\.CurrentDirectory.*/)?.[0]);
  ok('the launcher resolves node without a hardcoded drive',
    !/[A-Z]:\\\\/.test(vbs) && vbs.includes('%ProgramFiles%'));
  ok('the launcher is CRLF-terminated for wscript', vbs.endsWith('\r\n'));
  // The Run line is the one place quoting happens. An earlier version stored quotes
  // inside the node variable *and* added a pair here, so the command line reached
  // wscript with doubled quotes and died with "cannot find the file specified".
  // The exact line is asserted because the failure is invisible until launch.
  ok('the Run line quotes each path exactly once',
    vbs.includes('sh.Run """" & node & """ """ & here & "\\server.js"" --port 8787 --open", 0, False'),
    vbs.split('\r\n').find(l => l.startsWith('sh.Run')));
  ok('the node variable stores no quotes of its own',
    vbs.includes('node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe"'));

  // wscript reads a .vbs as ANSI. A non-ASCII byte in a comment is still bytes it
  // has to parse, so the whole file stays ASCII.
  ok('the launcher is pure ASCII for wscript', /^[\x00-\x7F]*$/.test(vbs),
    [...vbs].filter(c => c.charCodeAt(0) > 127).join('') || 'all ASCII');

  // 13. PowerShell string quoting. A path with an apostrophe is legal on Windows
  // and would otherwise truncate the -Command and create nothing.
  ok('psQuote wraps in single quotes', psQuote('C:\\x\\y.lnk') === `'C:\\x\\y.lnk'`);
  ok('psQuote doubles an embedded apostrophe',
    psQuote("C:\\Users\\O'Brien\\s.lnk") === `'C:\\Users\\O''Brien\\s.lnk'`,
    psQuote("C:\\Users\\O'Brien\\s.lnk"));

  // 14. the Desktop the shortcut lands in. On Windows the registry is the only
  // authoritative answer — a OneDrive-redirected Desktop is where the user actually
  // looks, while ~/Desktop can still exist as a stale folder. That stale folder is
  // exactly how the first attempt put the .lnk somewhere invisible.
  if (process.platform === 'win32') {
    const d = desktopDirWin();
    ok('desktopDirWin returns an existing folder', !!d && fs.existsSync(d), d || '(none)');
    ok('desktopDirWin returns an absolute path', !!d && path.isAbsolute(d), d || '(none)');
    const reg = spawnSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', 'Desktop'], { encoding: 'utf8', windowsHide: true });
    const raw = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(reg.stdout || '');
    if (raw) {
      const want = raw[1].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
      ok('desktopDirWin agrees with the registry, not ~/Desktop', d === want, `got ${d}, registry ${want}`);
      // The whole point of the fix: when they differ, the registry wins.
      const stale = path.join(os.homedir(), 'Desktop');
      if (fs.existsSync(stale) && stale !== want) {
        ok('a stale ~/Desktop does not win over the redirected one', d !== stale,
          `registry ${want}, stale ${stale}`);
      }
    }
  }

  // 10. the backup rotation keeps the last N and prunes older ones. This is the
  // only undo this editor has, so it gets a check.
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-bak-'));
  const bfile = path.join(bdir, 'settings.json');
  fs.writeFileSync(bfile, '{"v":0}');
  for (let v = 1; v <= BACKUPS + 3; v++) {
    backupBeforeWrite(bfile);
    fs.writeFileSync(bfile, `{"v":${v}}`);
  }
  const kept = fs.readdirSync(path.join(bdir, 'backups')).sort();
  ok(`backup rotation keeps ${BACKUPS}`, kept.length === BACKUPS, `${kept.length} kept`);
  ok('backup names are prefixed by the file', kept.every(f => f.startsWith('settings.json.backup.')));
  // The newest backup must hold the version just before the current file.
  const newest = fs.readFileSync(path.join(bdir, 'backups', kept[kept.length - 1]), 'utf8');
  ok('newest backup is the previous version', newest === `{"v":${BACKUPS + 2}}`, newest);
  fs.rmSync(bdir, { recursive: true, force: true });

  // 11. the "did it actually change?" predicate the save path uses. A no-op save
  // must not consume a backup slot, and the comparison is on the serialised bytes,
  // so it has to be true for an already-canonical file and false once a value moves.
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-noop-'));
  const cfile = path.join(cdir, 'settings.json');
  const canonical = '{\n  "env": {\n    "A": "1"\n  }\n}\n';
  fs.writeFileSync(cfile, canonical);
  const cur = readSettings(cfile);
  const reserialise = d => JSON.stringify(d, null, 2).replace(/\n/g, cur.eol) + cur.eol;
  ok('canonical file compares equal (no backup)', cur.raw === reserialise(cur.parsed));
  ok('a changed value compares unequal (backup)', cur.raw !== reserialise({ env: { A: '2' } }));
  fs.rmSync(cdir, { recursive: true, force: true });

  // 15. --dir places the shortcut wherever it is asked to. The public desktop is
  // the case that needs it: the icon there shows up for every account on the
  // machine, so it is a deliberate choice rather than a fallback. A relative path
  // must resolve against the editor's own folder, not the caller's working dir.
  ok('a relative --dir resolves against the editor folder',
    resolveDirArg('sub') === path.join(HERE, 'sub'), resolveDirArg('sub'));
  ok('an absolute --dir is taken as given',
    resolveDirArg(path.join(os.tmpdir(), 'x')) === path.join(os.tmpdir(), 'x'),
    resolveDirArg(path.join(os.tmpdir(), 'x')));
  ok('no --dir means no override', resolveDirArg(null) === null);

  // 16. the three simple-mode formats. Each is patched as text, not re-serialised
  // through a parser, because this project has no dependency to parse them with —
  // so the property that matters is the one that is easy to get wrong: everything
  // the editor does not own must come out the other side byte-identical.
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-simple-'));
  const codexPath = path.join(sdir, 'config.toml');
  const codexSeed = [
    'model = "old-model"',
    'model_provider = "9router"',
    'model_reasoning_effort = "medium"',
    '',
    '[model_providers.9router]',
    'name = "9Router"',
    'base_url = "http://localhost:20128/v1"',
    'experimental_bearer_token = "sk-old"',
    'wire_api = "responses"',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
    "[projects.'d:\\work\\x']",
    'trust_level = "trusted"',
    '',
  ].join('\n');
  fs.writeFileSync(codexPath, codexSeed);
  const cw = { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-new', model: 'gpt-5' };
  const codexOut = codexWrite(codexSeed, cw);
  const codexBack = codexRead(codexOut);
  ok('codex: base URL is normalised to /v1', codexBack.baseUrl === 'http://127.0.0.1:8787/v1', codexBack.baseUrl);
  ok('codex: the key round-trips', codexBack.apiKey === 'sk-new', codexBack.apiKey);
  ok('codex: the model round-trips', codexBack.model === 'gpt-5', codexBack.model);
  ok('codex: model_provider points at the provider', tomlTopValue(codexOut, 'model_provider') === '9router');
  // The whole reason for text surgery: sections this editor knows nothing about.
  ok('codex: [windows] survives untouched', codexOut.includes('[windows]\nsandbox = "elevated"'));
  ok('codex: a quoted-key project section survives', codexOut.includes("[projects.'d:\\work\\x']"));
  ok('codex: a scalar nobody owns survives', codexOut.includes('model_reasoning_effort = "medium"'));
  ok('codex: exactly one provider section is left', (codexOut.match(/\[model_providers\.9router\]/g) || []).length === 1);
  ok('codex: the old key is gone', !codexOut.includes('sk-old'));
  // A key of the same name inside a section is not the top-level one.
  const nested = '[a]\nmodel = "inner"\n';
  ok('codex: a section-local key is not read as top-level', tomlTopValue(nested, 'model') === '', tomlTopValue(nested, 'model'));
  ok('codex: writing into a sectionless file inserts above nothing',
    tomlSetTop('model = "a"\n', 'model_provider', '9router') === 'model = "a"\nmodel_provider = "9router"\n',
    JSON.stringify(tomlSetTop('model = "a"\n', 'model_provider', '9router')));
  ok('codex: a file with no sections still gets one',
    tomlSetSection('', 'model_providers.9router', '[model_providers.9router]\nname = "x"').startsWith('[model_providers.9router]'));
  ok('codex: a key with a backslash and quote survives', (() => {
    const t = codexWrite('', { baseUrl: 'http://h', apiKey: 'a"b\\c', model: 'm' });
    return codexRead(t).apiKey === 'a"b\\c';
  })(), codexRead(codexWrite('', { baseUrl: 'http://h', apiKey: 'a"b\\c', model: 'm' })).apiKey);
  // A base that already ends in /v1 — with or without a trailing slash — must not
  // grow a second one. http://h/v1/ once became http://h/v1/v1.
  ok('withV1 leaves a bare base alone', withV1('http://h') === 'http://h/v1', withV1('http://h'));
  ok('withV1 leaves a /v1 base alone', withV1('http://h/v1') === 'http://h/v1', withV1('http://h/v1'));
  ok('withV1 strips a trailing slash before the /v1 check',
    withV1('http://h/v1/') === 'http://h/v1', withV1('http://h/v1/'));
  ok('codex: a /v1/ base URL is normalised, not doubled', (() => {
    const t = codexWrite('', { baseUrl: 'http://h/v1/', apiKey: '', model: 'm' });
    return codexRead(t).baseUrl === 'http://h/v1';
  })());

  const ocSeed = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { other: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://x/v1' } } },
    agent: { explorer: { model: '9router/old' } },
  }, null, 2);
  const ocOut = opencodeWrite(ocSeed, { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-oc', model: 'gpt-5' });
  const ocBack = opencodeRead(ocOut);
  const ocJson = JSON.parse(ocOut);
  ok('opencode: base URL is normalised to /v1', ocBack.baseUrl === 'http://127.0.0.1:8787/v1', ocBack.baseUrl);
  ok('opencode: the key round-trips', ocBack.apiKey === 'sk-oc', ocBack.apiKey);
  ok('opencode: the model round-trips', ocBack.model === 'gpt-5', ocBack.model);
  ok('opencode: the active model is namespaced', ocJson.model === '9router/gpt-5', ocJson.model);
  ok('opencode: another provider is left alone', ocJson.provider.other.options.baseURL === 'https://x/v1');
  ok('opencode: a section nobody owns survives', ocJson.agent.explorer.model === '9router/old');
  ok('opencode: the model is registered in the provider', !!ocJson.provider['9router'].models['gpt-5']);
  ok('opencode: JSONC trailing commas are tolerated',
    opencodeRead('{"provider":{"9router":{"options":{"baseURL":"http://a/v1"},},},}').baseUrl === 'http://a/v1');
  ok('opencode: an unparseable file is reported, not thrown',
    opencodeRead('{ not json').broken === true);

  const hermesSeed = [
    'agent:',
    '  name: hermes',
    '',
    'model:',
    '  default: "old-model"',
    '  provider: "custom"',
    '  base_url: "http://localhost:20128/v1"',
    '  api_key: ${OPENAI_API_KEY}',
    '',
    'tools:',
    '  - shell',
    '',
  ].join('\n');
  const hOut = hermesWrite(hermesSeed, { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-h', model: 'gpt-5' });
  const hBack = hermesRead(hOut);
  ok('hermes: base URL is normalised to /v1', hBack.baseUrl === 'http://127.0.0.1:8787/v1', hBack.baseUrl);
  ok('hermes: the model round-trips', hBack.model === 'gpt-5', hBack.model);
  ok('hermes: the block still reads the key from the env', hOut.includes('api_key: ${OPENAI_API_KEY}'));
  ok('hermes: the block is emitted once', (hOut.match(/^model:/gm) || []).length === 1);
  ok('hermes: keys above the block survive', hOut.includes('agent:\n  name: hermes'));
  ok('hermes: keys below the block survive', hOut.includes('tools:\n  - shell'));
  // The blank line between the block and the next key is layout the user chose.
  ok('hermes: the separator after the block is preserved',
    /api_key: \$\{OPENAI_API_KEY\}\n\ntools:/.test(hOut),
    JSON.stringify(hOut.slice(hOut.indexOf('api_key'), hOut.indexOf('api_key') + 60)));
  ok('hermes: a file with no model block gets one prepended',
    hermesWrite('agent:\n  name: h\n', { baseUrl: 'http://h', apiKey: '', model: 'm' }).startsWith('model:\n'));
  const envOut = envVarSet('OPENAI_API_KEY=old\nOTHER=1\n', 'OPENAI_API_KEY', 'sk-h');
  ok('hermes: the key is upserted in .env', envOut.includes('OPENAI_API_KEY=sk-h'));
  ok('hermes: another .env line survives', envOut.includes('OTHER=1'));
  ok('hermes: a missing .env gets the line',
    envVarSet('', 'OPENAI_API_KEY', 'sk-h') === 'OPENAI_API_KEY=sk-h\n', JSON.stringify(envVarSet('', 'OPENAI_API_KEY', 'sk-h')));
  ok('hermes: an existing key is replaced, not appended',
    (envVarSet('OPENAI_API_KEY=old\n', 'OPENAI_API_KEY', 'sk-h').match(/OPENAI_API_KEY=/g) || []).length === 1);
  fs.rmSync(sdir, { recursive: true, force: true });

  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter(c => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------------- routes

async function handler(req, res, port) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p === '/app.js') {
    return send(res, 200, appJs(), 'text/javascript; charset=utf-8');
  }
  // One stylesheet, read per request so an edit shows on reload without a restart.
  if (req.method === 'GET' && p === '/styles.css') {
    return send(res, 200, fs.readFileSync(path.join(HERE, 'styles.css')), 'text/css; charset=utf-8');
  }
  // One icon per tool, named after the tool id. The set is fixed, so the id is
  // checked against the registry before it reaches the filesystem.
  if (req.method === 'GET' && p.startsWith('/icon/')) {
    const id = p.slice('/icon/'.length).replace(/\.png$/, '');
    const file = path.join(ICONS, `${id}.png`);
    if (!toolById(id) || !fs.existsSync(file)) return send(res, 404, JSON.stringify({ error: 'no icon' }));
    return send(res, 200, fs.readFileSync(file), 'image/png');
  }

  // What the Scan button calls. The browser names a tool, never a path — the file
  // is picked server-side, so there is nothing here to validate or traverse.
  if (req.method === 'POST' && p === '/api/scan') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const tool = toolById(typeof payload.tool === 'string' ? payload.tool : 'claude');
    if (!tool) return send(res, 400, JSON.stringify({ error: `unknown tool: ${payload.tool}` }));
    const info = { ...scanInfo(tool), tools: TOOLS };
    console.log(info.found ? `scan found ${info.file}` : `scan found nothing at ${info.file}`);
    return send(res, 200, JSON.stringify(info));
  }

  // The tool list, for a page that wants to draw the picker before any scan.
  if (req.method === 'GET' && p === '/api/tools') {
    return send(res, 200, JSON.stringify({ tools: TOOLS }));
  }

  // The settings of one tool. `?tool=` defaults to claude so an older page that
  // never learned about tools keeps working unchanged.
  if (req.method === 'GET' && p === '/api/settings') {
    const tool = toolById(url.searchParams.get('tool') || 'claude');
    if (!tool) return send(res, 400, JSON.stringify({ error: 'unknown tool' }));
    const paths = toolPaths(tool.id);
    if (tool.mode === 'env') return send(res, 200, JSON.stringify({ ...readSettings(paths.file), selected: paths.file }));
    const s = readSimple(tool, paths);
    // stat separately: the file can vanish between the read and the stat.
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(paths.file).mtimeMs; } catch { /* raced deletion — exists:false stands */ }
    return send(res, 200, JSON.stringify({
      selected: paths.file, tool: tool.id, file: paths.file, values: s.values,
      exists: s.exists, mtimeMs, parseError: s.parseError,
    }));
  }

  // The model list is fetched server-side: the token must never travel to the
  // browser, and the endpoint may not send CORS headers. The URL and token come
  // from the request (the browser holds the unsaved draft), not from the file.
  if (req.method === 'POST' && p === '/api/models') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const base = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
    const token = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (!base) return send(res, 400, JSON.stringify({ error: 'Base URL is empty — set it on the Connection card first.' }));

    let url;
    try {
      url = modelsUrl(base);
    } catch {
      return send(res, 400, JSON.stringify({ error: `"${base}" is not a valid URL.` }));
    }
    // http(s) only: a file:// or ftp:// base must not turn this into a local read.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return send(res, 400, JSON.stringify({ error: `Base URL must be http or https, got ${url.protocol}` }));
    }

    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;

    let r, text;
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      text = await r.text();
    } catch (e) {
      // Node's fetch says only "fetch failed"; the cause carries the real reason
      // (ECONNREFUSED, ENOTFOUND, "bad port", cert error) and is what the user
      // needs to see. cause.code is absent for some of them, so fall back to its message.
      const c = e.cause || {};
      const why = e.name === 'TimeoutError' ? 'timed out after 15s'
        : (c.code || c.message) ? `${c.code ? `${c.code}: ` : ''}${c.message || ''}`.trim()
        : e.message;
      return send(res, 502, JSON.stringify({ error: `${url.href} — ${why}` }));
    }

    let body = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    // The shape OpenAI, Anthropic and most gateways share. Anything else with no
    // `data` array is reported as "this endpoint has no model list", not as a crash.
    const rows = body && Array.isArray(body.data) ? body.data : null;
    if (!r.ok) {
      const detail = (body && (body.error?.message || body.error || body.message)) || text.slice(0, 300);
      return send(res, 502, JSON.stringify({ error: `${url.href} returned ${r.status}: ${detail}` }));
    }
    if (!rows) {
      return send(res, 200, JSON.stringify({ url: url.href, models: null,
        error: `${url.href} does not provide a model list (no "data" array in the response).` }));
    }
    const models = rows
      .map(m => (m && typeof m === 'object' ? (m.id || m.name || m.model) : m))
      .filter(m => typeof m === 'string' && m)
      .sort((a, b) => a.localeCompare(b));
    console.log(`models: ${models.length} from ${url.href}`);
    return send(res, 200, JSON.stringify({ url: url.href, models, windows: modelWindows(rows), vision: modelVision(rows) }));
  }

  if (req.method === 'POST' && p === '/api/settings') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));

    const payload = await jsonBody(req, res);
    if (!payload) return;

    const tool = toolById(typeof payload.tool === 'string' ? payload.tool : 'claude');
    if (!tool) return send(res, 400, JSON.stringify({ error: `unknown tool: ${payload.tool}` }));
    const paths = toolPaths(tool.id);
    const file = paths.file;

    // ---- simple mode: three values patched into a file this editor does not own.
    if (tool.mode === 'simple') {
      const v = payload.values;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return send(res, 400, JSON.stringify({ error: 'missing values' }));
      const values = {
        baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '',
        apiKey: typeof v.apiKey === 'string' ? v.apiKey.trim() : '',
        model: typeof v.model === 'string' ? v.model.trim() : '',
      };
      // A base URL with no scheme would be written into a config as a path. Caught
      // here rather than at the next CLI launch, where the error is a network one.
      if (!values.baseUrl) return send(res, 400, JSON.stringify({ error: 'Base URL is required.' }));
      let parsed;
      try { parsed = new URL(values.baseUrl); } catch {
        return send(res, 400, JSON.stringify({ error: `"${values.baseUrl}" is not a valid URL.` }));
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return send(res, 400, JSON.stringify({ error: `Base URL must be http or https, got ${parsed.protocol}` }));
      }
      if (!values.model) return send(res, 400, JSON.stringify({ error: 'Model is required.' }));

      // Stale-write guard, same as env mode: another writer may have touched the
      // file since load. Only the main file is guarded — the Hermes .env upsert
      // is append-only and low-risk.
      const before = readText(file);
      if (before !== null && payload.baseMtimeMs) {
        try {
          const m = fs.statSync(file).mtimeMs;
          if (Math.abs(m - payload.baseMtimeMs) > 1) {
            return send(res, 409, JSON.stringify({ error: 'file changed on disk since you loaded it', mtimeMs: m }));
          }
        } catch { /* raced deletion — fall through to the write */ }
      }
      let backup = null;
      if (before !== null) { try { backup = backupBeforeWrite(file); } catch { /* a missing backup must not block the save */ } }
      let text;
      try {
        text = writeSimple(tool, paths, values);
      } catch (e) {
        return send(res, e.status || 500, JSON.stringify({ error: `write failed: ${e.message}` }));
      }
      const st = fs.statSync(file);
      // Never log the values — apiKey is a live token.
      console.log(`wrote ${file} (${st.size} bytes)${backup ? ` — previous version saved to ${backup}` : ''}`);
      return send(res, 200, JSON.stringify({ ok: true, file, bytes: st.size, mtimeMs: st.mtimeMs, backup, text }));
    }

    if (typeof payload.doc === 'undefined') return send(res, 400, JSON.stringify({ error: 'missing doc' }));
    const current = readSettings(file);

    // Stale-write guard: Claude Code writes this file live. Last-write-wins would
    // silently discard whatever landed since load. 409 keeps the client's draft.
    if (current.exists && payload.baseMtimeMs && Math.abs(current.mtimeMs - payload.baseMtimeMs) > 1) {
      return send(res, 409, JSON.stringify({ error: 'file changed on disk since you loaded it', mtimeMs: current.mtimeMs }));
    }

    const text = JSON.stringify(payload.doc, null, 2).replace(/\n/g, current.eol || '\n') + (current.eol || '\n');
    // Back up only when the bytes actually change, so a no-op save does not burn a
    // slot in the rotation.
    let backup = null;
    if (current.exists && current.raw !== text) {
      try { backup = backupBeforeWrite(file); } catch { /* a missing backup must not block the save */ }
    }
    try {
      atomicWrite(file, text);
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: `write failed: ${e.code || e.message}` }));
    }
    const st = fs.statSync(file);
    // Never log file contents — settings.json holds env.ANTHROPIC_AUTH_TOKEN.
    console.log(`wrote ${file} (${st.size} bytes)${backup ? ` — previous version saved to ${backup}` : ''}`);
    return send(res, 200, JSON.stringify({ ok: true, file, bytes: st.size, mtimeMs: st.mtimeMs, backup }));
  }

  send(res, 404, JSON.stringify({ error: 'not found' }));
}

// ------------------------------------------------------------------------ main

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const portArg = argv.indexOf('--port');
  const port = portArg > -1 ? Number(argv[portArg + 1]) : 8787;
  const open = argv.includes('--open');

  // Write the double-click launcher and stop. `start.cmd --shortcut` is the one
  // command a user needs to run once; after that the desktop icon is the entry point.
  if (argv.includes('--shortcut')) {
    const nameArg = argv.indexOf('--name');
    const name = nameArg > -1 && argv[nameArg + 1] ? argv[nameArg + 1] : 'CONFIG READER';
    // --dir wins, so the shortcut can go anywhere: the public desktop, a USB stick,
    // a Start Menu folder. Relative paths resolve against the editor's own folder.
    const dirArg = argv.indexOf('--dir');
    const dirOverride = resolveDirArg(dirArg > -1 && argv[dirArg + 1] ? argv[dirArg + 1] : null);
    let made;
    try { made = installShortcut(port, name, dirOverride); }
    catch (e) { console.error(`\nCould not create the shortcut: ${e.message}\n`); process.exit(1); }
    console.log(`\n  Shortcut ready — double-click it to open the editor.\n`);
    if (made.file && made.dir) console.log(`  ${made.file}`);
    else console.log(`  launcher: ${made.vbs}`);
    if (made.note) console.log(`  ${made.note}`);
    console.log(`\n  It starts the server on port ${port} hidden and opens http://127.0.0.1:${port}\n`);
    return;
  }

  // Double-clicking the shortcut while the editor is already open must not die on
  // EADDRINUSE — it means "show me the window", so hand the URL to the browser.
  if (open && await isUp(port)) {
    console.log(`\n  Already running — opening http://127.0.0.1:${port}\n`);
    openBrowser(`http://127.0.0.1:${port}`);
    return;
  }

  const server = http.createServer((req, res) => {
    handler(req, res, port).catch(e => {
      if (res.headersSent) return;
      send(res, e.status || 500, JSON.stringify({ error: e.message }));
    });
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nPort ${port} is busy. Another copy may already be running.`);
      console.error(`Open http://127.0.0.1:${port} — or start with: node server.js --port ${port + 1}\n`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  CONFIG READER\n  ${url}\n  will edit ${settingsFile()}\n\n  Ctrl+C to stop\n`);
    if (open) openBrowser(url);
  });
}

main();
