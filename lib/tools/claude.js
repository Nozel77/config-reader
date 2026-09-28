// Extracted from server.js — Claude Code's env-mode reader (~/.claude/settings.json).
'use strict';

const fs = require('node:fs');
const { detectEol } = require('../fs-safe.js');

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

module.exports = { readSettings };
