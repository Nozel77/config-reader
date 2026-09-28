// The landing: the tool cards, the scan, and closing the editor. This module and
// editor.ts import each other (render ↔ renderTools); ES modules handle the cycle.
import { $, el, hideToast, confirmDialog } from './ui.js';
import type { Tool, ScanResponse } from './fields.js';
import {
  tool, tools, opened, dirty, setTool, setTools, setOpened, setDirty, setHome, setPlatform,
} from './state.js';
import { load } from './editor.js';
import { connectionsOpen } from './connections.js';

// One card per tool; picking one scans it and opens the editor. The installed badge
// is the one thing a user cannot read off the config file, and unknown stays silent.
export function renderTools(): void {
  // --i is the card's index, so the landing's entrance animation can stagger them.
  $('tool-picker').replaceChildren(...tools.map((t, i) => el('button', {
    class: `tool-card${t.id === tool.id && opened ? ' tool-card--selected' : ''}`,
    type: 'button',
    style: `--i:${i}`,
    'data-tool': t.id,
    'aria-pressed': String(t.id === tool.id && opened),
    onclick: () => { void openTool(t); },
  },
    el('img', { class: 'tool-card__icon', src: `/icon/${t.id}.png`, alt: '', width: '28', height: '28', loading: 'lazy' }),
    el('span', { class: 'tool-card__name', text: t.name }),
    t.installed === undefined ? null : el('span', {
      class: `badge tool-card__badge badge--${t.installed ? 'installed' : 'absent'}`,
      text: t.installed ? 'Installed' : 'Not found',
      title: t.installed
        ? `${t.bin} is on your PATH`
        : `${t.bin} is not on your PATH. Install it before pointing it at an endpoint`,
    }))));
}

// Picking a card is the only way in: it scans that tool and opens the editor.
export async function scan(): Promise<void> {
  const card = $('tool-picker').querySelector(`[data-tool="${tool.id}"]`) as HTMLElement | null;
  card?.classList.add('tool-card--busy');
  $('rail-note').textContent = '';
  try {
    const r = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: tool.id }),
    });
    const j: ScanResponse = await r.json();
    if (!r.ok) throw new Error((j as unknown as { error: string }).error || `HTTP ${r.status}`);
    setHome(j.home);
    setPlatform(j.platform);
    // The registry rides along with every scan, so an early picker gets corrected.
    if (j.tools) { setTools(j.tools); }
    await load();
  } catch (e) {
    $('rail-note').textContent = `Scan failed: ${(e as Error).message}`;
  } finally {
    card?.classList.remove('tool-card--busy');
    renderTools();
  }
}

// Back to the picker: the layout closes, the editor empties, nothing is fetched.
export function closeEditor(): void {
  setOpened(false);
  $('app').classList.remove('app--editor');
  $('editor').hidden = true;
  $('actionbar-dot').classList.remove('actionbar__dot--dirty');
  $('rail-note').textContent = '';
  hideToast();
  renderTools();
  // The landing is the URL with no tool on it, so a reload or a share does not
  // reopen a tool the visitor has already left.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// The open tool is the URL: #claude, #codex, … Pushing an entry on open means the
// browser's own Back closes the editor, Forward reopens it, and a link to a tool
// lands on that tool.
export const toolFromUrl = (): Tool | null => {
  const id = location.hash.slice(1);
  return tools.find(t => t.id === id) || null;
};

// Picking a tool, from a card, a link, or a Back/Forward step. `keepUrl` is for the
// history handler: a cancelled confirm has to put the entry back, or the URL would
// say one tool while the screen shows another.
export async function openTool(t: Tool, keepUrl = false): Promise<void> {
  if (t.id === tool.id && opened) return;
  if ((dirty || connectionsOpen()) && !(await confirmDialog({
    title: 'Discard unsaved changes?',
    message: 'Opening another tool drops the edits in this form.',
    confirmLabel: 'Discard and switch',
  }))) {
    if (keepUrl) history.pushState({ tool: tool.id }, '', `#${tool.id}`);
    return;
  }
  setDirty(false);
  setTool(t);
  $('rail-note').textContent = '';
  void scan();
}

// The URL is the routing table: Back closes the editor, Forward reopens it.
addEventListener('popstate', async () => {
  const t = toolFromUrl();
  if (t) { await openTool(t, true); return; }
  if ((dirty || connectionsOpen()) && !(await confirmDialog({
    title: 'Discard unsaved changes?',
    message: 'Going back to the tool list drops the edits in this form.',
    confirmLabel: 'Discard and go back',
  }))) {
    history.pushState({ tool: tool.id }, '', `#${tool.id}`);
    return;
  }
  setDirty(false);
  closeEditor();
});
