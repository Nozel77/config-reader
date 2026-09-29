// The raw view: the file as it sits on disk, with every key — not just the ones the
// form has a field for. "Everything else round-trips untouched" is the promise the
// editor makes; this is the screen where that promise can actually be checked.
import { $, el, toast, confirmDialog } from './ui.js';
import { tool, prettyPath, dirty, setDirty } from './state.js';
import { load } from './editor.js';

// The reply of GET /api/raw. One entry per file the tool is edited through: Claude
// Code, Codex and OpenCode have one, Hermes has two (config.yaml and the .env its key
// lives in).
export interface RawFile {
  id: string;          // the basename, which is also the tab's label
  file: string;
  text: string;
  exists: boolean;
  readError: string | null;   // EACCES and friends; null when the read was fine
  format: 'json' | 'toml' | 'yaml' | 'dotenv';
  secrets: number[];          // 1-based lines that look like they hold a token
  parseError: { message: string; hint: string | null; line: number; position: number } | null;
}
export interface RawResponse { tool?: string; file?: string; eol?: string; files?: RawFile[]; error?: string }

// Module-local: the dialog is the only reader, so this does not belong in the shared
// state module. `view` is which file is showing, `tab` which half of the toggle.
let data: RawFile[] = [];
let view = 0;
let tab: 'raw' | 'error' = 'raw';
let loading = false;

// The draft, and the mtime it was loaded at. `draft === null` means "not editing":
// the dialog is then a view of the file and there is nothing to save.
let draft: string | null = null;
let baseMtime = 0;
let saving = false;

// ---------------------------------------------------------------- the tokenizer

export interface Tok { text: string; cls: string }

// A word character for the bare-key rule: `model`, `base_url`, `ANTHROPIC_BASE_URL`.
const WORD = /[A-Za-z0-9_$.\-]/;

// Where a comment starts. `#` and `//` only count at the start of the line or after
// whitespace, which is what keeps `base_url: http://localhost:20128/v1` from turning
// its own scheme into a comment — the `//` there follows a `:`.
function commentAt(line: string, i: number): boolean {
  if (line[i] === '#') return i === 0 || /\s/.test(line[i - 1]);
  if (line[i] === '/' && line[i + 1] === '/') return i === 0 || /\s/.test(line[i - 1]);
  return false;
}

// One line into coloured runs. Deliberately not a parser: the four formats this editor
// writes agree on a key, a separator, a value and a comment marker, and that is the
// whole vocabulary the view needs. A line it reads wrong is still shown verbatim —
// only the colour is wrong, never the text.
export function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  const n = line.length;
  let i = 0;
  let head = true;   // nothing but whitespace seen yet

  const push = (text: string, cls: string): void => { out.push({ text, cls }); };

  while (i < n) {
    const c = line[i];

    if (c === ' ' || c === '\t') {
      let j = i;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
      push(line.slice(i, j), 'ws');
      i = j;
      continue;
    }

    if (commentAt(line, i)) { push(line.slice(i), 'comment'); break; }

    // A TOML section header, or a JSON array/object bracket. Only a `[` that opens the
    // line's content is a section; the rest are punctuation.
    if (c === '[' && head) {
      const j = line.indexOf(']', i);
      if (j !== -1) { push(line.slice(i, j + 1), 'section'); i = j + 1; head = false; continue; }
    }

    // A quoted string. `"` honours backslash escapes; `'` does not, which is the rule
    // in all four formats.
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\' && c === '"') { j += 2; continue; }
        if (line[j] === c) { j++; break; }
        j++;
      }
      const text = line.slice(i, j);
      // A string with only a colon after it is a key — JSON's one shape. Everything
      // else is a value, including a string that merely contains a colon.
      const isKey = /^\s*:/.test(line.slice(j));
      push(text, isKey ? 'key' : 'str');
      i = j;
      head = false;
      continue;
    }

    // A bare word at the head of the line, with a `:` or `=` after it, is a key: that
    // is YAML, TOML and dotenv between them.
    if (head && WORD.test(c)) {
      let j = i;
      while (j < n && WORD.test(line[j])) j++;
      const word = line.slice(i, j);
      const isKey = /^\s*[:=]/.test(line.slice(j));
      push(word, isKey ? 'key' : 'word');
      i = j;
      head = false;
      continue;
    }

    // Numbers, booleans and null get their own colour; everything else is punctuation.
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9._eE+\-]/.test(line[j])) j++;
      push(line.slice(i, j), 'num');
      i = j;
      continue;
    }
    if (head || /[\s[{,(:=]/.test(line[i - 1] || ' ')) {
      const m = /^(true|false|null|~)\b/.exec(line.slice(i));
      if (m) { push(m[1], 'bool'); i += m[1].length; head = false; continue; }
    }

    push(c, 'punct');
    i++;
    head = false;
  }
  return out;
}

// ---------------------------------------------------------------- the rendering

// The lines of a file, with a trailing newline not counted as one. Both the gutter and
// the "N lines" note read this, so the count on screen always matches the rows below it.
export function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// `1234` -> `1.2 KB`. Sizes here are small, so the two units are the whole range.
const fmtSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

const FORMAT_LABEL: Record<string, string> = {
  json: 'JSON', toml: 'TOML', yaml: 'YAML', dotenv: 'dotenv',
};

// One line of the file: the number, then the coloured runs. Built as elements rather
// than markup so nothing in a config file can ever be read as HTML.
function codeLine(line: string, no: number, mark: boolean, secret: boolean): HTMLElement {
  const code = el('span', { class: 'raw__code' },
    ...tokenize(line).map(t => (t.cls === 'ws' ? t.text : el('span', { class: `tok tok--${t.cls}`, text: t.text }))));
  return el('div', {
    class: `raw__line${mark ? ' raw__line--mark' : ''}${secret ? ' raw__line--secret' : ''}`,
    'data-line': String(no),
  },
    el('span', { class: 'raw__no', text: String(no), 'aria-hidden': 'true' }),
    code);
}

// The code view for one file. A file that is not there says so instead of showing an
// empty box: "not created yet" and "empty file" are different states.
function codeView(f: RawFile, markLine: number): HTMLElement {
  if (!f.exists) {
    return el('div', { class: 'empty-state' },
      el('b', { class: 'empty-state__title', text: f.readError ? `Could not read ${f.id}` : `${f.id} does not exist yet` }),
      f.readError ? `The read failed with ${f.readError}.` : 'Nothing is at this path. A save creates it.');
  }
  const lines = linesOf(f.text);
  const secrets = new Set(f.secrets);
  return el('div', { class: 'raw__code-body' },
    ...lines.map((l, i) => codeLine(l, i + 1, i + 1 === markLine, secrets.has(i + 1))));
}

// The Error tab: the parser's own sentence, the plain-language hint when this project
// can name the mistake, and the code with the line it stopped on marked. For a file
// that parses — or a format this editor patches by text surgery and never parses — it
// says that instead of inventing a diagnosis.
function errorView(f: RawFile): HTMLElement {
  if (!f.parseError) {
    const surgical = f.format === 'toml' || f.format === 'yaml' || f.format === 'dotenv';
    return el('div', { class: 'empty-state' },
      el('b', { class: 'empty-state__title', text: f.exists ? `${f.id} parses clean` : `${f.id} is not there` }),
      surgical
        ? 'This editor patches this format key by key and never parses it whole, so there is no parse error to report.'
        : 'The parser read it without complaint. Nothing to fix here.');
  }
  const e = f.parseError;
  return el('div', { class: 'raw__error' },
    el('div', { class: 'banner banner--error' },
      el('b', { text: 'This file is not valid. ' }),
      e.hint ? el('span', {}, e.hint, ' ') : null,
      el('span', { class: 'banner__detail' }, e.message)),
    e.line
      ? el('p', { class: 'note raw__error-at' },
        `The parser stopped on line ${e.line}${e.position >= 0 ? `, at character ${e.position}` : ''}.`)
      : null,
    // The code again, with the line marked — the diagnostic is only useful next to the
    // text it is about.
    codeView(f, e.line));
}

// The warning the "no masking" choice owes the reader: the text is verbatim by design,
// so say plainly when it holds something worth not putting on a screen share.
function secretNote(f: RawFile): HTMLElement | null {
  if (!f.secrets.length) return null;
  const n = f.secrets.length;
  return el('div', { class: 'banner banner--warn raw__secret' },
    el('b', { text: `${n} line${n === 1 ? '' : 's'} here look${n === 1 ? 's' : ''} like a token. ` }),
    'The file is shown exactly as it is written, so anything in it is on screen. The marked lines are highlighted.');
}

// One tab per file. A single-file tool draws no tab row at all.
function tabRow(): HTMLElement | null {
  if (data.length < 2) return null;
  return el('div', { class: 'raw__tabs', role: 'tablist' },
    ...data.map((f, i) => el('button', {
      class: `raw__tab${i === view ? ' raw__tab--on' : ''}`, type: 'button', role: 'tab',
      'aria-selected': String(i === view), 'data-raw-tab': String(i),
      onclick: () => { view = i; renderRaw(); },
    }, f.id)));
}

// Raw | Error. The toggle only earns its place when there is an error to show, but it
// stays put once the file is broken so the two views can be compared. Hidden while
// editing: a draft is not a file yet, so there is nothing for a parser to have said
// about it.
function toggleRow(f: RawFile): HTMLElement {
  const seg = (id: 'raw' | 'error', label: string): HTMLElement =>
    el('button', {
      class: `raw__seg${tab === id ? ' raw__seg--on' : ''}`, type: 'button',
      'aria-pressed': String(tab === id), 'data-raw-seg': id,
      onclick: () => { tab = id; renderRaw(); },
    }, label);
  const segs = el('div', { class: 'raw__segs', role: 'group', 'aria-label': 'Which view' },
    seg('raw', 'Raw'), seg('error', 'Error'));
  segs.hidden = draft !== null;
  return el('div', { class: 'raw__bar' },
    segs,
    el('span', { class: 'note raw__meta', text: `${FORMAT_LABEL[f.format] || f.format} · ${linesOf(f.text).length} lines · ${fmtSize(f.text.length)}` }));
}

// The textarea an edit happens in. Plain monospace, no colouring: a contenteditable
// overlay would be the only way to keep the highlighting live, and a config file is
// short enough that the colour is worth less than a caret that behaves like a caret.
function editView(f: RawFile): HTMLElement {
  const box = el('textarea', {
    class: 'raw__edit', 'data-raw-edit': f.id, spellcheck: 'false', autocomplete: 'off',
    'aria-label': `${f.id} contents`,
    oninput: (e: Event) => {
      const v = (e.target as HTMLTextAreaElement).value;
      draft = v;
      drafts[f.id] = v;
      markRawDirty();
    },
  }) as HTMLTextAreaElement;
  box.value = draft ?? '';
  return box;
}

// Every file the tool is edited through has to be saved together: Hermes' key lives in
// .env and its config in the YAML, and a half-applied pair is worse than no save. The
// draft is therefore per file, and Save walks the list.
//
// `drafts` is the live working copy — a keystroke updates it, not just the visible
// textarea — because "is this dirty?" is asked of the whole set, not of one box.
let drafts: Record<string, string> = {};

function markRawDirty(): void {
  const d = rawDirty();
  ($('raw-save') as HTMLButtonElement).disabled = !d;
  $('raw-dot').classList.toggle('actionbar__dot--dirty', d);
}

export function renderRaw(): void {
  const list = $('raw-body');
  const f = data[view];
  if (!f) {
    list.replaceChildren(el('div', { class: 'loading' },
      el('span', { class: 'loading__spinner' }), 'Reading the file…'));
    return;
  }
  $('raw-title').textContent = f.id;
  $('raw-sub').textContent = prettyPath(f.file);
  ($('raw-sub') as HTMLElement).title = f.file;

  const editing = draft !== null;
  const body: HTMLElement[] = [];
  const tabs = tabRow();
  if (tabs) body.push(tabs);
  // While editing, the toggle goes: a draft is not a file yet, so there is nothing for a
  // parser to have said about it. The meta line stays — it is where the format shows.
  body.push(editing
    ? el('div', { class: 'raw__bar' },
      el('span', { class: 'note raw__meta', text: `${FORMAT_LABEL[f.format] || f.format} · editing` }))
    : toggleRow(f));
  const note = secretNote(f);
  if (note) body.push(note);
  // A file that cannot be read has nothing to edit; the state view says why.
  if (editing && !f.readError) body.push(editView(f));
  else if (tab === 'error') body.push(errorView(f));
  else body.push(codeView(f, -1));
  list.replaceChildren(...body);

  // The header controls follow the mode: view offers Edit and Copy, edit offers Cancel
  // and Save. One row either way, so the dialog never reflows on the switch.
  ($('raw-edit') as HTMLButtonElement).hidden = editing || !f.exists;
  ($('raw-copy') as HTMLButtonElement).hidden = editing;
  ($('raw-copy') as HTMLButtonElement).disabled = !f.exists || !f.text;
  ($('raw-cancel') as HTMLButtonElement).hidden = !editing;
  ($('raw-save') as HTMLButtonElement).hidden = !editing;
  ($('raw-save') as HTMLButtonElement).disabled = saving || !rawDirty();
  $('raw-dot').hidden = !editing;
  $('raw-dot').classList.toggle('actionbar__dot--dirty', editing && rawDirty());
}

// Enter edit mode. The form's unsaved edits go first: this dialog writes the file as
// text, and a form draft left in memory would be silently overwritten by the next save
// from here. Asking is the only honest way to hold both.
export async function editRaw(): Promise<void> {
  const f = data[view];
  if (!f || !f.exists || draft !== null) return;
  if (dirty && !(await confirmDialog({
    title: 'Edit the file directly?',
    message: 'The form has unsaved changes. Editing here drops them, because this dialog writes the file as text.',
    confirmLabel: 'Drop the edits and edit',
  }))) return;
  setDirty(false);
  drafts = {};
  for (const file of data) drafts[file.id] = file.text;
  draft = drafts[f.id] ?? '';
  // The mtime the draft was built from, so the write can tell if the file moved under it.
  baseMtime = 0;
  try {
    const r = await fetch(`/api/settings?tool=${encodeURIComponent(tool.id)}`);
    const j = await r.json();
    if (typeof j.mtimeMs === 'number') baseMtime = j.mtimeMs;
  } catch { /* no mtime means no stale guard; the write still goes */ }
  renderRaw();
  const box = document.querySelector('[data-raw-edit]') as HTMLTextAreaElement | null;
  box?.focus();
}

// Leaving edit mode without writing. The dialog is closed on the way out, so a draft
// cannot outlive the gesture that made it.
export async function cancelRaw(): Promise<void> {
  if (draft === null) return;
  if (!(await confirmDialog({
    title: 'Discard the edits?',
    message: 'The changes in this editor are dropped. The file on disk is untouched.',
    confirmLabel: 'Discard edits',
  }))) return;
  draft = null;
  drafts = {};
  renderRaw();
}

export function openRaw(): void {
  const dlg = $('raw') as unknown as HTMLDialogElement;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  view = 0;
  tab = 'raw';
  draft = null;
  drafts = {};
  void loadRaw();
}

export function closeRaw(): void {
  draft = null;
  drafts = {};
  const dlg = $('raw') as unknown as HTMLDialogElement;
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
}

// Is there a draft worth asking about before the dialog goes away?
export const rawDirty = (): boolean => draft !== null && data.some(f => drafts[f.id] !== f.text);

// The save. Every file the tool owns goes in one request per file, so a failure names
// the file it happened on rather than leaving the pair half-written and unexplained.
export async function saveRaw(): Promise<void> {
  if (draft === null || saving) return;
  const changed = data.filter(f => drafts[f.id] !== f.text);
  if (!changed.length) { toast('nothing changed'); return; }

  saving = true;
  ($('raw-save') as HTMLButtonElement).disabled = true;
  ($('raw-save') as HTMLButtonElement).classList.add('button--busy');
  try {
    for (const f of changed) {
      const r = await fetch('/api/raw', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: tool.id, id: f.id, text: drafts[f.id], baseMtimeMs: baseMtime }),
      });
      const j: { error?: string; bytes?: number; mtimeMs?: number; backup?: string | null } = await r.json();
      if (r.status === 409) {
        // Keep the draft: reloading here would throw away what was just typed.
        toast(`${f.id} was not saved: the file changed on disk. Reload to see it.`, 'error');
        return;
      }
      if (!r.ok) throw new Error(`${f.id}: ${j.error || `HTTP ${r.status}`}`);
      if (typeof j.mtimeMs === 'number') baseMtime = j.mtimeMs;
    }
    draft = null;
    drafts = {};
    $('raw-dot').classList.remove('actionbar__dot--dirty');
    renderRaw();
    toast(`saved ${changed.map(f => f.id).join(', ')}`);
    // The form holds the file this dialog just replaced. Reloading it here is what keeps
    // the two views from disagreeing about what is on disk.
    await load();
  } catch (e) {
    toast(`not saved: ${(e as Error).message}`, 'error');
  } finally {
    saving = false;
    ($('raw-save') as HTMLButtonElement).classList.remove('button--busy');
    ($('raw-save') as HTMLButtonElement).disabled = false;
  }
}

async function loadRaw(): Promise<void> {
  if (loading) return;
  loading = true;
  data = [];
  renderRaw();
  try {
    const r = await fetch(`/api/raw?tool=${encodeURIComponent(tool.id)}`);
    const j: RawResponse = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    data = j.files || [];
    if (!data.length) throw new Error('the server returned no file for this tool');
  } catch (e) {
    data = [];
    $('raw-body').replaceChildren(el('div', { class: 'empty-state' },
      el('b', { class: 'empty-state__title', text: 'Could not read the file' }),
      (e as Error).message));
    $('raw-title').textContent = 'Raw view';
    $('raw-sub').textContent = '';
    loading = false;
    return;
  }
  loading = false;
  renderRaw();
}

// The clipboard holds the file exactly as the dialog shows it — the same bytes the
// save would write back.
export function copyRaw(): void {
  const f = data[view];
  if (!f || !f.exists) return;
  try {
    void navigator.clipboard.writeText(f.text);
    toast(`copied ${f.id} (${fmtSize(f.text.length)})`);
  } catch {
    toast('this browser will not give the page the clipboard', 'error');
  }
}
