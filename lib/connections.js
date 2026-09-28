// Extracted from server.js — the saved-endpoint store. Never throws: a missing
// file is the first-run case, and a hand-broken one must not take the page down.
'use strict';

const fs = require('node:fs');
const { str } = require('./util.js');
const { stripBom, atomicWrite } = require('./fs-safe.js');
const { connectionsFile } = require('./paths.js');

// Saved endpoints: the three values every tool asks for — base URL, token, default
// model — typed once and applied to any tool's form. One file, under the home dir so
// a re-clone does not take the tokens with it. The path is derived here; the browser
// never sends one.
const CONNECTIONS_MAX = 50;

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
  const rows = profiles.map(cleanConnectionRow).filter(Boolean).slice(0, CONNECTIONS_MAX);
  // One stable order: the store is written sorted by name, so an edit never reshuffles
  // the file and a diff shows only what changed.
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const doc = { version: 1, profiles: rows };
  atomicWrite(connectionsFile(), `${JSON.stringify(doc, null, 2)}\n`);
  // POSIX only. On Windows chmod flips one read-only bit and does nothing else — the
  // measured answer is 666 either way — so this is a real restriction on Linux/WSL/
  // macOS and a no-op here.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(connectionsFile(), 0o600); } catch { /* best effort */ }
  }
  return doc;
}

module.exports = {
  CONNECTIONS_MAX,
  cleanConnection,
  cleanConnectionRow,
  readConnections,
  writeConnections,
};
