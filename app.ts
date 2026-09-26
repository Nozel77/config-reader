// CONFIG READER — env editor.
//
// Two screens. The landing screen has one orange Scan button: it looks for
// ~/.claude/settings.json on this machine and goes straight to the form. The form
// edits exactly one part of that file — the `env` object. Every other top-level key
// (permissions, hooks, model, …) is carried through untouched, because the whole
// parsed document is what gets POSTed back on save.
//
// server.js serves this file as /app.js using node's built-in TypeScript type
// stripping, so there is no build step and no npm dependency.

interface Field {
  key: string;
  label: string;
  hint: string;
  kind: 'text' | 'number' | 'secret';
  group: 'connection' | 'models' | 'runtime';
  placeholder?: string;
}

interface ModelsResponse {
  url?: string;
  models?: string[] | null;
  windows?: Record<string, number>;
  vision?: Record<string, boolean>;
  error?: string;
}

interface Tool {
  id: string;
  name: string;
  mode: 'env' | 'simple';
}

interface ScanResponse {
  tool: string;
  found: boolean;
  file: string;
  configDir: string;
  home: string;
  platform: string;
  tools?: Tool[];
}

interface SettingsResponse {
  selected: string | null;
  tool?: string;
  file?: string;
  exists?: boolean;
  raw?: string;
  parsed?: Record<string, unknown> | null;
  eol?: string;
  mtimeMs?: number;
  normalized?: boolean;
  parseError?: string | null;
  values?: SimpleValues;
}

// The three values every non-Claude tool needs, and the only ones this editor
// writes for them. The server patches these into that tool's own config format.
interface SimpleValues {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// Grouped by what the variable is for, in the order someone sets them up: where
// requests go, which model answers them, then the knobs that rarely move. Each
// group renders as one section with a single heading.
const GROUPS: Record<Field['group'], string> = {
  connection: 'Connection',
  models: 'Models',
  runtime: 'Runtime',
};
const GROUP_ORDER: Field['group'][] = ['connection', 'models', 'runtime'];

const FIELDS: Field[] = [
  { key: 'ANTHROPIC_BASE_URL', label: 'Base URL', kind: 'text', group: 'connection',
    placeholder: 'http://localhost:20128',
    hint: 'Where Claude Code sends its requests. Leave empty for the default Anthropic API.' },
  { key: 'ANTHROPIC_AUTH_TOKEN', label: 'Auth token', kind: 'secret', group: 'connection',
    hint: 'Bearer token for that endpoint. Stored as plain text in settings.json.' },
  { key: 'ANTHROPIC_MODEL', label: 'Model', kind: 'text', group: 'models',
    hint: 'The model every request uses, unless a more specific one below applies.' },
  { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', label: 'Opus model', kind: 'text', group: 'models',
    hint: 'Answers requests that ask for Opus.' },
  { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', label: 'Sonnet model', kind: 'text', group: 'models',
    hint: 'Answers requests that ask for Sonnet.' },
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', label: 'Haiku model', kind: 'text', group: 'models',
    hint: 'Handles the small background calls — titles, summaries, quick checks.' },
  { key: 'ANTHROPIC_DEFAULT_FABLE_MODEL', label: 'Fable model', kind: 'text', group: 'models',
    hint: 'Answers requests that ask for Fable.' },
  { key: 'API_TIMEOUT_MS', label: 'API timeout', kind: 'number', group: 'runtime',
    placeholder: '3000000', hint: 'How long one request may take, in milliseconds. 3000000 is 50 minutes.' },
  { key: 'CLAUDE_CODE_AUTO_MODE_SERVER', label: 'Auto mode server', kind: 'text', group: 'runtime',
    placeholder: '0', hint: 'Set to 0 to turn the auto-mode server off.' },
];

const KNOWN: Set<string> = new Set(FIELDS.map(f => f.key));

// Tabs are just two panes; the pane id is the whole definition.
const TABS: { id: string; label: string }[] = [
  { id: 'paneenv', label: 'Environment' },
  { id: 'panemodels', label: 'Models' },
];

// Where a picked model can be written. Each entry is an env key already in FIELDS.
const MODEL_TARGETS = [
  { key: 'ANTHROPIC_MODEL', label: 'Model (main)' },
  { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', label: 'Opus' },
  { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', label: 'Sonnet' },
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', label: 'Haiku' },
  { key: 'ANTHROPIC_DEFAULT_FABLE_MODEL', label: 'Fable' },
];

// Every other tool wants the same three values and nothing more, so they get one
// shared field set rather than an editor per config format. The keys are the names
// the server patches into that tool's own file — see TOOLS in server.js.
const SIMPLE_FIELDS: Field[] = [
  { key: 'baseUrl', label: 'Base URL', kind: 'text', group: 'connection',
    placeholder: 'http://localhost:20128',
    hint: 'Where this tool sends its requests. The /v1 suffix is added for you.' },
  { key: 'apiKey', label: 'Auth token', kind: 'secret', group: 'connection',
    hint: 'Bearer token for that endpoint. Stored as plain text in the tool\'s own config.' },
  { key: 'model', label: 'Model', kind: 'text', group: 'models',
    hint: 'The model this tool asks for by default.' },
];

const SIMPLE_TARGETS = [{ key: 'model', label: 'Model' }];

// Claude Code reads a trailing [1m] on a model name as "this model has a 1M window".
// Without it, it assumes 200K and clamps auto-compact accordingly. The suffix has to
// sit at the very end to match, so an id that already carries a marker is stripped
// before a new one is decided.
const CONTEXT_MARKER = /\[1m\]$/i;
const WINDOW_1M = 1_000_000;

const stripMarker = (id: string): string => id.replace(CONTEXT_MARKER, '').trim();

// ------------------------------------------------------------------- state

let doc: Record<string, unknown> = {};   // the whole selected file, single source of truth
let filePath = '';
let baseMtimeMs = 0;
let home = '';                            // for shortening paths to ~
let dirty = false;

// Which tool is being edited. Claude Code is the default, and the only one whose
// file this editor parses as a document; the rest go through `values`.
let tool: Tool = { id: 'claude', name: 'Claude Code', mode: 'env' };
let tools: Tool[] = [tool];

// The simple-mode draft. Held here rather than in the DOM for the same reason the
// env doc is: a re-render must never be the thing that decides what gets saved.
let values: SimpleValues = { baseUrl: '', apiKey: '', model: '' };

// The models pane's own state. `loaded` is the full list from the endpoint;
// `filter` is only what the box narrows it to, so re-rendering never refetches.
let models: string[] = [];
let windows: Record<string, number> = {};   // id -> advertised context window, from the endpoint
let vision: Record<string, boolean> = {};   // id -> image input support, explicit report only — absent means unknown, not text-only
let loaded = false;
let filter = '';
let only1m = false;
let onlyVision = false;
let modelError = '';                      // '' | the endpoint's own reason | a fetch failure
let targetBuilt = false;                  // the target <select> is filled once, then left alone

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;

// Inline SVG glyphs (currentColor). No icon font, no CDN: this editor runs on
// localhost and must work offline — a font pulled from the network would leave
// dead buttons when there is no connection.
const ICONS: Record<string, string> = {
  eye: '<path d="M1.5 8S3.7 3.8 8 3.8 14.5 8 14.5 8 12.3 12.2 8 12.2 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  eyeSlash: '<path d="M1.5 8S3.7 3.8 8 3.8c1.4 0 2.7.5 3.8 1.2M14.5 8S12.3 12.2 8 12.2c-1.4 0-2.7-.5-3.8-1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  trash: '<path d="M6 2h4v1.5h3V5H3V3.5h3V2zm-3.2 4h10.4l-.9 8.2a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8L2.8 6z" fill="currentColor"/>',
  xmark: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  moon: '<path d="M14 9.5A5.5 5.5 0 0 1 6.5 2 5.5 5.5 0 1 0 14 9.5z" fill="currentColor"/>',
  sun: '<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
};

function icon(name: string): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const doc = document as unknown as Document & { createElementNS?: (ns: string, tag: string) => Element };
  const s = (typeof doc.createElementNS === 'function' ? doc.createElementNS(NS, 'svg') : document.createElement('svg')) as unknown as HTMLElement;
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ic');
  (s as unknown as { innerHTML: string }).innerHTML = ICONS[name];
  return s;
}

function el(tag: string, props: Record<string, unknown> = {}, ...kids: unknown[]): HTMLElement {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v as string;
    else if (k === 'text') n.textContent = v as string;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v as EventListener);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid as Node);
  return n;
}

// One seam for both modes: the field cards and the model picker read and write
// through here, so neither has to know which kind of tool it is looking at.
const env = (): Record<string, string> => {
  if (tool.mode === 'simple') return values as unknown as Record<string, string>;
  const e = doc.env;
  return e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, string>) : {};
};

function setEnv(key: string, value: string): void {
  if (tool.mode === 'simple') {
    (values as unknown as Record<string, string>)[key] = value;
    markDirty();
    return;
  }
  if (!doc.env || typeof doc.env !== 'object' || Array.isArray(doc.env)) doc.env = {};
  const e = doc.env as Record<string, string>;
  if (value === '') delete e[key]; else e[key] = value;
  markDirty();
}

function markDirty(): void {
  dirty = true;
  $('dot').classList.add('on');
  ($('save') as HTMLButtonElement).disabled = false;
}

// Windows and macOS compare paths case-insensitively; Linux does not. Folding case
// on Linux would shorten /home/User/... against a home of /home/user — a different
// directory — so the comparison follows the platform the server reported.
let platform = '';
const foldCase = (s: string): string =>
  platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;

// ~/.claude/settings.json reads better than C:\Users\you\.claude\settings.json, and
// the exact path stays in the title. Only a leading home dir is shortened.
function prettyPath(p: string): string {
  if (!home) return p;
  const strip = (s: string) => s.replace(/[\\/]+$/, '');
  if (foldCase(strip(p)) === foldCase(strip(home))) return '~';
  const sep = p.slice(home.length, home.length + 1);
  if (sep !== '\\' && sep !== '/') return p;
  if (foldCase(p.slice(0, home.length)) !== foldCase(home)) return p;
  return '~' + p.slice(home.length);
}

// -------------------------------------------------------------- landing

// The tool picker. One card per tool, and picking one is what decides which file
// Scan will look for. Picking is only a selection: it stays on this screen so the
// choice is visible before anything is read. Scan is what leaves it — and it is
// also where unsaved changes get their confirm, since only a scan can lose them.
function renderTools(): void {
  $('toolpick').replaceChildren(...tools.map(t => el('button', {
    class: `tool${t.id === tool.id ? ' on' : ''}`,
    type: 'button',
    'aria-pressed': String(t.id === tool.id),
    onclick: () => {
      if (t.id === tool.id) return;
      tool = t;
      // The path is per tool, so the one on screen is now a claim about the wrong
      // file. Clearing it is cheaper than tracking which tool it belonged to.
      $('scanpath').hidden = true;
      $('obnote').textContent = '';
      $('scanbtn').textContent = `Scan ${tool.name}`;
      renderTools();
    },
  },
    el('img', { src: `/icon/${t.id}.png`, alt: '', width: '28', height: '28', loading: 'lazy' }),
    el('span', { class: 'toolname', text: t.name }))));
}

// The one control on the landing screen. Scanning selects the file server-side, so
// no path ever travels from the browser — the client only learns what was found.
async function scan(): Promise<void> {
  const btn = $('scanbtn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  $('obnote').textContent = '';
  try {
    const r = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: tool.id }),
    });
    const j: ScanResponse = await r.json();
    if (!r.ok) throw new Error((j as unknown as { error: string }).error || `HTTP ${r.status}`);
    home = j.home;
    platform = j.platform;
    // The registry rides along with every scan, so a picker that was drawn before
    // the first one is corrected here rather than staying a guess.
    if (j.tools) { tools = j.tools; renderTools(); }
    $('scantarget').textContent = prettyPath(j.file);
    $('scantarget').title = j.file;
    $('scanpath').hidden = false;
    await load();
  } catch (e) {
    $('obnote').textContent = `Scan failed: ${(e as Error).message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = `Scan ${tool.name}`;
  }
}

function showLanding(): void {
  $('onboard').hidden = false;
  $('editor').hidden = true;
  $('dot').classList.remove('on');
  $('obnote').textContent = '';
  $('scanbtn').textContent = `Scan ${tool.name}`;
  // The path is per tool and only the scan knows it, so the line stays out of the
  // way until there is something true to put in it.
  $('scanpath').hidden = true;
  renderTools();
}

// ---------------------------------------------------------------- editor

function fieldCard(f: Field): HTMLElement {
  const cur = env()[f.key];
  const val = cur === undefined || cur === null ? '' : String(cur);

  const input = el('input', {
    type: f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text',
    id: `f_${f.key}`,   // lets the models pane write into this card without a full re-render
    value: val,
    placeholder: f.placeholder || '',
    spellcheck: 'false',
    autocomplete: f.kind === 'secret' ? 'off' : '',
    'aria-label': f.label,
    oninput: (e: Event) => setEnv(f.key, (e.target as HTMLInputElement).value),
  }) as HTMLInputElement;

  const controls: HTMLElement[] = [input];
  if (f.kind === 'secret') {
    const eye = el('button', {
      class: 'ghost small icon', type: 'button', title: 'reveal the token',
      'aria-label': 'Show token',
      onclick: () => {
        const revealed = input.type === 'password';
        input.type = revealed ? 'text' : 'password';
        eye.replaceChildren(icon(revealed ? 'eyeSlash' : 'eye'));
        eye.classList.toggle('on', revealed);
        eye.setAttribute('aria-label', revealed ? 'Hide token' : 'Show token');
        eye.setAttribute('title', revealed ? 'hide the token' : 'reveal the token');
      },
    }, icon('eye'));
    controls.push(eye);
    controls.push(el('button', {
      class: 'ghost small icon danger', type: 'button', title: 'remove this variable from env',
      'aria-label': 'Clear token',
      onclick: () => { input.value = ''; setEnv(f.key, ''); render(); },
    }, icon('trash')));
  }

  // data-group stays on the card: check-ui asserts every field carries its
  // group, and the section heading — not a stripe — is what shows it.
  return el('div', { class: 'field', 'data-group': f.group },
    el('div', { class: 'fhead' },
      el('span', { class: 'flabel', text: f.label }),
      val === '' ? el('span', { class: 'badge unset', text: 'unset' }) : null,
      el('code', { class: 'fkey', text: f.key })),
    el('p', { class: 'hint', text: f.hint }),
    el('div', { class: 'inputrow' }, ...controls));
}

// Anything in env that isn't one of the nine fields above. Shown so a variable
// this UI doesn't know about is never invisible — and never silently lost.
function otherRow(key: string): HTMLElement {
  const val = env()[key];
  const input = el('input', {
    type: 'text', value: val === undefined || val === null ? '' : String(val),
    spellcheck: 'false', 'aria-label': key,
    oninput: (e: Event) => setEnv(key, (e.target as HTMLInputElement).value),
  });
  return el('div', { class: 'otherrow' },
    el('code', { class: 'fkey', text: key }),
    input,
    el('button', {
      class: 'ghost small icon danger', type: 'button', title: `delete env.${key}`,
      'aria-label': `Delete ${key}`,
      onclick: () => { setEnv(key, ''); render(); },
    }, icon('xmark')));
}

function render(): void {
  $('onboard').hidden = true;
  $('editor').hidden = false;

  const simple = tool.mode === 'simple';
  $('title').textContent = tool.name;

  const pathEl = $('path');
  pathEl.textContent = prettyPath(filePath);
  pathEl.title = filePath;

  // Grouped into one section per GROUPS entry with a single heading, so the
  // group is said once instead of repeated on every card.
  const list = simple ? SIMPLE_FIELDS : FIELDS;
  if (simple) {
    $('form').replaceChildren(...list.map(fieldCard));
  } else {
    $('form').replaceChildren(...GROUP_ORDER.map(g =>
      el('section', { class: 'fgroup', 'data-group': g },
        el('h3', { class: 'fgrouphead', text: GROUPS[g] }),
        ...list.filter(f => f.group === g).map(fieldCard))));
  }

  // "Other variables in env" is a Claude Code idea: its settings file is a key/value
  // bag this editor deliberately does not own. The other three files are not that,
  // so the section is not offered for them.
  $('others').hidden = simple;
  $('others').style.display = simple ? 'none' : '';
  if (simple) {
    $('otherlist').replaceChildren();
  } else {
    const others = Object.keys(env()).filter(k => !KNOWN.has(k)).sort();
    $('others').hidden = others.length === 0;
    $('othercount').textContent = String(others.length);
    $('otherlist').replaceChildren(...others.map(otherRow));
  }
  renderModels();
}

// ------------------------------------------------------------------- models

function renderTabs(): void {
  $('tabs').replaceChildren(...TABS.map(t => el('button', {
    id: `tab_${t.id}`, class: 'tab', role: 'tab', text: t.label,
    'aria-controls': t.id,
    onclick: () => showTab(t.id),
  })));
}

function showTab(pane: string): void {
  for (const t of TABS) {
    const on = t.id === pane;
    $(t.id).hidden = !on;
    const tab = $(`tab_${t.id}`);
    tab.classList.toggle('on', on);
    tab.setAttribute('aria-selected', String(on));
  }
}

function renderModels(): void {
  if (!targetBuilt) {
    targetBuilt = true;
    $('modeltarget').replaceChildren(...targets().map(m =>
      el('option', { value: m.key, text: m.label })));
  }
  // The <select> keeps its own choice; only its option list is ours to build.
  const note = $('modelnote');
  note.classList.toggle('err', !!modelError);
  note.textContent = modelError
    || `Reads /v1/models from the Base URL above, using the Auth token. ${loaded ? `${models.length} found.` : 'Nothing loaded yet.'}`;

  const shown = models
    .filter(m => m.toLowerCase().includes(filter.toLowerCase()))
    // Marker stripped before lookup: the endpoint reports windows by plain id.
    .filter(m => !only1m || (windows[stripMarker(m)] || 0) >= WINDOW_1M)
    .filter(m => !onlyVision || vision[stripMarker(m)] === true);
  // One element covers every empty case — nothing loaded, nothing returned, nothing
  // matching the filter — so an empty grid never sits under a stale note.
  const empty = $('modelempty');
  const showEmpty = shown.length === 0;
  empty.hidden = !showEmpty;
  if (showEmpty) {
    // Order matters: an explicit reason from the endpoint beats "it answered empty",
    // and a filter that matched nothing beats both. Collapsing models:null into []
    // loses that distinction, so modelError is checked before the loaded case.
    const what = (() => {
      const bits: string[] = [];
      if (only1m) bits.push('1M');
      if (onlyVision) bits.push('vision');
      if (bits.length && !filter) return `no ${bits.join(' + ')} model in this list`;
      if (bits.length) return `no ${bits.join(' + ')} model contains “${filter}”`;
      return `No model name contains “${filter}”.`;
    })();
    const [title, body] = loaded && models.length
      ? ['Nothing matches that filter', `${what} ${filter ? 'Clear the box' : 'Uncheck the filters'} to see all ${models.length}.`]
      : modelError
        ? ['Could not load models', modelError]
        : loaded
          ? ['The endpoint returned no models', 'It answered, but the list came back empty.']
          : ['No models loaded yet', 'Press Load models to ask the endpoint for its list.'];
    empty.replaceChildren(el('b', { text: title }), body);
  }
  $('modellist').replaceChildren(...shown.map(modelRow));
  // The column header only means anything above actual rows.
  $('modelhead').hidden = shown.length === 0;
}

// The model picker's target list is per tool: Claude Code has five variables a
// model can land in, everything else has exactly one.
const targets = (): { key: string; label: string }[] => (tool.mode === 'simple' ? SIMPLE_TARGETS : MODEL_TARGETS);

// One table row per model: click Assign to write that id into the chosen env variable.
function modelRow(id: string): HTMLElement {
  // Compared with markers stripped: env may hold "id[1m]" while the row is "id".
  const base = stripMarker(id);
  const selected = Object.values(targets()).some(m => stripMarker(String(env()[m.key] ?? '')) === base);
  const w = windows[base];
  const big = typeof w === 'number' && w >= WINDOW_1M;
  // Absent from the vision map means the endpoint said nothing — no badge either
  // way. Only an explicit false earns a "no vision" note, same honesty as windows.
  const v = vision[base];
  return el('div', { class: 'mrow', role: 'row' },
    el('code', { text: id }),
    el('span', { class: 'mtags' },
      big ? el('span', { class: 'badge found', text: '1M', title: `${w.toLocaleString()} token window — Claude Code needs a [1m] suffix to use it` }) : null,
      v === true ? el('span', { class: 'badge see', text: 'vision', title: 'Accepts image input' }) : null,
      v === false ? el('span', { class: 'badge novis', text: 'no vision', title: 'Text input only, per the endpoint’s capability report' }) : null,
      selected ? el('span', { class: 'badge cur', text: 'in use' }) : null),
    el('button', {
      class: 'ghost small', type: 'button', text: 'Assign',
      title: `set ${($('modeltarget') as HTMLSelectElement).value} to ${withMarker(id).value}`,
      onclick: () => useModel(id),
    }));
}

// The id as it should be written: the plain id, plus [1m] when the endpoint says the
// model's window is a million tokens or more. Claude Code would otherwise assume 200K.
// An endpoint that reports no window gets no marker — guessing here would tell Claude
// Code a model is 1M when it may not be, which breaks auto-compact rather than helps.
//
// The marker is a Claude Code convention, so it is only ever added for Claude Code.
function withMarker(id: string): { value: string; added: boolean; known: boolean } {
  const base = stripMarker(id);
  const w = windows[base];
  const known = typeof w === 'number';
  const want = tool.mode === 'env' && known && w >= WINDOW_1M;
  return { value: want ? `${base}[1m]` : base, added: want && !CONTEXT_MARKER.test(id), known };
}

// Sets the variable and refreshes that one input in place, so a click in the
// models tab never loses the caret or scroll position of the env form.
function useModel(id: string): void {
  const key = ($('modeltarget') as HTMLSelectElement).value;
  const { value, added, known } = withMarker(id);
  setEnv(key, value);
  const input = document.getElementById(`f_${key}`) as HTMLInputElement | null;
  if (input) input.value = value;
  const label = targets().find(m => m.key === key);
  // The no-window note is only meaningful where a marker was in play at all.
  const why = added ? ' — added [1m], the endpoint reports a 1M window'
    : known || tool.mode === 'simple' ? '' : ' — the endpoint reports no context window, so [1m] was left off';
  toast(`${tool.mode === 'simple' ? '' : 'env.'}${key} = ${value}${label ? ` (${label.label})` : ''}${why} — Save to write it`);
  renderModels();
}

async function loadModels(): Promise<void> {
  const btn = $('loadmodels') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Loading…';
  modelError = '';
  try {
    // Read through the seam, so this works for a tool whose keys are not the
    // ANTHROPIC_* ones — the simple tools call the same two values baseUrl/apiKey.
    const baseUrl = env()[tool.mode === 'simple' ? 'baseUrl' : 'ANTHROPIC_BASE_URL'] || '';
    const apiKey = env()[tool.mode === 'simple' ? 'apiKey' : 'ANTHROPIC_AUTH_TOKEN'] || '';
    const r = await fetch('/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    const j: ModelsResponse = await r.json();
    // A 404 here is almost always a server.js started before this route existed:
    // the file is read once at boot, so an old process serves an old route table.
    if (r.status === 404) {
      throw new Error('this server has no /api/models route — restart server.js and reload this page.');
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    models = (j.models || []).slice().sort((a, b) => a.localeCompare(b));
    windows = j.windows || {};
    vision = j.vision || {};
    loaded = true;
    modelError = j.models ? '' : (j.error || 'this endpoint does not provide a model list.');
  } catch (e) {
    models = [];
    vision = {};
    loaded = false;
    modelError = `Could not load models: ${(e as Error).message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load models';
    renderModels();
  }
}

// ---------------------------------------------------------------------- io

let toastTimer = 0;
function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

// A message about the file that was open a moment ago is worse than none: switching
// tool leaves the old one on screen otherwise, naming a variable this tool has not got.
function hideToast(): void {
  clearTimeout(toastTimer);
  $('toast').classList.remove('on');
  $('toast').textContent = '';
}

async function load(): Promise<void> {
  const s: SettingsResponse = await fetch(`/api/settings?tool=${encodeURIComponent(tool.id)}`).then(r => r.json());
  if (!s.selected) { showLanding(); return; }

  filePath = s.file || '';
  baseMtimeMs = s.mtimeMs || 0;

  const bs: HTMLElement[] = [];
  if (tool.mode === 'simple') {
    values = { baseUrl: '', apiKey: '', model: '', ...(s.values || {}) };
    doc = {};
  } else {
    doc = s.parsed || {};
    if (!s.exists) {
      bs.push(el('div', { class: 'banner warn' },
        el('b', { text: 'settings.json was not found. ' }),
        `Nothing at ${filePath}. Fill in a field and Save to create it.`));
    }
    if (s.exists && !s.parseError && Object.keys(env()).length === 0) {
      bs.push(el('div', { class: 'banner warn' }, 'No env block in this file yet — filling in a field creates it.'));
    }
  }
  if (s.parseError) {
    bs.push(el('div', { class: 'banner err' },
      el('b', { text: 'This file is not valid. ' }), s.parseError,
      ' — saving is disabled so the broken file is not overwritten.'));
  } else if (!s.exists) {
    // The simple-mode files are usually written by the tool itself on first run, so
    // a missing one is worth saying out loud rather than quietly creating.
    bs.push(el('div', { class: 'banner warn' },
      el('b', { text: `${tool.name} has no config file yet. ` }),
      `Nothing at ${filePath}. Saving creates it.`));
  }

  dirty = false;
  $('dot').classList.remove('on');
  ($('save') as HTMLButtonElement).disabled = !!s.parseError;
  $('banners').replaceChildren(...bs);
  // A fresh file means the previous list belongs to a different endpoint.
  models = [];
  windows = {};
  vision = {};
  loaded = false;
  modelError = '';
  filter = '';
  only1m = false;
  onlyVision = false;
  targetBuilt = false;   // the target list is per tool, so it is rebuilt on every load
  ($('modelfilter') as HTMLInputElement).value = '';
  ($('only1m') as HTMLInputElement).checked = false;
  ($('onlyvision') as HTMLInputElement).checked = false;
  showTab('paneenv');
  render();
  // A broken file still gets its banners and path, but no fields to edit.
  $('form').style.display = s.parseError ? 'none' : '';
  $('panemodels').style.display = s.parseError ? 'none' : '';
}

async function save(): Promise<void> {
  const btn = $('save') as HTMLButtonElement;
  btn.disabled = true;
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
      $('banners').replaceChildren(el('div', { class: 'banner err' },
        el('b', { text: 'Not saved — the file changed on disk. ' }),
        `${tool.name} (or another editor) wrote it since this page loaded. Your edits are still here. `,
        'Reload to discard them, or Save again to overwrite.'));
      baseMtimeMs = j.mtimeMs;
      btn.disabled = false;
      return;
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    baseMtimeMs = j.mtimeMs;
    dirty = false;
    $('dot').classList.remove('on');
    toast(`saved ${j.bytes} bytes → ${prettyPath(j.file)}${j.backup ? ' (previous version backed up)' : ''}`);
  } catch (e) {
    $('banners').replaceChildren(
      el('div', { class: 'banner err' }, `Save failed: ${(e as Error).message}`));
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- theme

// Manual light/dark toggle. No choice stored means CSS follows the OS via
// :root:not([data-theme]); a stored choice wins via [data-theme]. Guarded for
// non-browser shims (check-ui), where localStorage/matchMedia/documentElement
// do not exist — the page still works, it just keeps the default theme.
function storedTheme(): 'light' | 'dark' | null {
  try {
    const t = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null;
    return t === 'light' || t === 'dark' ? t : null;
  } catch { return null; }
}

function osTheme(): 'light' | 'dark' {
  try {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch { /* no media query here */ }
  return 'light';
}

function currentTheme(): 'light' | 'dark' {
  const root = (document as unknown as { documentElement?: HTMLElement }).documentElement;
  try {
    const attr = root ? root.getAttribute('data-theme') : null;
    if (attr === 'light' || attr === 'dark') return attr;
  } catch { /* shim without attributes */ }
  return storedTheme() || osTheme();
}

function syncThemeButton(t: 'light' | 'dark'): void {
  const btn = document.getElementById('theme');
  if (!btn) return;
  const dark = t === 'dark';
  btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function paintTheme(t: 'light' | 'dark'): void {
  const root = (document as unknown as { documentElement?: HTMLElement }).documentElement;
  if (root) {
    try { root.setAttribute('data-theme', t); } catch { /* shim */ }
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('theme', t);
  } catch { /* private mode */ }
  syncThemeButton(t);
}

function initTheme(): void {
  syncThemeButton(currentTheme());
  $('theme').addEventListener('click', () => {
    paintTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  // No manual choice: keep the icon in step when the OS flips. The CSS follows
  // on its own; only the button needs refreshing.
  try {
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', () => {
      if (!storedTheme()) syncThemeButton(osTheme());
    });
  } catch { /* older browsers */ }
}

// ---------------------------------------------------------------- wire up

// Reload only ever runs from the editor, so a failure belongs in its banners —
// obnote lives on the landing screen and would be invisible from here.
function reload(): void {
  load().catch(e => {
    $('banners').replaceChildren(
      el('div', { class: 'banner err' }, `Failed to load: ${(e as Error).message}`));
  });
}

$('reload').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  reload();
});

$('save').addEventListener('click', () => { void save(); });

$('scanbtn').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes and scan again?')) return;
  dirty = false;
  void scan();
});

$('switch').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes and start over?')) return;
  dirty = false;
  hideToast();
  showLanding();
});

$('addvar').addEventListener('click', () => {
  if (tool.mode === 'simple') return;   // the section is not offered for these tools
  const input = $('newkey') as HTMLInputElement;
  const k = input.value.trim();
  if (!k) return;
  setEnv(k, '');
  input.value = '';
  render();
});

$('newkey').addEventListener('keydown', (e: Event) => {
  if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); $('addvar').click(); }
});

$('loadmodels').addEventListener('click', () => { void loadModels(); });

$('modelfilter').addEventListener('input', (e: Event) => {
  filter = (e.target as HTMLInputElement).value;
  renderModels();
});

$('only1m').addEventListener('change', (e: Event) => {
  only1m = (e.target as HTMLInputElement).checked;
  renderModels();
});

$('onlyvision').addEventListener('change', (e: Event) => {
  onlyVision = (e.target as HTMLInputElement).checked;
  renderModels();
});

addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// The tool registry, fetched once at boot so the picker is drawn from the server's
// own list rather than a copy kept in this file. A failure is not fatal: the picker
// falls back to the one tool this page can name on its own, and the scan that
// follows carries the registry anyway.
async function loadTools(): Promise<void> {
  try {
    const r = await fetch('/api/tools');
    if (!r.ok) return;
    const j: { tools?: Tool[] } = await r.json();
    if (Array.isArray(j.tools) && j.tools.length) { tools = j.tools; renderTools(); }
  } catch { /* the landing still works with the default tool */ }
}

// Open on the landing screen: the scan button is the entry point, always.
initTheme();
renderTabs();
showLanding();
void loadTools();
