// Extracted from server.js — Claude Code's env-mode reader (~/.claude/settings.json).
'use strict';

const fs = require('node:fs');
const { detectEol } = require('../fs-safe.js');

// A settings file is strict JSON — Claude Code's own docs say "a `//` comment or a
// trailing comma is a syntax error". The two are also the mistakes a hand-edited
// file actually makes, and V8 reports both as the same opaque sentence ("Expected
// double-quoted property name"), which says nothing about the cause. So look at the
// offending line and name it: the raw message stays, this only adds the why.
function parseHint(body, message) {
  const m = /position (\d+)/.exec(message);
  const at = m ? Number(m[1]) : -1;

  // Smart quotes are worth naming on their own: an editor that "helpfully" curls
  // quotes produces a file no JSON parser will ever read, comments or not.
  if (/[“”‘’]/.test(body)) {
    return 'This file contains curly quotes (“ ” ‘ ’). A JSON file needs straight ones (").';
  }

  if (at >= 0) {
    // The line the parser stopped on, and the line before it — a trailing comma is
    // reported on the line *after* the comma, so the comma is not on this one.
    const before = body.slice(0, at);
    const lineStart = before.lastIndexOf('\n') + 1;
    const lineEnd = body.indexOf('\n', at);
    const line = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd);
    if (/^\s*(\/\/|\/\*)/.test(line)) {
      return 'This line is a comment. Claude Code parses this file as strict JSON, so a // or /* comment is a syntax error there too.';
    }
    // Walk back over whitespace: if the last thing before the error is a comma, the
    // parser is sitting where the next property should have been.
    const trimmed = before.replace(/\s+$/, '');
    if (trimmed.endsWith(',')) {
      return 'There is a trailing comma before this point. Claude Code parses this file as strict JSON, so a trailing comma is a syntax error there too.';
    }
  }
  return null;
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
    return { file, exists: true, raw, parsed: null, eol, mtimeMs: st.mtimeMs, normalized: false, parseError: e.message, parseHint: parseHint(body, e.message), bom };
  }
}

module.exports = { readSettings, parseHint };
