// Extracted from server.js — the raw view's reader. One route hands the browser the
// file as it sits on disk, plus where the parser stopped when it will not parse.
//
// This module owns no path: it is handed one. The browser names a tool, the registry
// derives the file, and this only reads it.
'use strict';

const fs = require('node:fs');
const { detectEol, stripBom } = require('./fs-safe.js');

// The line a byte offset falls on, 1-based. Counted from the body rather than read out
// of V8's message: Node 24 prints "(line 5 column 5)" but Node 22.13 — this project's
// floor — prints the position alone, and one rule beats two branches.
function lineAt(body, offset) {
  if (typeof offset !== 'number' || offset < 0) return 0;
  let line = 1;
  for (let i = 0; i < offset && i < body.length; i++) if (body.charCodeAt(i) === 10) line++;
  return line;
}

// The byte offset V8 named, or -1. Both spellings in the wild start the same way.
function errorPosition(message) {
  const m = /position (\d+)/.exec(String(message || ''));
  return m ? Number(m[1]) : -1;
}

// Everything the Error tab needs about a file that would not parse. `hint` is the
// plain-language sentence when the mistake is one this project can name, `null` when
// it cannot — a confident wrong answer is worse than the parser's own words.
function parseErrorOf(body, message, hint) {
  const at = errorPosition(message);
  return { message: String(message || ''), hint: hint || null, line: lineAt(body, at), position: at };
}

// Which lines hold a secret, 1-based. The file is shown verbatim by choice, so this is
// not a mask — it is what lets the dialog say "this file holds a token" before anyone
// screenshots it.
//
// Two rules, both deliberately narrow. A named key is matched by its own name, so a
// token parked under a key nobody listed is simply not flagged — a wrong flag on a
// harmless line would teach people to ignore the banner. `longValue` only catches the
// machine-generated shapes (a JWT, a `sk-` key, a 40+ character run) because a hand
// written `"model": "provider/..."` must never be mistaken for one.
const SECRET_KEY = /(auth[_-]?token|authorization|api[_-]?key|bearer|secret|passwd|password|credential|access[_-]?token)/i;
const LONG_VALUE = /["']?(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{40,})["']?/;

function secretLines(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A line with no value is a key waiting to be filled, not a secret.
    const eq = line.indexOf('=');
    const colon = line.indexOf(':');
    const cut = eq === -1 ? colon : colon === -1 ? eq : Math.min(eq, colon);
    const key = cut === -1 ? line : line.slice(0, cut);
    if (cut !== -1 && SECRET_KEY.test(key)) { out.push(i + 1); continue; }
    if (LONG_VALUE.test(line)) out.push(i + 1);
  }
  return out;
}

// One file, as the dialog shows it. Never throws: a file that cannot be read comes back
// as `exists: false` with the reason, because a raw view that dies on a permissions
// error is worse than one that says so.
function readRaw(file) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return { file, exists: false, text: '', error: `${e.code || e.message}`, secrets: [] };
  }
  if (text === null) return { file, exists: false, text: '', error: null, secrets: [] };
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = stripBom(text);
  return { file, exists: true, text: body, eol: detectEol(body), bom, secrets: secretLines(body), error: null };
}

module.exports = { readRaw, secretLines, lineAt, errorPosition, parseErrorOf, SECRET_KEY, LONG_VALUE };
