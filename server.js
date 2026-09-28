// CONFIG READER — local web editor. Zero npm deps, Node stdlib only.
//   node server.js [--port 8787] [--open] [--selftest]
'use strict';

// Needs Node 22.13+ — the release stripTypeScriptTypes actually landed in (v22.13.0,
// and v23.2.0 on the odd line). A bare major check waves 22.0-22.12 through, and the
// failure then surfaces as a dead page rather than a sentence, so the check asks for
// the functions themselves instead of parsing a version number.
const { stripTypeScriptTypes } = require('node:module');
const missing = typeof stripTypeScriptTypes !== 'function' ? 'stripTypeScriptTypes'
  : typeof fetch !== 'function' ? 'fetch'
  : typeof globalThis.AbortSignal?.timeout !== 'function' ? 'AbortSignal.timeout'
  : null;
if (missing) {
  console.error(`CONFIG READER needs Node.js 22.13 or newer — no ${missing} here (running ${process.versions.node}).`);
  process.exit(1);
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const HERE = __dirname;
const INDEX = path.join(HERE, 'index.html');
const APP_TS = path.join(HERE, 'app.ts');
const ICONS = path.join(HERE, 'icons');

// CLAUDE_CONFIG_DIR overrides ~/.claude entirely. Check it before homedir().
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Hermes follows the same rule with its own variable. The Hermes installer sets
// HERMES_HOME (AppData\Local\hermes on Windows) and the agent reads that directory,
// so ~/.hermes can be an empty leftover — editing it would write a config nothing
// opens. ponytail: the default profile only; a named profile lives under
// <HERMES_HOME>/profiles/<name> and is not guessed at.
const hermesHome = () => process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

// Codex: CODEX_HOME or ~/.codex. It has no XDG fallback, so there is no second
// candidate to guess at. Checked because a CODEX_HOME install otherwise gets its
// config written to a ~/.codex the CLI never reads.
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// OpenCode follows the XDG base-directory spec on Linux and macOS, but on Windows
// it uses %USERPROFILE%\.config — XDG_CONFIG_HOME is not honoured there. Both
// rules are opencode's own; this only mirrors them.
const opencodeDir = () => {
  const xdg = process.platform === 'win32' ? '' : process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), '.config'), 'opencode');
};

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
  { id: 'claude', name: 'Claude Code', mode: 'env', bin: 'claude' },
  { id: 'codex', name: 'Codex', mode: 'simple', bin: 'codex' },
  { id: 'opencode', name: 'OpenCode', mode: 'simple', bin: 'opencode' },
  { id: 'hermes', name: 'Hermes Agent', mode: 'simple', bin: 'hermes' },
];

const toolById = id => TOOLS.find(t => t.id === id) || null;

// Is the CLI itself on PATH? A directory walk, not a spawned `which`/`where`. The
// two were compared on this machine's four tools before choosing, and agreed on
// every case including a synthetic binary in a scratch dir — the walk is the same
// answer for 5x less time and no shell. The exec bit is checked so a non-executable
// file of the right name does not count as installed, which is what `which` does too.
// ponytail: misses shell aliases and bash functions. Spawn `which` if a tool ever
// ships that way.
function hasBin(name) {
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')].filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const st = fs.statSync(path.join(dir, name + ext));
        if (st.isFile() && (process.platform === 'win32' || (st.mode & 0o111))) return true;
      } catch { /* not in this directory */ }
    }
  }
  return false;
}

// The registry as the page sees it: the tool list plus whether the CLI is actually
// on this machine. Computed per request rather than cached — it is two calls a
// session, and a cache would go stale the moment someone installs a tool.
const toolList = () => TOOLS.map(t => ({ ...t, installed: hasBin(t.bin) }));

// Every path is derived here, server-side. The browser names a tool and never a
// file, so there is still no path arriving from the client to validate or traverse.
function toolPaths(id) {
  if (id === 'claude') return { file: path.join(configDir(), 'settings.json') };
  if (id === 'codex') return { file: path.join(codexHome(), 'config.toml') };
  if (id === 'opencode') return { file: path.join(opencodeDir(), 'opencode.json') };
  if (id === 'hermes') return { file: path.join(hermesHome(), 'config.yaml'), envFile: path.join(hermesHome(), '.env') };
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

// A BOM is not part of the JSON, but Notepad and a few Windows editors write one.
// Stripping it here means the file parses, the editor can edit it, and the BOM is put
// back on write — otherwise a valid file would be reported as broken and refuse to
// save. Kept separate from `raw` so the round-trip comparison stays honest.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readSettings(file) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }

  if (raw === null) {
    return { file, exists: false, raw: '', parsed: {}, eol: '\n', mtimeMs: 0, normalized: false, parseError: null, bom: false };
  }

  const st = fs.statSync(file);
  const eol = detectEol(raw);
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  try {
    const parsed = JSON.parse(body);
    // Round-trip is semantic, not byte-level. If re-serialising would change the
    // file, say so — a silent reformat beats a silent key drop, but visible beats both.
    const canonical = JSON.stringify(parsed, null, 2).replace(/\n/g, eol) + eol;
    return { file, exists: true, raw, parsed, eol, mtimeMs: st.mtimeMs, normalized: canonical !== body, parseError: null, bom };
  } catch (e) {
    // Broken file is a supported state: hand back the raw text so the UI can say so.
    return { file, exists: true, raw, parsed: null, eol, mtimeMs: st.mtimeMs, normalized: false, parseError: e.message, bom };
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
  try { return stripBom(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
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

// Set one key inside a section, creating the section when the file has none. Unlike
// tomlSetSection this keeps the section's other keys: [agents] holds settings this
// editor has no field for.
function tomlSetInSection(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${section}\\]`).test(l));
  if (start === -1) return tomlSetSection(text, section, `[${section}]\n${key} = ${tomlString(value)}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break; }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const at = lines.findIndex((l, i) => i > start && i < end && re.test(l));
  if (at === -1) lines.splice(end, 0, `${key} = ${tomlString(value)}`);
  else lines[at] = `${key} = ${tomlString(value)}`;
  return lines.join('\n');
}

// Codex CLI: ~/.codex/config.toml. The key travels in the provider block, because
// a custom provider ignores auth.json — and as a static Authorization header, which
// is the form Codex documents; experimental_bearer_token is only read for configs
// another tool wrote that way.
function codexKey(src) {
  const hdr = tomlSectionValues(src, `model_providers.${PROVIDER}.http_headers`);
  const auth = hdr.Authorization || hdr.authorization || '';
  if (auth) return auth.replace(/^Bearer\s+/i, '');
  const prov = tomlSectionValues(src, `model_providers.${PROVIDER}`);
  return prov.experimental_bearer_token || prov.api_key || '';
}

function codexRead(text) {
  const src = text || '';
  const prov = tomlSectionValues(src, `model_providers.${PROVIDER}`);
  return {
    baseUrl: prov.base_url || '',
    apiKey: codexKey(src),
    model: tomlTopValue(src, 'model'),
    subagentModel: tomlSectionValues(src, 'agents').default_subagent_model || '',
  };
}

function codexWrite(text, v) {
  let out = text || '';
  out = tomlSetTop(out, 'model_provider', PROVIDER);
  if (v.model) out = tomlSetTop(out, 'model', v.model);
  if (v.subagentModel) out = tomlSetInSection(out, 'agents', 'default_subagent_model', v.subagentModel);
  const lines = [
    `[model_providers.${PROVIDER}]`,
    `name = ${tomlString(PROVIDER_LABEL)}`,
    `base_url = ${tomlString(withV1(v.baseUrl))}`,
    'wire_api = "responses"',
  ];
  out = tomlSetSection(out, `model_providers.${PROVIDER}`, lines.join('\n'));
  if (v.apiKey) {
    out = tomlSetSection(out, `model_providers.${PROVIDER}.http_headers`,
      `[model_providers.${PROVIDER}.http_headers]\nAuthorization = ${tomlString(`Bearer ${v.apiKey}`)}`);
  }
  return out;
}

// OpenCode: ~/.config/opencode/opencode.json. JSONC in the wild, so trailing
// commas are stripped before parsing — the same tolerance 9router has.
function jsoncParse(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

function opencodeRead(text) {
  let cfg;
  try { cfg = jsoncParse(text || '{}'); } catch { return { baseUrl: '', apiKey: '', model: '', subagentModel: '', broken: true }; }
  const p = cfg?.provider?.[PROVIDER];
  const model = typeof cfg?.model === 'string' && cfg.model.startsWith(`${PROVIDER}/`)
    ? cfg.model.slice(PROVIDER.length + 1) : '';
  const sub = cfg?.agent?.explorer?.model;
  return {
    baseUrl: p?.options?.baseURL || '',
    apiKey: p?.options?.apiKey || '',
    model,
    subagentModel: typeof sub === 'string' && sub.startsWith(`${PROVIDER}/`)
      ? sub.slice(PROVIDER.length + 1) : '',
  };
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
  if (v.subagentModel) {
    if (!cfg.agent || typeof cfg.agent !== 'object') cfg.agent = {};
    cfg.agent.explorer = {
      description: 'Fast explorer subagent for codebase exploration',
      mode: 'subagent',
      model: `${PROVIDER}/${v.subagentModel}`,
    };
  }
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

// Hermes: <HERMES_HOME>/config.yaml holds a top-level `model:` block, and the key
// lives in the .env beside it, referenced from the block as ${OPENAI_API_KEY}.
// Besides that block Hermes reads a `delegation:` block and one block per role under
// `auxiliary:` — all four keys of the same shape, so one patcher serves all three.
const HERMES_MODEL_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;
const HERMES_DELEGATION_RE = /^delegation:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;
const HERMES_AUX_RE = /^auxiliary:[ \t]*\r?\n((?:(?:[ \t]+.*\r?\n?)|(?:[ \t]*\r?\n))*)/m;
// Role ids are 9router's list; `delegation` is a top-level block, the rest live under
// `auxiliary:`. The editor offers a field per role and writes only the filled ones.
const HERMES_ROLES = ['delegation', 'vision', 'web_extract', 'compression', 'title_generation',
  'approval', 'skills_hub', 'mcp', 'memory_query_rewrite', 'background_review', 'curator', 'monitor'];
const hermesRoleRe = role =>
  new RegExp(`^  ${role}:[ \\t]*\\r?\\n(?:(?:[ \\t]{4,}.*\\r?\\n?)|(?:[ \\t]*\\r?\\n))*`, 'm');

function hermesBlockValue(body, key) {
  const m = new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, 'm').exec(body || '');
  return m ? m[1].trim() : '';
}

function hermesRead(text) {
  const src = text || '';
  const out = { baseUrl: '', apiKey: '', model: '' };
  const m = HERMES_MODEL_RE.exec(src);
  if (m) {
    out.baseUrl = hermesBlockValue(m[1], 'base_url');
    out.model = hermesBlockValue(m[1], 'default');
  }
  const d = HERMES_DELEGATION_RE.exec(src);
  out.delegation = d ? hermesBlockValue(d[1], 'model') : '';
  const aux = HERMES_AUX_RE.exec(src);
  for (const role of HERMES_ROLES) {
    if (role === 'delegation') continue;
    const r = aux ? new RegExp(`^  ${role}:[ \\t]*\\r?\\n((?:(?:[ \\t]{4,}.*\\r?\\n?)|(?:[ \\t]*\\r?\\n))*)`, 'm').exec(aux[1]) : null;
    out[role] = r ? hermesBlockValue(r[1], 'model') : '';
  }
  return out;
}

// Patch a Hermes block key by key, never rebuild it: a block in the wild carries keys
// this editor has no field for — context_length, max_tokens, an api_key line naming the
// user's own env var — and rebuilding would drop every one of them. Only the model key,
// base_url, provider and api_key are ours; the last two are only filled in when absent.
function hermesPatchBlock(body, indent, modelKey, v) {
  const lines = body.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const at = key => lines.findIndex(l => new RegExp(`^\\s+${key}\\s*:`).test(l));
  const put = (key, line) => {
    const i = at(key);
    if (i === -1) lines.push(line); else lines[i] = line;
  };
  put(modelKey, `${indent}${modelKey}: ${JSON.stringify(v.model)}`);
  put('base_url', `${indent}base_url: ${JSON.stringify(withV1(v.baseUrl))}`);
  // A provider of the user's own (a hand-written `provider: anthropic`) is left alone.
  if (at('provider') === -1) put('provider', `${indent}provider: "custom"`);
  if (at('api_key') === -1) put('api_key', `${indent}api_key: \${OPENAI_API_KEY}`);
  return lines.join('\n');
}

const hermesBuildBlock = (name, indent, modelKey, v) =>
  `${name}:\n` + hermesPatchBlock('', indent, modelKey, v) + '\n';

// The model block goes first when the file has none (9router does the same); the other
// blocks append, which is also what 9router's own writers do.
function hermesSetTopBlock(text, name, modelKey, v, prepend = false) {
  const re = name === 'model' ? HERMES_MODEL_RE : HERMES_DELEGATION_RE;
  const m = re.exec(text);
  if (!m) return prepend ? `${hermesBuildBlock(name, '  ', modelKey, v)}${text}` : `${text}${hermesBuildBlock(name, '  ', modelKey, v)}`;
  const block = `${name}:\n${hermesPatchBlock(m[1], '  ', modelKey, v)}\n`;
  const head = text.slice(0, m.index);
  const rest = text.slice(m.index + m[0].length);
  return `${head}${block}${rest ? `\n${rest}` : ''}`;
}

function hermesSetRole(text, role, v) {
  const aux = HERMES_AUX_RE.exec(text);
  const block = `  ${role}:\n`
    + hermesPatchBlock('', '  ', 'model', v).split('\n').map(l => `  ${l}`).join('\n') + '\n';
  if (!aux) return `${text}${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}auxiliary:\n${block}`;
  const body = aux[1] || '';
  const re = hermesRoleRe(role);
  const next = re.test(body) ? body.replace(re, block) : `${body}${block}`;
  return text.replace(HERMES_AUX_RE, `auxiliary:\n${next}`);
}

function hermesWrite(text, v) {
  const out = text || '';
  const eol = out.includes('\r\n') ? '\r\n' : '\n';
  let next = hermesSetTopBlock(out, 'model', 'default', v, true);
  if (v.delegation) next = hermesSetTopBlock(next, 'delegation', 'model', { model: v.delegation, baseUrl: v.baseUrl });
  for (const role of HERMES_ROLES) {
    if (role === 'delegation' || !v[role]) continue;
    next = hermesSetRole(next, role, { model: v[role], baseUrl: v.baseUrl });
  }
  return next;
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
  // Read raw, not through readText: the BOM has to be remembered so it can be put
  // back. readText strips it for the parsers; this funnel owes the file its bytes.
  let rawFile = '';
  try { rawFile = fs.readFileSync(paths.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const bom = rawFile.charCodeAt(0) === 0xfeff;
  const raw0 = stripBom(rawFile);
  // The surgery below is line-based and emits LF, so a CRLF config would come back
  // mixed. Normalise in, restore the file's own ending on the way out — env mode has
  // done the same per file from the start, and this is the one funnel all three
  // simple formats pass through.
  const eol = detectEol(raw0);
  const raw = eol === '\n' ? raw0 : raw0.split('\r\n').join('\n');
  if (tool.id === 'opencode') {
    try { jsoncParse(raw || '{}'); } catch (e) { throw Object.assign(new Error(`existing opencode.json is not valid JSON: ${e.message}`), { status: 409 }); }
  }
  const out = tool.id === 'codex' ? codexWrite(raw, values)
    : tool.id === 'opencode' ? opencodeWrite(raw, values)
    : hermesWrite(raw, values);
  const text = (bom ? '\uFEFF' : '') + (eol === '\n' ? out : out.split('\n').join('\r\n'));
  atomicWrite(paths.file, text);
  // Hermes reads its key from .env, and only there. Blank means "leave the key be".
  if (tool.id === 'hermes' && values.apiKey) {
    atomicWrite(paths.envFile, envVarSet(readText(paths.envFile) || '', 'OPENAI_API_KEY', values.apiKey));
  }
  return text;
}
// ---------------------------------------------------------------- connections

// Saved endpoints: the three values every tool asks for — base URL, token, default
// model — typed once and applied to any tool's form. One file, under the home dir so
// a re-clone does not take the tokens with it. The path is derived here; the browser
// never sends one, the same rule every other path in this file follows.
const CONNECTIONS_MAX = 50;
const connectionsFile = () => path.join(os.homedir(), '.config-reader', 'connections.json');

// A token at rest. On Windows, DPAPI through the PowerShell that ships with the OS:
// no native module, no build step, and a blob only this user on this machine can
// open. Everywhere else there is no OS key store this project can reach without a
// dependency, so the token is stored plainly — the same as the config files it is
// copied into. `enc: 'dpapi'` in the file is what says which one a row is.
// ponytail: DPAPI protects a copied file, not a process running as this user.
// macOS Keychain / libsecret are the upgrade path, as one optional dependency.
const DPAPI_PROTECT = '$t = [Console]::In.ReadToEnd();'
  + ' ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString | Write-Output';
const DPAPI_UNPROTECT = '$h = [Console]::In.ReadToEnd().Trim();'
  + ' [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $h))) | Write-Output';

// The secret travels over stdin, never in the command line: argv is readable by any
// process that can list command lines, and a token is not worth that.
function dpapi(script, input) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, input, timeout: 10000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || 'powershell failed').trim().split('\n')[0]);
  return (r.stdout || '').trim();
}

const secretsAtRest = () => process.platform === 'win32';

function protectSecret(plain) {
  if (!plain || !secretsAtRest()) return { apiKey: plain, enc: 'plain' };
  try {
    return { apiKey: dpapi(DPAPI_PROTECT, plain), enc: 'dpapi' };
  } catch {
    // Losing the token the user just typed is worse than storing it plainly.
    return { apiKey: plain, enc: 'plain' };
  }
}

// '' keyError means the value is usable; a message means the blob cannot be opened
// here (another machine, another account) and the UI must say so rather than apply
// an empty token.
function revealSecret(enc, value) {
  if (!value) return { apiKey: '', keyError: '' };
  if (enc !== 'dpapi') return { apiKey: value, keyError: '' };
  try {
    return { apiKey: dpapi(DPAPI_UNPROTECT, value), keyError: '' };
  } catch {
    return { apiKey: '', keyError: 'stored on another machine or user account — re-enter the token' };
  }
}

// What a connection is: a name to recognise it by, and the three values. Everything
// else is dropped, so a client cannot park extra keys in the store.
const cleanConnection = row => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const name = str(row.name).trim().slice(0, 60);
  const baseUrl = str(row.baseUrl).trim().slice(0, 300);
  const model = str(row.model).trim().slice(0, 200);
  let ok = false;
  try { const u = new URL(baseUrl); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch { /* not a URL */ }
  if (!name || !ok) return null;
  return { name, baseUrl, model };
};

// A row as the file holds it: the three values plus the stored secret and how it was
// stored. `enc` is read from the file only — a client never gets to claim one.
const cleanConnectionRow = row => {
  const base = cleanConnection(row);
  if (!base) return null;
  return { ...base, apiKey: str(row.apiKey), enc: str(row.enc) || 'plain' };
};

// Never throws: a missing file is the first-run case, and a hand-broken one must not
// take the page down with it. A store that will not parse reads as empty, and the
// first save writes it properly.
function readConnections() {
  let raw = null;
  try { raw = fs.readFileSync(connectionsFile(), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (raw === null) return { exists: false, profiles: [] };
  try {
    const doc = JSON.parse(stripBom(raw));
    const list = Array.isArray(doc && doc.profiles) ? doc.profiles : [];
    return { exists: true, profiles: list.map(cleanConnectionRow).filter(Boolean).slice(0, CONNECTIONS_MAX) };
  } catch {
    return { exists: true, profiles: [] };
  }
}

function writeConnections(profiles) {
  const doc = {
    version: 1,
    profiles: profiles.map(cleanConnectionRow).filter(Boolean).slice(0, CONNECTIONS_MAX),
  };
  atomicWrite(connectionsFile(), `${JSON.stringify(doc, null, 2)}\n`);
  // POSIX only. On Windows chmod flips one read-only bit and does nothing else — the
  // measured answer is 666 either way — so this is a real restriction on Linux/WSL/
  // macOS and a no-op here. The Windows answer is DPAPI, below.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(connectionsFile(), 0o600); } catch { /* best effort */ }
  }
  return doc;
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

// Same rule as modelsUrl, for the one-line completion a health check sends.
function chatUrl(base) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const u = new URL(root);
  return new URL(/\/v1\/?$/.test(u.pathname) ? 'chat/completions' : 'v1/chat/completions', root);
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
    'Dim sh, fso, here, node, msg',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'here = fso.GetParentFolderName(WScript.ScriptFullName)',
    'node = "node.exe"',
    'If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe") Then',
    '  node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe"',
    'End If',
    // A shortcut that dies silently is the worst version of this: say what is wrong.
    'If node = "node.exe" Then',
    '  If sh.Run("cmd /c where node", 0, True) <> 0 Then',
    '    msg = "CONFIG READER needs Node.js 22.13 or newer, and node was not found." & vbCrLf & vbCrLf',
    '    msg = msg & "Install it from https://nodejs.org/ (the LTS installer is fine), " & vbCrLf',
    '    msg = msg & "then double-click this shortcut again."',
    '    MsgBox msg, 16, "CONFIG READER"',
    '    WScript.Quit 1',
    '  End If',
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

// The Exec key is not a shell line. The desktop spec quotes an argument with " and
// escapes \ " ` and $ with a backslash, so a path with a space or a $ in it is
// otherwise split into separate arguments and the launcher quietly does nothing.
const execQuote = s => '"' + String(s).replace(/([\\"`$])/g, '\\$1') + '"';
const shQuote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

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
    `Exec=node ${execQuote(path.join(HERE, 'server.js'))} --port ${port} --open`,
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

// macOS has neither .lnk nor .desktop, but a .command file is the native equivalent:
// Finder opens it in Terminal and runs it, so a double-click is all it takes. An .app
// bundle would buy an icon and nothing else this tool needs.
function installShortcutMac(dir, port, name) {
  const file = path.join(dir, `${name}.command`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ncd ${shQuote(HERE)}\nexec node ./server.js --port ${port} --open\n`);
  fs.chmodSync(file, 0o755);
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
// file in the applications dir; macOS gets a double-clickable .command in
// ~/Applications. A platform with none of those still gets the launcher file, and
// the caller is told where it landed rather than being handed a broken shortcut.
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
  } else if (process.platform === 'darwin') {
    // ~/Applications needs no admin rights and Spotlight indexes it. A bare home
    // directory (some CI images) still gets the file, just with no note to explain it.
    dir = dirOverride || path.join(os.homedir(), 'Applications');
    file = installShortcutMac(dir, port, name);
    note = 'double-click it in Finder; if macOS blocks it, right-click → Open once';
  } else {
    note = `no shortcut installer for ${process.platform} — the launcher is at ${vbs}`;
  }
  return { file: file || vbs, dir, vbs, note };
}
// A positive number from whatever the endpoint sent, or undefined. One reader for
// every numeric field below: they arrive as numbers or numeric strings, and a
// missing or zero limit is not a limit worth showing.
const num = v => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// The context window each model advertises, by id. Claude Code assumes 200K unless
// the model name carries a trailing [1m], so the editor needs this to decide whether
// to add that marker on assign. Four shapes are in the wild — a flat context_length,
// a nested capabilities.contextWindow, Anthropic's max_input_tokens, and
// models.dev/OpenRouter's limit.context / top_provider.context_length — and some
// entries carry none, which is why a missing window is left out rather than guessed at.
function modelWindows(rows) {
  const out = {};
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name || m.model;
    const w = num(m.context_length) ?? num(m.max_input_tokens)
      ?? num(m.capabilities && m.capabilities.contextWindow)
      ?? num(m.limit && m.limit.context) ?? num(m.top_provider && m.top_provider.context_length);
    if (typeof id === 'string' && id && w) out[id] = w;
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

// A modality value as true/false/undefined. Accepts the three shapes gateways use:
// an array (["text","image"]), a "+"-joined string ("text+image->text" in
// OpenRouter's architecture.modality), and an object naming its input side
// ({"input":["text","image"]} — kenari, HF router, models.dev). Names an image
// modality -> vision; a non-empty value naming none -> text-only. Anything else
// (absent, empty, non-strings) is unknown, not a no.
function visionFromModalities(v) {
  // Only the input side counts: an output image modality is image generation, not
  // the ability to read a picture.
  const side = v && typeof v === 'object' && !Array.isArray(v)
    ? (v.input ?? v.input_modalities)
    : v;
  const toks = Array.isArray(side)
    ? side.filter(x => typeof x === 'string').map(x => x.toLowerCase())
    : typeof side === 'string' && side
      ? side.toLowerCase().split(/[^a-z]+/).filter(Boolean)
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
      const v = s[k];
      if (typeof v === 'boolean') return v;
      // Anthropic reports these as { supported: true } rather than a bare flag.
      if (v && typeof v === 'object' && typeof v.supported === 'boolean') return v.supported;
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

// A string, or '' — every optional string on a model row is read the same way.
const str = v => (typeof v === 'string' ? v : '');

// Everything the endpoint said about each model, by id. `caps` is the endpoint's own
// capabilities object passed through untouched — its keys are that gateway's
// vocabulary, not ours, so a gateway reporting something new needs no change here.
// The rest is derived, and each field has more than one shape in the wild: numbers
// arrive flat (context_length), nested (capabilities.contextWindow) or per-upstream
// (top_provider.max_completion_tokens), so every spelling is tried in turn and a
// field nobody reported stays out rather than being guessed at. `meta` is the display
// layer: a human name, whether the model is free, whether it is on its way out.
function modelCaps(rows) {
  const out = {};
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name || m.model;
    if (typeof id !== 'string' || !id) continue;
    const src = m.capabilities;
    const caps = src && typeof src === 'object' && !Array.isArray(src) ? { ...src } : {};
    if (typeof caps.vision !== 'boolean') {
      const v = rowVision(m);
      if (typeof v === 'boolean') caps.vision = v;
    }
    // OpenRouter reports tool support as a parameter list, not a flag.
    if (Array.isArray(m.supported_parameters) && typeof caps.tools !== 'boolean') {
      caps.tools = m.supported_parameters.includes('tools');
    }
    // kenari and models.dev report the same facts as flat booleans. Only exact names
    // are aliased — a field whose meaning has to be interpreted is left alone.
    if (typeof m.tool_call === 'boolean' && typeof caps.tools !== 'boolean') caps.tools = m.tool_call;
    if (typeof m.reasoning === 'boolean' && typeof caps.reasoning !== 'boolean') caps.reasoning = m.reasoning;
    // Reasoning levels, from either spelling: a flat list (kenari's reasoning_options)
    // or OpenRouter's nested reasoning.supported_efforts.
    const efforts = [
      ...(Array.isArray(m.reasoning_options) ? m.reasoning_options : []),
      ...(m.reasoning && Array.isArray(m.reasoning.supported_efforts) ? m.reasoning.supported_efforts : []),
    ].filter(x => typeof x === 'string');
    const p = m.pricing && typeof m.pricing === 'object' ? m.pricing : {};
    // Free is explicit on some gateways (kenari) and a zero price on others.
    const free = typeof p.free === 'boolean' ? p.free
      : (p.prompt !== undefined || p.completion !== undefined) && !num(p.prompt) && !num(p.completion);
    out[id] = {
      provider: str(m.owned_by),
      ctx: num(m.context_length) ?? num(m.max_input_tokens) ?? num(caps.contextWindow)
        ?? num(m.limit && m.limit.context) ?? num(m.top_provider && m.top_provider.context_length) ?? 0,
      maxOut: num(m.max_completion_tokens) ?? num(m.max_tokens) ?? num(caps.maxOutput)
        ?? num(m.limit && m.limit.output) ?? num(m.top_provider && m.top_provider.max_completion_tokens) ?? 0,
      caps,
      meta: {
        name: str(m.display_name) || str(m.name),
        description: str(m.description),
        free,
        sunset: str(m.sunset_at) || str(m.expiration_date),
        efforts: [...new Set(efforts)],
        endpoints: (Array.isArray(m.endpoints) ? m.endpoints : []).filter(x => typeof x === 'string'),
      },
    };
  }
  return out;
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
    const info = { ...scanInfo(tool), tools: toolList() };
    console.log(info.found ? `scan found ${info.file}` : `scan found nothing at ${info.file}`);
    return send(res, 200, JSON.stringify(info));
  }

  // The tool list, for a page that wants to draw the picker before any scan. Gated
  // with the rest: it is the same shape of request, and one rule beats a per-route guess.
  if (req.method === 'GET' && p === '/api/tools') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    return send(res, 200, JSON.stringify({ tools: toolList() }));
  }

  // The settings of one tool. `?tool=` defaults to claude so an older page that
  // never learned about tools keeps working unchanged.
  if (req.method === 'GET' && p === '/api/settings') {
    // This reply carries env.ANTHROPIC_AUTH_TOKEN, so the read needs the same gate
    // as the write: a DNS-rebinding page reaches 127.0.0.1 with Host=evil.com and
    // would otherwise read the token straight out of the JSON.
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
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
    return send(res, 200, JSON.stringify({ url: url.href, models, caps: modelCaps(rows) }));
  }

  // Is this model actually answering? One tiny completion is the only honest test:
  // a model can be listed and still be down upstream. Nothing about the answer is
  // read, so a 200 is the whole signal.
  if (req.method === 'POST' && p === '/api/test-model') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const base = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
    const token = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    if (!base) return send(res, 400, JSON.stringify({ error: 'Base URL is empty.' }));
    if (!model) return send(res, 400, JSON.stringify({ error: 'No model to test.' }));

    let url;
    try { url = chatUrl(base); } catch { return send(res, 400, JSON.stringify({ error: `"${base}" is not a valid URL.` })); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return send(res, 400, JSON.stringify({ error: `Base URL must be http or https, got ${url.protocol}` }));
    }

    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const started = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await r.text();
      const ms = Date.now() - started;
      if (!r.ok) {
        let detail = text.slice(0, 300);
        try {
          const b = JSON.parse(text);
          detail = b?.error?.message || b?.error || b?.message || detail;
        } catch { /* not json */ }
        return send(res, 200, JSON.stringify({ ok: false, ms, error: `${r.status}: ${detail}` }));
      }
      return send(res, 200, JSON.stringify({ ok: true, ms }));
    } catch (e) {
      const c = e.cause || {};
      const why = e.name === 'TimeoutError' ? 'timed out after 30s'
        : (c.code || c.message) ? `${c.code ? `${c.code}: ` : ''}${c.message || ''}`.trim()
        : e.message;
      return send(res, 200, JSON.stringify({ ok: false, ms: Date.now() - started, error: why }));
    }
  }

  // The launcher opens a console window that is easy to forget. This is the switch
  // for it: answer first, then exit, so the browser gets the reply.
  if (req.method === 'POST' && p === '/api/shutdown') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    send(res, 200, JSON.stringify({ ok: true }));
    console.log('\n  stopped from the page.\n');
    setTimeout(() => process.exit(0), 200);
    return;
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
      // The check runs whenever the client sent a mtime at all — 0 means "there was
      // no file when I loaded", which is exactly the case that must not silently
      // overwrite a file another writer created in the meantime.
      const before = readText(file);
      if (before !== null && Number.isFinite(payload.baseMtimeMs)) {
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

    // A doc that is not an object would be written straight to the file as
    // `"not-an-object"` — valid JSON, but not a settings file. Refused here.
    if (!payload.doc || typeof payload.doc !== 'object' || Array.isArray(payload.doc)) {
      return send(res, 400, JSON.stringify({ error: 'doc must be a JSON object' }));
    }
    const current = readSettings(file);

    // Stale-write guard: Claude Code writes this file live. Last-write-wins would
    // silently discard whatever landed since load. 409 keeps the client's draft.
    // Number.isFinite, not truthiness: baseMtimeMs 0 means the file was absent at
    // load, and a file that appeared since must be a conflict, not a free overwrite.
    if (current.exists && Number.isFinite(payload.baseMtimeMs) && Math.abs(current.mtimeMs - payload.baseMtimeMs) > 1) {
      return send(res, 409, JSON.stringify({ error: 'file changed on disk since you loaded it', mtimeMs: current.mtimeMs }));
    }

    const text = (current.bom ? '\uFEFF' : '') + JSON.stringify(payload.doc, null, 2).replace(/\n/g, current.eol || '\n') + (current.eol || '\n');
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
  // The selftest moved to tools/selftest.js (it needs the whole module, so keeping it
  // inline meant the server carried 600 lines of assertions). This flag stays because
  // it is in the README, the launcher and muscle memory — it just forwards.
  if (argv.includes('--selftest')) return require('./tools/selftest.js').run();

  const portArg = argv.indexOf('--port');
  const port = portArg > -1 ? Number(argv[portArg + 1]) : 8787;
  const open = argv.includes('--open');

  // `--port abc` used to reach net.listen as NaN and surface as a raw RangeError
  // stack. start.cmd now pauses on any non-zero exit, so a bad flag would park a
  // stack trace in front of a double-clicking user. One sentence instead.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`\n  "${argv[portArg + 1]}" is not a usable port. Try: node server.js --port 8787\n`);
    process.exit(1);
  }

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
    // "hidden" is a Windows-only property: the .vbs starts node with a hidden window.
    // Linux and macOS launch it like any other app, so the line must not claim it.
    console.log(process.platform === 'win32'
      ? `\n  It starts the server on port ${port} hidden and opens http://127.0.0.1:${port}\n`
      : `\n  It starts the server on port ${port} and opens http://127.0.0.1:${port}\n`);
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

// Run directly it is a server; required, it is the module its own tests and tools read.
module.exports = {
  spawnSync,
  spawn,
  stripTypeScriptTypes,
  missing,
  http,
  fs,
  path,
  os,
  HERE,
  INDEX,
  APP_TS,
  ICONS,
  configDir,
  hermesHome,
  codexHome,
  opencodeDir,
  MAX_BODY,
  appJs,
  detectEol,
  settingsFile,
  TOOLS,
  toolById,
  hasBin,
  toolList,
  toolPaths,
  PROVIDER,
  PROVIDER_LABEL,
  scanInfo,
  readSettings,
  BACKUPS,
  backupBeforeWrite,
  sleep,
  atomicWrite,
  readText,
  withV1,
  tomlString,
  tomlUnquote,
  tomlTopValue,
  tomlSectionValues,
  tomlSetTop,
  tomlSetSection,
  tomlSetInSection,
  codexKey,
  codexRead,
  codexWrite,
  jsoncParse,
  opencodeRead,
  opencodeWrite,
  HERMES_MODEL_RE,
  HERMES_DELEGATION_RE,
  HERMES_AUX_RE,
  HERMES_ROLES,
  hermesRoleRe,
  hermesBlockValue,
  hermesRead,
  hermesPatchBlock,
  hermesBuildBlock,
  hermesSetTopBlock,
  hermesSetRole,
  hermesWrite,
  envVarSet,
  readSimple,
  writeSimple,
  send,
  isUp,
  openBrowser,
  originOk,
  readBody,
  jsonBody,
  modelsUrl,
  chatUrl,
  psQuote,
  vbsLauncher,
  installShortcutWindows,
  execQuote,
  shQuote,
  installShortcutLinux,
  installShortcutMac,
  resolveDirArg,
  desktopDirWin,
  installShortcut,
  modelWindows,
  VISION_TRUE_TOKENS,
  visionFromModalities,
  VISION_BOOL_KEYS,
  VISION_MOD_KEYS,
  rowVision,
  modelVision,
  num,
  modelCaps,
  CONNECTIONS_MAX,
  connectionsFile,
  dpapi,
  secretsAtRest,
  protectSecret,
  revealSecret,
  cleanConnection,
  cleanConnectionRow,
  readConnections,
  writeConnections,
  handler,
  main,
};

if (require.main === module) main();
