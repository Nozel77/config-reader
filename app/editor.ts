// The editor: the field cards, the form render, and the load/save round-trip.
import { $, el, icon, toast, cardOf } from './ui.js';
import { GROUPS, GROUP_ORDER, KNOWN, fieldOf, fieldsFor, MODEL_KEYS } from './fields.js';
import type { Field, SettingsResponse } from './fields.js';
import {
  doc, filePath, baseMtimeMs, dirty, tool, values,
  setDoc, setFilePath, setBaseMtimeMs, setDirty, setOpened, setTargetKey, setValues,
  setModels, setCaps, setLoaded, setModelError, setFilter, setOnly1m, setOnlyVision,
  setModelsUrl, setLoadedFor,
  env, setEnv, prettyPath,
} from './state.js';
import { openPicker, fieldTestButton, renderModels } from './models.js';
import { renderTools, closeEditor } from './landing.js';

// The index is this card's place in its group; the entrance animation reads it.
function fieldCard(f: Field, i = 0): HTMLElement {
  const cur = env()[f.key];
  const val = cur === undefined || cur === null ? '' : String(cur);

  const input = el('input', {
    class: 'field-card__input',
    type: f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text',
    'data-field': f.key,   // lets the model picker write into this card in place
    value: val,
    placeholder: f.placeholder || '',
    spellcheck: 'false',
    autocomplete: f.kind === 'secret' ? 'off' : '',
    'aria-label': f.label,
    oninput: (e: Event) => setEnv(f.key, (e.target as HTMLInputElement).value),
  }) as HTMLInputElement;

  const row = el('div', { class: 'field-card__row' }, input);

  if (f.kind === 'secret') {
    const eye = el('button', {
      class: 'button button--ghost button--icon button--small', type: 'button',
      title: 'reveal the token', 'aria-label': 'Show token',
      onclick: () => {
        const revealed = input.type === 'password';
        input.type = revealed ? 'text' : 'password';
        eye.replaceChildren(icon(revealed ? 'eyeSlash' : 'eye'));
        eye.classList.toggle('button--active', revealed);
        eye.setAttribute('aria-label', revealed ? 'Hide token' : 'Show token');
        eye.setAttribute('title', revealed ? 'hide the token' : 'reveal the token');
      },
    }, icon('eye'));
    row.append(eye);
  }

  // A row, not a card: the name, then the control. The key and the description are
  // secondary, so they live behind the "?" rather than in the row.
  const card = el('div', { class: 'field-card', 'data-group': f.group, 'data-card': f.key, style: `--i:${i}` },
    el('div', { class: 'field-card__head' },
      el('span', { class: 'field-card__label', text: f.label }),
      el('button', {
        class: 'hint', type: 'button', text: '?',
        'data-tip': `${f.key}\n${f.hint}`,
        'aria-label': `${f.label}: ${f.hint}`,
      })),
    row);

  if (f.kind === 'secret') {
    // Redraws this one card, not the form.
    row.append(el('button', {
      class: 'button button--ghost button--icon button--small button--danger',
      type: 'button', title: 'remove this variable from env', 'aria-label': 'Clear token',
      onclick: () => { input.value = ''; setEnv(f.key, ''); card.replaceWith(fieldCard(f)); },
    }, icon('trash')));
  }

  if (MODEL_KEYS.has(f.key)) {
    // It reads the endpoint the Base URL and Auth token describe, so it belongs here.
    row.append(el('button', {
      class: 'button button--ghost button--icon button--small', type: 'button',
      title: `Pick a model for ${f.label}`, 'aria-label': `Pick a model for ${f.label}`,
      onclick: () => openPicker(f.key),
    }, icon('list')));
    // The picker is not the only place a model can be checked, and a test belongs on
    // the row that holds it: no dialog, and it works on a value that is not saved yet.
    row.append(fieldTestButton(f, input));
  }

  return card;
}

// Anything in env that isn't one of the nine fields above, so it is never invisible.
export function otherRow(key: string): HTMLElement {
  const val = env()[key];
  const input = el('input', {
    class: 'other-vars__input',
    type: 'text', value: val === undefined || val === null ? '' : String(val),
    spellcheck: 'false', 'aria-label': key,
    oninput: (e: Event) => setEnv(key, (e.target as HTMLInputElement).value),
  });
  const row = el('div', { class: 'other-vars__row', 'data-key': key },
    el('code', { class: 'other-vars__key', text: key }),
    input,
    el('button', {
      class: 'button button--ghost button--icon button--small button--danger',
      type: 'button', title: `delete env.${key}`, 'aria-label': `Delete ${key}`,
      onclick: () => {
        // One variable goes; re-rendering the form would replay every card's animation.
        setEnv(key, '');
        row.remove();
        const left = $('other-vars-list').children.length;
        $('other-vars-count').textContent = String(left);
        if (!left) $('other-vars').hidden = true;
      },
    }, icon('xmark')));
  return row;
}

// Redraw one field card in place: rebuilding the form would replay every other
// card's entrance animation for a change that touched one field.
export function refreshCard(key: string): void {
  const card = cardOf(key);
  const f = fieldOf(key);
  if (card && f) card.replaceWith(fieldCard(f));
}

export function render(): void {
  setOpened(true);
  $('app').classList.add('app--editor');
  $('editor').hidden = false;
  // A reload keeps the entry it is already on; only a fresh open adds one.
  if (location.hash.slice(1) !== tool.id) history.pushState({ tool: tool.id }, '', `#${tool.id}`);

  const simple = tool.mode === 'simple';
  $('editor-title').textContent = tool.name;
  // The editor is opened by picking a card, so the card must show it.
  renderTools();

  const pathEl = $('actionbar-path');
  pathEl.textContent = prettyPath(filePath);
  pathEl.title = filePath;

  // One section per group, so the group is said once instead of on every row. Empty
  // groups are dropped: a simple tool has no runtime knobs, Claude has no roles.
  const list = fieldsFor(tool);
  $('editor-form').replaceChildren(...GROUP_ORDER
    .filter(g => list.some(f => f.group === g))
    .map(g => el('section', { class: 'field-group', 'data-group': g },
      el('h3', { class: 'field-group__title', text: GROUPS[g] }),
      ...list.filter(f => f.group === g).map(fieldCard))));

  // "Other variables in env" is a Claude Code idea: a key/value bag this editor
  // deliberately does not own, so the other tools are not offered it.
  $('other-vars').hidden = simple;
  $('other-vars').style.display = simple ? 'none' : '';
  if (simple) {
    $('other-vars-list').replaceChildren();
  } else {
    const others = Object.keys(env()).filter(k => !KNOWN.has(k)).sort();
    $('other-vars').hidden = others.length === 0;
    $('other-vars-count').textContent = String(others.length);
    $('other-vars-list').replaceChildren(...others.map(otherRow));
  }
  renderModels();
}

export async function load(): Promise<void> {
  const s: SettingsResponse = await fetch(`/api/settings?tool=${encodeURIComponent(tool.id)}`).then(r => r.json());
  if (!s.selected) { closeEditor(); return; }

  setFilePath(s.file || '');
  setBaseMtimeMs(s.mtimeMs || 0);

  const bs: HTMLElement[] = [];
  if (tool.mode === 'simple') {
    setValues({ ...(s.values || {}) });
    setDoc({});
  } else {
    setDoc(s.parsed || {});
    if (!s.exists) {
      bs.push(el('div', { class: 'banner banner--warn' },
        el('b', { text: 'settings.json was not found. ' }),
        `Nothing at ${filePath}. Fill in a field and Save to create it.`));
    }
    if (s.exists && !s.parseError && Object.keys(env()).length === 0) {
      bs.push(el('div', { class: 'banner banner--warn' }, 'No env block in this file yet. Filling in a field creates it.'));
    }
    // A reformat the user agreed to is not the same as one they discover in git.
    if (s.normalized) {
      bs.push(el('div', { class: 'banner banner--warn' },
        el('b', { text: 'This file is not in canonical JSON form. ' }),
        'Saving rewrites the whole document: indentation and spacing may change. Keys are kept.'));
    }
  }
  if (s.parseError) {
    bs.push(el('div', { class: 'banner banner--error' },
      el('b', { text: 'This file is not valid. ' }), s.parseError,
      '. Saving is disabled so the broken file is not overwritten.'));
  } else if (!s.exists) {
    // These files are usually written by the tool itself, so a missing one is worth saying.
    bs.push(el('div', { class: 'banner banner--warn' },
      el('b', { text: `${tool.name} has no config file yet. ` }),
      `Nothing at ${filePath}. Saving creates it.`));
  }

  setDirty(false);
  $('actionbar-dot').classList.remove('actionbar__dot--dirty');
  ($('save') as HTMLButtonElement).disabled = !!s.parseError;
  $('editor-banners').replaceChildren(...bs);
  // A fresh file means the previous list belongs to a different endpoint.
  setModels([]);
  setCaps({});
  setLoaded(false);
  setModelError('');
  setFilter('');
  setOnly1m(false);
  setOnlyVision(false);
  setModelsUrl('');
  setLoadedFor('');
  setTargetKey('');
  ($('model-picker-filter') as HTMLInputElement).value = '';
  ($('filter-1m') as HTMLInputElement).checked = false;
  ($('filter-vision') as HTMLInputElement).checked = false;
  render();
  // A broken file still gets its banners and path, but no fields to edit.
  $('editor-form').style.display = s.parseError ? 'none' : '';
}

export async function save(): Promise<void> {
  const btn = $('save') as HTMLButtonElement;
  btn.disabled = true;
  btn.classList.add('button--busy');
  const simple = tool.mode === 'simple';
  try {
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(simple
        ? { tool: tool.id, values, baseMtimeMs }
        : { tool: tool.id, doc, baseMtimeMs }),
    });
    const j = await r.json();
    if (r.status === 409) {
      // Keep the draft: reloading here would throw away what the user just typed.
      $('editor-banners').replaceChildren(el('div', { class: 'banner banner--error' },
        el('b', { text: 'Not saved: the file changed on disk. ' }),
        `${tool.name} (or another editor) wrote it since this page loaded. Your edits are still here. `,
        'Reload to discard them, or Save again to overwrite.'));
      setBaseMtimeMs(j.mtimeMs);
      return;
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setBaseMtimeMs(j.mtimeMs);
    setDirty(false);
    $('actionbar-dot').classList.remove('actionbar__dot--dirty');
    toast(`saved ${j.bytes} bytes → ${prettyPath(j.file)}${j.backup ? ' (previous version backed up)' : ''}`);
  } catch (e) {
    $('editor-banners').replaceChildren(
      el('div', { class: 'banner banner--error' }, `Save failed: ${(e as Error).message}`));
  } finally {
    // One exit for every path: a save that failed must still hand the button back, and
    // a save that worked must leave it disabled — there is nothing left to write.
    btn.classList.remove('button--busy');
    btn.disabled = !dirty;
  }
}
