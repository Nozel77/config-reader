// The model picker: the dialog, the rows, the per-model test, and the fetch.
import { $, el, icon, humanize, toast, CAP_LABELS, CAP_ICONS, fieldInput } from './ui.js';
import { stripMarker, WINDOW_1M, CONTEXT_MARKER, fieldOf } from './fields.js';
import type { Field, ModelCaps, ModelsResponse } from './fields.js';
import {
  tool, targetKey, models, caps, loaded, filter, only1m, onlyVision, modelError, modelsUrl, loadedFor,
  setTargetKey, setModels, setCaps, setLoaded, setModelError, setModelsUrl, setLoadedFor,
  env, setEnv,
} from './state.js';

// A window as a person reads it: 1M, 200K, or the plain number.
const fmtWindow = (n: number): string =>
  n >= WINDOW_1M ? `${+(n / WINDOW_1M).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : String(n);

export function openPicker(key: string): void {
  setTargetKey(key);
  const f = fieldOf(key);
  $('model-picker-title').textContent = `Pick a model for ${f ? f.label : key}`;
  $('model-picker-sub').textContent = `Sets ${key}`;
  const dlg = $('model-picker') as HTMLDialogElement;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  const box = $('model-picker-filter') as HTMLInputElement;
  box.focus();
  box.select?.();
  renderModels();
  // Reads the endpoint as it stands on the form, and only when it is not the one the
  // list already came from.
  void loadModels(false);
}

export function closePicker(): void {
  const dlg = $('model-picker') as HTMLDialogElement;
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
}

// The capability icons for one model: one glyph per boolean the endpoint reported as
// true. Anything it names that has no glyph here still shows, with a dot, and the key
// name is the tooltip. Strings are not chips — they go in the row's tooltip as text.
function capChips(id: string): HTMLElement[] {
  const c = caps[stripMarker(id)]?.caps || {};
  const out: HTMLElement[] = [];
  for (const [key, value] of Object.entries(c)) {
    if (value !== true) continue;
    const label = CAP_LABELS[key] || humanize(key);
    out.push(el('span', {
      class: 'cap', title: label, 'aria-label': label, role: 'img',
    }, icon(CAP_ICONS[key] || 'dot')));
  }
  return out;
}

// What the endpoint reported, in words: the two numbers worth reading at a glance.
// String-valued capabilities (thinkingFormat and friends) go on the row's tooltip
// instead — they are real data, but they crowd out the numbers that decide a pick.
function specLine(id: string): string {
  const c = caps[stripMarker(id)];
  if (!c) return 'nothing reported';
  const bits: string[] = [];
  bits.push(c.ctx ? `${fmtWindow(c.ctx)} context` : 'context not reported');
  if (c.maxOut) bits.push(`${fmtWindow(c.maxOut)} out`);
  if (c.caps && c.caps.vision === false) bits.push('text only');
  return bits.join(' · ');
}

// Everything the endpoint said about a model, for the row's tooltip. The tooltip is
// where the fields that do not earn a chip go: the endpoint's human name, a price,
// a description, and every string-valued capability under its own key.
function capTitle(id: string): string {
  const c = caps[stripMarker(id)];
  if (!c) return id;
  const lines = [`${id} · ${providerOf(id)}`, specLine(id)];
  const m = c.meta || {};
  if (m.free) lines.push('Free');
  if (m.sunset) lines.push(`Sunset: ${m.sunset}`);
  if (m.endpoints?.length) lines.push(`Endpoints: ${m.endpoints.join(', ')}`);
  if (m.efforts?.length) lines.push(`Reasoning effort: ${m.efforts.join(', ')}`);
  if (m.name && m.name !== id) lines.push(m.name);
  if (m.description) lines.push(m.description);
  for (const [key, value] of Object.entries(c.caps || {})) {
    if (typeof value === 'string' && value) lines.push(`${humanize(key)}: ${value}`);
  }
  return lines.join('\n');
}

// One model: two lines, so the id gets the width it needs. "Use" is the big click
// target, "test" is a second action on the same row and cannot live inside it.
function modelRow(id: string): HTMLElement {
  const base = stripMarker(id);
  // Markers stripped: the field may hold "id[1m]" while the row is "id".
  const here = stripMarker(String(env()[targetKey] ?? '')) === base;
  const m = caps[base]?.meta || {};
  return el('div', { class: `model-row${here ? ' model-row--current' : ''}`, 'data-model': id },
    el('button', {
      class: 'model-row__use', type: 'button', title: capTitle(id),
      onclick: () => useModel(id),
    },
      el('span', { class: 'model-row__top' },
        el('code', { class: 'model-row__id', text: id }),
        m.free ? el('span', { class: 'badge badge--free', text: 'free' }) : null,
        m.sunset ? el('span', { class: 'badge badge--warn', text: 'sunset' }) : null,
        here ? el('span', { class: 'badge badge--ok', text: 'in use' }) : null),
      el('span', { class: 'model-row__meta' },
        capChips(id).length
          ? el('span', { class: 'model-row__caps' }, ...capChips(id))
          : null,
        el('span', { class: 'model-row__spec', text: specLine(id) }))),
    testButton(id));
}

// A one-line completion is the only honest "is it up" test. The endpoint is read from
// the form, so a probe uses what is on screen rather than what was last saved.
async function probeModel(id: string): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const baseUrl = env()[tool.mode === 'simple' ? 'baseUrl' : 'ANTHROPIC_BASE_URL'] || '';
  const apiKey = env()[tool.mode === 'simple' ? 'apiKey' : 'ANTHROPIC_AUTH_TOKEN'] || '';
  try {
    const r = await fetch('/api/test-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, model: stripMarker(id) }),
    });
    const j: { ok?: boolean; ms?: number; error?: string } = await r.json();
    return { ok: !!j.ok, ms: j.ms, error: j.error };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// A one-line completion is the only honest "is it up" test. The result lives on the
// row, so a list of them can be read at a glance. Same bolt as the form's own test
// button: one gesture, wherever it is pressed from.
function testButton(id: string): HTMLElement {
  const btn = el('button', {
    class: 'model-row__test', type: 'button',
    title: `Send one tiny request to ${id}`,
    'aria-label': `Test ${id}`,
  }, icon('bolt')) as HTMLButtonElement;
  btn.addEventListener('click', () => { void runTest(id, btn); });
  return btn;
}

// While a probe is in flight the bolt becomes a spinner, so the row says it is working
// rather than looking untouched. The class drives the rotation, so it stops with the
// same switch that ends the wait.
function setTestBusy(btn: HTMLButtonElement, busy: boolean): void {
  btn.replaceChildren(icon(busy ? 'refresh' : 'bolt'));
  btn.classList.toggle('test--busy', busy);
}

async function runTest(id: string, btn: HTMLButtonElement): Promise<void> {
  if (btn.classList.contains('model-row__test--busy')) return;
  btn.classList.add('model-row__test--busy');
  btn.classList.remove('model-row__test--ok', 'model-row__test--fail');
  btn.title = `Testing ${id}…`;
  setTestBusy(btn, true);
  const { ok, ms, error } = await probeModel(id);
  setTestBusy(btn, false);
  btn.classList.add(ok ? 'model-row__test--ok' : 'model-row__test--fail');
  btn.title = ok ? `${id} answered in ${ms} ms` : `${id}: ${error || 'no answer'}`;
  toast(ok ? `${id} answered in ${ms} ms` : `${id} did not answer: ${error || 'no answer'}`, ok ? 'ok' : 'error');
  btn.classList.remove('model-row__test--busy');
}

// The same probe, from the form: it reads the field itself, so a model can be checked
// without opening the dialog, and before it is saved. The icon stays put — only the
// colour and the tooltip carry the result.
export function fieldTestButton(f: Field, input: HTMLInputElement): HTMLElement {
  const btn = el('button', {
    class: 'button button--ghost button--icon button--small field-card__test',
    type: 'button',
    title: `Send one tiny request to the model in this field`,
    'aria-label': `Test ${f.label}`,
  }, icon('bolt')) as HTMLButtonElement;
  btn.addEventListener('click', () => { void runFieldTest(input, btn); });
  return btn;
}

async function runFieldTest(input: HTMLInputElement, btn: HTMLButtonElement): Promise<void> {
  const id = input.value.trim();
  if (!id || btn.classList.contains('field-card__test--busy')) return;
  btn.classList.add('field-card__test--busy');
  btn.classList.remove('field-card__test--ok', 'field-card__test--fail');
  setTestBusy(btn, true);
  const { ok, ms, error } = await probeModel(id);
  setTestBusy(btn, false);
  btn.classList.add(ok ? 'field-card__test--ok' : 'field-card__test--fail');
  btn.title = ok ? `${id} answered in ${ms} ms` : `${id}: ${error || 'no answer'}`;
  toast(ok ? `${id} answered in ${ms} ms` : `${id} did not answer: ${error || 'no answer'}`, ok ? 'ok' : 'error');
  btn.classList.remove('field-card__test--busy');
}

// The provider the endpoint named, or the id's own prefix when it named none.
function providerOf(id: string): string {
  const named = caps[stripMarker(id)]?.provider;
  if (named) return named;
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : 'other';
}

export function renderModels(): void {
  const shown = models
    .filter(m => m.toLowerCase().includes(filter.toLowerCase()))
    // Markers stripped before lookup: the endpoint reports capabilities by plain id.
    .filter(m => !only1m || (caps[stripMarker(m)]?.ctx || 0) >= WINDOW_1M)
    .filter(m => !onlyVision || caps[stripMarker(m)]?.caps?.vision === true);

  $('model-picker-count').textContent = loaded ? `${shown.length} of ${models.length}` : '';

  const note = $('model-picker-note');
  note.classList.toggle('note--error', !!modelError);
  // What the endpoint reported, counted: a number here means the field is really
  // there, and a zero says the endpoint stays quiet about that one.
  const reported = (pick: (c: ModelCaps) => boolean): number =>
    models.filter(m => { const c = caps[stripMarker(m)]; return c ? pick(c) : false; }).length;
  const ctxCount = reported(c => (c.ctx || 0) > 0);
  const visionCount = reported(c => c.caps?.vision === true);
  const facts = loaded
    ? `Read ${models.length} from ${modelsUrl} · ${ctxCount} with a context window · ${visionCount} accept images`
    : '';
  note.textContent = modelError || facts;

  const list = $('model-picker-list');
  const empty = (title: string, body: string): HTMLElement =>
    el('div', { class: 'empty-state' }, el('b', { class: 'empty-state__title', text: title }), body);

  if (!loaded && !modelError) {
    list.replaceChildren(el('div', { class: 'loading' },
      el('span', { class: 'loading__spinner' }), 'Reading /v1/models…'));
    return;
  }
  if (modelError) {
    list.replaceChildren(empty('Could not load models', modelError));
    return;
  }
  if (!models.length) {
    list.replaceChildren(empty('The endpoint returned no models', 'It answered, but the list came back empty.'));
    return;
  }
  if (!shown.length) {
    const bits: string[] = [];
    if (only1m) bits.push('1M');
    if (onlyVision) bits.push('vision');
    const what = bits.length
      ? `No ${bits.join(' + ')} model${filter ? ` matching “${filter}”` : ''}.`
      : `No model name contains “${filter}”.`;
    list.replaceChildren(empty('Nothing matches those filters', `${what} Clear the filters to see all ${models.length}.`));
    return;
  }

  // Grouped by provider, so a long list reads as a few short ones.
  const byProvider = new Map<string, string[]>();
  for (const id of shown) {
    const p = providerOf(id);
    const bucket = byProvider.get(p);
    if (bucket) bucket.push(id); else byProvider.set(p, [id]);
  }
  list.replaceChildren(...[...byProvider.entries()].map(([provider, ids]) =>
    el('section', { class: 'provider-group' },
      el('h3', { class: 'provider-group__name' },
        el('span', { text: provider }),
        el('span', { class: 'provider-group__count', text: String(ids.length) })),
      el('div', { class: 'provider-group__rows' }, ...ids.map(modelRow)))));
}

// The id as it should be written: plain, plus [1m] when the endpoint reports a 1M
// window. An unreported window gets no marker, and only Claude Code ever gets one.
function withMarker(id: string): { value: string; added: boolean; known: boolean } {
  const base = stripMarker(id);
  const w = caps[base]?.ctx;
  const known = typeof w === 'number' && w > 0;
  const want = tool.mode === 'env' && known && w >= WINDOW_1M;
  return { value: want ? `${base}[1m]` : base, added: want && !CONTEXT_MARKER.test(id), known };
}

// Writes the pick into the field that opened the dialog and closes it.
function useModel(id: string): void {
  if (!targetKey) return;
  const key = targetKey;
  const { value, added, known } = withMarker(id);
  setEnv(key, value);
  const input = fieldInput(key);
  if (input) input.value = value;
  const f = fieldOf(key);
  // The no-window note is only meaningful where a marker was in play at all.
  const why = added ? '. Added [1m], the endpoint reports a 1M window'
    : known || tool.mode === 'simple' ? '' : '. The endpoint reports no context window, so [1m] was left off';
  toast(`${tool.mode === 'simple' ? '' : 'env.'}${key} = ${value}${f ? ` (${f.label})` : ''}${why}. Save to write it`);
  renderModels();   // the row's "in use" badge follows the pick
  closePicker();
}

export async function loadModels(force: boolean): Promise<void> {
  // Read through the seam, so this also works for a tool using baseUrl/apiKey.
  const baseUrl = env()[tool.mode === 'simple' ? 'baseUrl' : 'ANTHROPIC_BASE_URL'] || '';
  const apiKey = env()[tool.mode === 'simple' ? 'apiKey' : 'ANTHROPIC_AUTH_TOKEN'] || '';
  // Re-read only when the endpoint changes, when the last read failed, or on demand.
  const sig = `${baseUrl}\n${apiKey}`;
  if (!force && loaded && sig === loadedFor) return;
  if (!baseUrl) {
    // The server needs a URL, and the default Anthropic API is not listable here.
    setLoaded(false);
    setModels([]);
    setCaps({});
    setModelError('No Base URL is set. Fill in the Base URL field, then reopen this picker.');
    renderModels();
    return;
  }

  const btn = $('model-picker-reload') as HTMLButtonElement;
  btn.disabled = true;
  btn.classList.add('button--busy');
  // A fetch in flight is not a loaded list: the count, the note and the rows all go,
  // and the list shows its spinner. Leaving `loaded` true here painted a stale count
  // over a list that was being replaced.
  setLoaded(false);
  setModelError('');
  renderModels();   // the list shows its spinner
  try {
    const r = await fetch('/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    const j: ModelsResponse = await r.json();
    // A 404 is almost always a server.js started before this route existed.
    if (r.status === 404) {
      throw new Error('this server has no /api/models route. Restart server.js and reload this page.');
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    setModels((j.models || []).slice().sort((a, b) => a.localeCompare(b)));
    setCaps(j.caps || {});
    setModelsUrl(j.url || '');
    setLoaded(true);
    setLoadedFor(sig);
    // Keep the endpoint's own reason: "it returned no models" loses why.
    setModelError(j.models ? '' : (j.error || 'this endpoint does not provide a model list.'));
  } catch (e) {
    setModels([]);
    setCaps({});
    setLoaded(false);
    setModelError(`Could not load models: ${(e as Error).message}`);
  } finally {
    btn.classList.remove('button--busy');
    btn.disabled = false;
    renderModels();
  }
}
