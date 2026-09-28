// The saved-endpoints dialog.
import { $, el, icon, toast, outsideClick, confirmDialog } from './ui.js';
import { stripMarker } from './fields.js';
import type { Connection, ConnectionsResponse } from './fields.js';
import {
  conns, connsLoaded, connsDirty, connsError, connsAtRest, connsFile, opened, dirty, tool,
  setConns, setConnsLoaded, setConnsDirty, setConnsError, setConnsAtRest, setConnsFile,
  connKeys, connMatches, env, setEnv, prettyPath,
} from './state.js';
import { render } from './editor.js';

export function connInput(i: number, field: keyof Connection): HTMLInputElement | null {
  return document.querySelector(`[data-conn="${i}:${field}"]`) as HTMLInputElement | null;
}

export const connectionsOpen = (): boolean =>
  (($('connections') as unknown as HTMLDialogElement).open === true);

// One row is one endpoint. The name is the card's header — it is what the row is
// called, not one of the three values — and the three values sit under it in the
// order every tool asks for them: base URL, auth token, model.
function connRow(c: Connection, i: number): HTMLElement {
  const input = (key: keyof Connection, kind: 'text' | 'secret', placeholder: string, label: string): HTMLInputElement => {
    const box = el('input', {
      class: 'conn__input',
      type: kind === 'secret' ? 'password' : 'text',
      'data-conn': `${i}:${key}`,
      value: (c[key] as string) || '',
      placeholder,
      spellcheck: 'false',
      autocomplete: kind === 'secret' ? 'off' : '',
      'aria-label': `${label} for ${c.name || 'this endpoint'}`,
      oninput: (e: Event) => {
        (c[key] as string) = (e.target as HTMLInputElement).value;
        setConnsDirty(true);
        setConnsError('');
        ($('connections-save') as HTMLButtonElement).disabled = false;
        // The token controls only mean something once there is a token: an empty row
        // gets them on the first keystroke, a cleared row loses them again.
        if (key === 'apiKey') refreshConnRow(i, box.value !== '');
      },
    }) as HTMLInputElement;
    return box;
  };

  // The token's trailing controls are built once and shown/hidden as one, so the
  // input's width never jumps as they come and go.
  const apiInput = input('apiKey', 'secret', c.hasKey ? 'keep the stored token' : 'paste the token', 'Auth token');
  const eye = el('button', {
    class: 'button button--ghost button--icon button--small', type: 'button',
    title: 'reveal the token', 'aria-label': 'Show token',
  }, icon('eye')) as HTMLButtonElement;
  // A closure over the button rather than event.currentTarget: one less thing to be
  // true about the event, and the DOM shim in the checks does not carry it.
  eye.addEventListener('click', () => {
    const shown = apiInput.type === 'password';
    apiInput.type = shown ? 'text' : 'password';
    eye.replaceChildren(icon(shown ? 'eyeSlash' : 'eye'));
  });
  const apiTools = el('div', { class: 'conn__tools' }, eye);
  // Only worth offering where there is something to reveal.
  apiTools.hidden = !c.hasKey && !c.apiKey;

  const badges: HTMLElement[] = [];
  badges.push(c.hasKey || c.apiKey
    ? el('span', {
      class: 'badge badge--ok', text: 'token stored',
      title: connsAtRest ? 'encrypted at rest' : 'stored as plain text',
    })
    : el('span', { class: 'badge', text: 'no token' }));
  // Derived from the form, never stored: only worth saying while a tool is open.
  if (opened && connMatches(c)) badges.push(el('span', { class: 'badge badge--ok', text: 'in the form' }));

  const apply = el('button', {
    class: 'button button--ghost button--small conn__apply', type: 'button',
    title: `Fill ${tool.name}'s form from this endpoint`,
    'aria-label': `Apply ${c.name || 'this endpoint'} to ${tool.name}`,
  }, 'Apply') as HTMLButtonElement;
  apply.addEventListener('click', () => { void applyConnection(c, apply); });

  return el('section', { class: 'conn', 'data-conn-row': String(i) },
    el('div', { class: 'conn__head' },
      el('label', { class: 'conn__field conn__field--name' },
        el('span', { class: 'conn__label', text: 'Name' }),
        input('name', 'text', 'local gateway', 'Name')),
      el('div', { class: 'conn__badges' }, ...badges)),
    el('div', { class: 'conn__body' },
      el('label', { class: 'conn__field' },
        el('span', { class: 'conn__label', text: 'Base URL' }),
        input('baseUrl', 'text', 'http://localhost:20128/v1', 'Base URL')),
      el('label', { class: 'conn__field' },
        el('span', { class: 'conn__label', text: 'Auth token' }),
        el('div', { class: 'conn__row' }, apiInput, apiTools)),
      el('label', { class: 'conn__field' },
        el('span', { class: 'conn__label', text: 'Model' }),
        input('model', 'text', 'provider/model-id', 'Model'))),
    el('div', { class: 'conn__foot' },
      el('button', {
        class: 'button button--ghost button--icon button--small button--danger', type: 'button',
        title: `delete ${c.name || 'this endpoint'}`, 'aria-label': `Delete ${c.name || 'this endpoint'}`,
        onclick: () => {
          conns.splice(i, 1);
          setConnsDirty(true);
          renderConnections();
          ($('connections-save') as HTMLButtonElement).disabled = false;
        },
      }, icon('trash')),
      opened ? apply : null));
}

// Redraw one row in place. A token that appears or disappears changes which controls
// the row offers, and rebuilding the whole list would lose the caret mid-typing.
function refreshConnRow(i: number, hasTypedToken: boolean): void {
  const row = document.querySelector(`[data-conn-row="${i}"]`);
  const tools = row ? row.querySelector('.conn__tools') as HTMLElement | null : null;
  if (tools) tools.hidden = !hasTypedToken && !conns[i]?.hasKey;
}

// What the open tool's form holds right now, as a new row. The three keys differ per
// mode, so they come from connKeys() rather than being named here.
export function captureFromForm(): void {
  const k = connKeys();
  const e = env();
  const baseUrl = (e[k.base] || '').trim();
  if (!baseUrl) {
    setConnsError(`there is no Base URL in ${tool.name}'s form to save yet.`);
    renderConnections();
    return;
  }
  const apiKey = (e[k.key] || '').trim();
  const model = (e[k.model] || '').trim();
  // The host is the one name the user does not have to invent, and it is already unique
  // enough to recognise the row by.
  let name = baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'endpoint';
  const taken = new Set(conns.map(c => c.name.toLowerCase()));
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${name} (${n})`;
  conns.push({ name, baseUrl, model, apiKey, hasKey: false });
  setConnsDirty(true);
  setConnsError('');
  renderConnections();
  ($('connections-save') as HTMLButtonElement).disabled = false;
  toast(`added ${name} from ${tool.name}'s form — Save to keep it`);
}

export function renderConnections(): void {
  const list = $('connections-list');
  $('connections-sub').textContent = opened
    ? `Apply fills ${tool.name}'s form. Save is what writes the file.`
    : 'Open a tool to apply one of these to its form.';
  // Both gestures need a form to work with: one reads it, the other writes it.
  $('connections-capture').hidden = !opened;
  $('connections-count').textContent = conns.length ? `${conns.length} saved` : '';
  const note = $('connections-note');
  note.classList.toggle('note--error', !!connsError);
  note.textContent = connsError || (connsLoaded && connsFile
    ? `${connsAtRest ? 'Tokens are encrypted with DPAPI for this Windows account' : 'Tokens are stored as plain text'} in ${prettyPath(connsFile)}.`
    : '');

  if (!connsLoaded) {
    list.replaceChildren(el('div', { class: 'loading' },
      el('span', { class: 'loading__spinner' }), 'Reading the saved endpoints…'));
    return;
  }
  if (!conns.length) {
    list.replaceChildren(el('div', { class: 'empty-state' },
      el('b', { class: 'empty-state__title', text: 'No saved endpoints yet' }),
      'Add one, and the base URL, token and default model are typed once instead of once per tool.'));
    return;
  }
  list.replaceChildren(...conns.map(connRow));
}

async function loadConnections(): Promise<void> {
  // Reopening the dialog must not throw away a row the user is halfway through.
  if (connsDirty) { renderConnections(); return; }
  setConnsLoaded(false);
  setConnsError('');
  renderConnections();
  try {
    const r = await fetch('/api/connections');
    const j: ConnectionsResponse = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setConns((j.profiles || []).map(p => ({
      name: p.name || '', baseUrl: p.baseUrl || '', model: p.model || '', hasKey: !!p.hasKey,
    })));
    setConnsAtRest(!!j.atRest);
    setConnsFile(j.file || '');
    setConnsDirty(false);
  } catch (e) {
    setConns([]);
    setConnsError(`could not read the saved endpoints: ${(e as Error).message}`);
  }
  setConnsLoaded(true);   // an error shows as a note, not as a spinner that never stops
  renderConnections();
}

export function openConnections(): void {
  const dlg = $('connections') as unknown as HTMLDialogElement;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  void loadConnections();
}

export function closeConnections(): void {
  const dlg = $('connections') as unknown as HTMLDialogElement;
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
}

// Fill the form from one endpoint. The token is asked for by name, one row at a time,
// and nothing here writes a config — Save is still the only writer.
async function applyConnection(c: Connection, btn: HTMLButtonElement): Promise<void> {
  if (!opened) return;
  if (dirty && !(await confirmDialog({
    title: 'Replace the form?',
    message: 'Applying this endpoint drops the unsaved edits in the form.',
    confirmLabel: 'Replace form',
  }))) return;
  const k = connKeys();
  btn.disabled = true;
  btn.classList.add('button--busy');
  let apiKey = '';
  try {
    if (c.hasKey) {
      const r = await fetch('/api/connections/reveal', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: c.name }),
      });
      const j: { apiKey?: string; error?: string } = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      apiKey = j.apiKey || '';
    }
  } catch (e) {
    setConnsError(`could not read the stored token: ${(e as Error).message}`);
    renderConnections();
    return;
  } finally {
    btn.classList.remove('button--busy');
    btn.disabled = false;
  }
  setEnv(k.base, c.baseUrl);
  // Claude Code reads the [1m] marker as "this model has a 1M window", so an apply
  // there keeps it; the other three tools read the bare id and get it stripped.
  if (c.model) setEnv(k.model, tool.mode === 'simple' ? stripMarker(c.model) : c.model);
  if (apiKey) setEnv(k.key, apiKey);
  setConnsDirty(false);
  closeConnections();
  // The dialog covered the form, so a full redraw is invisible here.
  render();
  toast(`filled from ${c.name} — Save writes it to ${tool.name}`);
}

export async function saveConnections(): Promise<void> {
  const btn = $('connections-save') as HTMLButtonElement;
  btn.disabled = true;
  btn.classList.add('button--busy');
  try {
    const r = await fetch('/api/connections', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profiles: conns }),
    });
    const j: { error?: string; count?: number } = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setConnsDirty(false);
    setConnsError('');
    toast(`saved ${j.count} endpoint${j.count === 1 ? '' : 's'}`);
    await loadConnections();
  } catch (e) {
    setConnsError(`not saved: ${(e as Error).message}`);
    renderConnections();
  } finally {
    btn.classList.remove('button--busy');
    btn.disabled = !connsDirty;
  }
}
