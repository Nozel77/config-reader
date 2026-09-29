// CONFIG READER — the frontend entry point. The landing picks a tool; the form
// edits that file's `env` object and posts the whole document back. Served as
// /app.js by type stripping; the modules under app/ are served the same way.
//
// Imports name the served URL (/app/x.js); the source of each is app/x.ts.
import { $, el, icon, outsideClick, confirmDialog } from './app/ui.js';
import { initTheme } from './app/theme.js';
import { KNOWN } from './app/fields.js';
import type { Tool } from './app/fields.js';
import {
  conns, dirty, tool, connsDirty,
  setDirty, setConnsDirty, setConnsError, setFilter, setOnly1m, setOnlyVision, setEnv, setTools,
} from './app/state.js';
import { load, save, otherRow, refreshCard } from './app/editor.js';
import { renderTools, toolFromUrl, openTool, closeEditor } from './app/landing.js';
import { closePicker, renderModels, loadModels } from './app/models.js';
import { openRaw, closeRaw, copyRaw, editRaw, cancelRaw, saveRaw, rawDirty } from './app/raw.js';
import {
  openConnections, closeConnections, captureFromForm, saveConnections,
  renderConnections, connInput,
} from './app/connections.js';

// ---------------------------------------------------------------- wire up

// Reload runs from the editor, so a failure belongs in its banners, not the rail note.
function reload(): void {
  const btn = $('reload') as HTMLButtonElement;
  btn.disabled = true;
  btn.classList.add('button--busy');
  load()
    .catch(e => {
      $('editor-banners').replaceChildren(
        el('div', { class: 'banner banner--error' }, `Failed to load: ${(e as Error).message}`));
    })
    .finally(() => {
      btn.classList.remove('button--busy');
      btn.disabled = false;
    });
}

$('reload').addEventListener('click', async () => {
  if (dirty && !(await confirmDialog({
    title: 'Discard unsaved changes?',
    message: 'Reloading reads the file from disk again. The edits in this form are dropped.',
    confirmLabel: 'Discard and reload',
  }))) return;
  reload();
});

$('save').addEventListener('click', () => { void save(); });

// The button only exists while the editor is open, so it needs no state check. It
// always lands on the picker: the sidebar's way out is the landing page, not one
// step back through whatever tools were opened before.
$('editor-back').addEventListener('click', async () => {
  if (dirty && !(await confirmDialog({
    title: 'Discard unsaved changes?',
    message: 'Going back to the tool list drops the edits in this form.',
    confirmLabel: 'Discard and go back',
  }))) return;
  setDirty(false);
  closeEditor();
});

$('other-vars-add').addEventListener('click', () => {
  if (tool.mode === 'simple') return;   // the section is not offered for these tools
  const input = $('other-vars-new') as HTMLInputElement;
  const k = input.value.trim();
  if (!k) return;
  // A name this editor already owns clears that field's card instead.
  if (KNOWN.has(k)) { setEnv(k, ''); refreshCard(k); return; }
  // Rows, not env: an untouched new row has no value in env yet, so env cannot tell
  // "listed" from "not listed" and asking twice would stack a second row.
  const listed = [...$('other-vars-list').children].map(c => c.getAttribute('data-key'));
  if (listed.includes(k)) return;
  input.value = '';
  $('other-vars').hidden = false;
  $('other-vars-list').append(otherRow(k));
  $('other-vars-count').textContent = String($('other-vars-list').children.length);
});

$('other-vars-new').addEventListener('keydown', (e: Event) => {
  if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); $('other-vars-add').click(); }
});

$('model-picker-reload').addEventListener('click', () => { void loadModels(true); });

// The raw view reads the file straight off disk, so it is deliberately not gated on
// unsaved edits: seeing what is on disk while a draft sits in the form is the point.
// It does ask before it starts editing, because that is the gesture that drops the form.
$('raw-open').addEventListener('click', openRaw);
$('raw-copy').addEventListener('click', copyRaw);
$('raw-edit').addEventListener('click', () => { void editRaw(); });
$('raw-cancel').addEventListener('click', () => { void cancelRaw(); });
$('raw-save').addEventListener('click', () => { void saveRaw(); });
// Closing with a draft asks first — an edited file is worth more than a click.
async function closeRawUnlessDirty(): Promise<void> {
  if (rawDirty() && !(await confirmDialog({
    title: 'Discard the edits?',
    message: 'The changes in this editor are dropped. The file on disk is untouched.',
    confirmLabel: 'Discard edits',
  }))) return;
  closeRaw();
}
$('raw-close').addEventListener('click', () => { void closeRawUnlessDirty(); });
$('raw').addEventListener('cancel', (e: Event) => { e.preventDefault(); void closeRawUnlessDirty(); });
$('raw').addEventListener('click', outsideClick('raw', () => { void closeRawUnlessDirty(); }));

$('model-picker-close').addEventListener('click', closePicker);

// A click outside the panel closes it.
$('model-picker').addEventListener('click', outsideClick('model-picker', closePicker));

$('model-picker-filter').addEventListener('input', (e: Event) => {
  setFilter((e.target as HTMLInputElement).value);
  renderModels();
});

$('filter-1m').addEventListener('change', (e: Event) => {
  setOnly1m((e.target as HTMLInputElement).checked);
  renderModels();
});

$('filter-vision').addEventListener('change', (e: Event) => {
  setOnlyVision((e.target as HTMLInputElement).checked);
  renderModels();
});

addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Fetched once at boot, so the picker comes from the server's list rather than a copy.
// A failure is not fatal: the scan that follows carries the registry anyway.
async function loadTools(): Promise<void> {
  try {
    const r = await fetch('/api/tools');
    if (!r.ok) return;
    const j: { tools?: Tool[] } = await r.json();
    if (Array.isArray(j.tools) && j.tools.length) { setTools(j.tools); renderTools(); }
  } catch { /* the landing still works with the default tool */ }
  // A link to a tool opens that tool, once the registry that names it has arrived.
  const t = toolFromUrl();
  if (t) void openTool(t);
}

// One scroll listener drives both the back-to-top button and the header's stuck state.
const topBtn = $('to-top');
const actionbar = $('actionbar');
const scrollPos = (): number =>
  typeof scrollY === 'number' ? scrollY : document.documentElement?.scrollTop || 0;

function onScroll(): void {
  const y = scrollPos();
  topBtn.classList.toggle('to-top--shown', y > 400);
  actionbar.classList.toggle('actionbar--stuck', y > 8);
}
addEventListener('scroll', onScroll, { passive: true });

$('to-top').addEventListener('click', () => {
  if (typeof scrollTo !== 'function') return;
  let calm = false;
  try { calm = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* no matchMedia */ }
  scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' });
});

// The launcher opens a console window that is easy to forget, so the page can close
// it. Confirm first: there is no way back from here except starting it again.
$('stop-server').addEventListener('click', async () => {
  if (!(await confirmDialog({
    title: 'Stop the server?',
    message: 'The page stops working until you start the server again.',
    confirmLabel: 'Stop server',
  }))) return;
  fetch('/api/shutdown', { method: 'POST' })
    .then(() => {
      document.body.innerHTML = '';
      document.body.append(el('div', { class: 'loading' }, 'Server stopped. You can close this tab.'));
    })
    .catch(() => { /* the server went down before the reply landed; that is the point */ });
});

// Open on the picker. Picking a card is the entry point — there is no Scan button
// and no second page, so nothing else needs booting.
initTheme();
$('model-picker-close').append(icon('xmark'));
$('model-picker-reload').append(icon('refresh'));
$('connections-close').append(icon('xmark'));
$('raw-close').append(icon('xmark'));
$('raw-copy').append(icon('copy'));
$('to-top').append(icon('arrowUp'));
$('stop-server').prepend(icon('power'));
$('connections-open').addEventListener('click', openConnections);
// Closing the connections dialog with unsaved rows asks first; only a confirmed
// discard is what lets the working copy go.
async function closeConnectionsUnlessDirty(): Promise<void> {
  if (connsDirty && !(await confirmDialog({
    title: 'Discard unsaved endpoints?',
    message: 'The changes in this dialog are lost.',
    confirmLabel: 'Discard endpoints',
  }))) return;
  setConnsDirty(false);
  closeConnections();
}

$('connections-close').addEventListener('click', () => { void closeConnectionsUnlessDirty(); });
// Escape closes a dialog without asking. This editor never throws a typed token away
// silently, so the cancel is intercepted and the confirm decides.
$('connections').addEventListener('cancel', (e: Event) => {
  e.preventDefault();
  void closeConnectionsUnlessDirty();
});
$('connections').addEventListener('click', outsideClick('connections', () => { void closeConnectionsUnlessDirty(); }));
$('connections-new').addEventListener('click', () => {
  conns.push({ name: '', baseUrl: '', model: '', hasKey: false });
  setConnsDirty(true);
  setConnsError('');
  renderConnections();
  ($('connections-save') as HTMLButtonElement).disabled = false;
  connInput(conns.length - 1, 'name')?.focus();
});
// The form is often already configured — by hand, by another tool, or by an earlier
// session. Reading it back is one gesture instead of retyping three values.
$('connections-capture').addEventListener('click', captureFromForm);
$('connections-save').addEventListener('click', () => { void saveConnections(); });
renderTools();
void loadTools();
onScroll();
