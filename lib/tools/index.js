// Extracted from server.js — the tool registry and the simple-mode dispatch.
// This is the one module that knows all four tools by name; the per-format
// readers live beside it (claude.js, codex.js, opencode.js, hermes.js).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { configDir, hermesHome, codexHome, opencodeDir } = require('../paths.js');
const { readText, stripBom, detectEol, atomicWrite } = require('../fs-safe.js');
const { codexRead, codexWrite } = require('./codex.js');
const { jsoncParse, opencodeRead, opencodeWrite } = require('./opencode.js');
const { hermesRead, hermesWrite, envVarSet } = require('./hermes.js');

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

// The three simple-mode tools each own a config format with a real parser (TOML,
// YAML, JSONC). This project has no npm dependency and is not going to grow one for
// three files, so each format is handled with the narrowest possible text surgery:
// only the keys this editor owns are ever matched or replaced, and every other
// byte of the file is carried through untouched. The trade is that an exotic
// hand-written config — a multi-line TOML string, a model: block nested inside
// another key — may not be read back correctly. It is still never clobbered: a
// value that cannot be parsed reads as empty, and an empty field is not written.

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

module.exports = {
  TOOLS,
  toolById,
  hasBin,
  toolList,
  toolPaths,
  scanInfo,
  readSimple,
  writeSimple,
};
