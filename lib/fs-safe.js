// Extracted from server.js — atomic writes, backup rotation, and the small
// text helpers the readers share.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Claude Code writes LF on every platform (verified on Windows). Detect per file
// anyway rather than trusting that — a CRLF file must not be silently rewritten.
const detectEol = text => (text.includes('\r\n') ? '\r\n' : '\n');

// A BOM is not part of the JSON, but Notepad and a few Windows editors write one.
// Stripping it here means the file parses, the editor can edit it, and the BOM is put
// back on write — otherwise a valid file would be reported as broken and refuse to
// save. Kept separate from `raw` so the round-trip comparison stays honest.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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

function readText(file) {
  try { return stripBom(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

module.exports = {
  detectEol,
  stripBom,
  BACKUPS,
  backupBeforeWrite,
  sleep,
  atomicWrite,
  readText,
};
