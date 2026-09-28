// CONFIG READER — env editor. The landing picks a tool; the form edits that file's
// `env` object and posts the whole document back. Served as /app.js by type stripping.

interface Field {
  key: string;
  label: string;
  hint: string;
  kind: 'text' | 'number' | 'secret';
  group: 'connection' | 'models' | 'runtime' | 'roles';
  placeholder?: string;
}

interface ModelsResponse {
  url?: string;
  models?: string[] | null;
  caps?: Record<string, ModelCaps>;
  error?: string;
}

// What one endpoint said about one model. `caps` is passed through from the endpoint,
// so its keys are that gateway's vocabulary and not a list this page keeps. `meta` is
// what this page derived for the display: a human name, free, sunset, and the two
// list-valued facts that go in the tooltip.
interface ModelMeta {
  name?: string;
  description?: string;
  free?: boolean;
  sunset?: string;
  efforts?: string[];
  endpoints?: string[];
}

interface ModelCaps {
  provider?: string;
  ctx?: number;
  maxOut?: number;
  caps?: Record<string, unknown>;
  meta?: ModelMeta;
}

interface Tool {
  id: string;
  name: string;
  mode: 'env' | 'simple';
  bin?: string;                             // the CLI name, for the installed badge's tooltip
  // Whether the CLI is on PATH. Undefined on the local fallback, which is a guess.
  installed?: boolean;
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

// The values every non-Claude tool is edited through. The server patches them into
// that tool's own config format; which keys exist depends on the tool (see SIMPLE_FIELDS).
type SimpleValues = Record<string, string>;

// Grouped in setup order: where requests go, which model answers, then the knobs.
const GROUPS: Record<Field['group'], string> = {
  connection: 'Connection',
  models: 'Models',
  runtime: 'Runtime',
  roles: 'Model roles (optional)',
};
const GROUP_ORDER: Field['group'][] = ['connection', 'models', 'runtime', 'roles'];

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
    hint: 'Handles the small background calls: titles, summaries, quick checks.' },
  { key: 'ANTHROPIC_DEFAULT_FABLE_MODEL', label: 'Fable model', kind: 'text', group: 'models',
    hint: 'Answers requests that ask for Fable.' },
  { key: 'API_TIMEOUT_MS', label: 'API timeout', kind: 'number', group: 'runtime',
    placeholder: '3000000', hint: 'How long one request may take, in milliseconds. 3000000 is 50 minutes.' },
  { key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', label: 'Auto-compact window', kind: 'number', group: 'runtime',
    placeholder: '498000',
    hint: 'The token count that triggers auto-compact. 198000 is a 200K window, 498000 is 500K; empty lets Claude Code derive it from the model.' },
  { key: 'CLAUDE_CODE_AUTO_MODE_SERVER', label: 'Auto mode server', kind: 'text', group: 'runtime',
    placeholder: '0', hint: 'Set to 0 to turn the auto-mode server off.' },
];

const KNOWN: Set<string> = new Set(FIELDS.map(f => f.key));

// One field set per tool: the three shared values, plus the model slots that tool has
// grown — Codex and OpenCode each spawn a subagent, Hermes reads a model per role.
const CONNECTION_FIELDS: Field[] = [
  { key: 'baseUrl', label: 'Base URL', kind: 'text', group: 'connection',
    placeholder: 'http://localhost:20128',
    hint: 'Where this tool sends its requests. The /v1 suffix is added for you.' },
  { key: 'apiKey', label: 'Auth token', kind: 'secret', group: 'connection',
    hint: 'Bearer token for that endpoint. Stored as plain text in the tool\'s own config.' },
];
const SUBAGENT_FIELD: Field = {
  key: 'subagentModel', label: 'Subagent model', kind: 'text', group: 'models',
  placeholder: 'provider/model-id',
  hint: 'The model spawned agents use. Empty leaves the subagent setting as it is.',
};

// The model slots Hermes reads besides its default: `delegation` is its own top-level
// block, the rest are keys under `auxiliary:`. The list is 9router's.
const HERMES_ROLES: { id: string; label: string }[] = [
  { id: 'delegation', label: 'Delegation (subagents)' },
  { id: 'vision', label: 'Vision' },
  { id: 'web_extract', label: 'Web Extract' },
  { id: 'compression', label: 'Compression' },
  { id: 'title_generation', label: 'Title Generation' },
  { id: 'approval', label: 'Approval' },
  { id: 'skills_hub', label: 'Skills Hub' },
  { id: 'mcp', label: 'MCP' },
  { id: 'memory_query_rewrite', label: 'Memory Query Rewrite' },
  { id: 'background_review', label: 'Background Review' },
  { id: 'curator', label: 'Curator' },
  { id: 'monitor', label: 'Monitor' },
];

const SIMPLE_FIELDS: Record<string, Field[]> = {
  codex: [
    ...CONNECTION_FIELDS,
    { key: 'model', label: 'Model', kind: 'text', group: 'models',
      hint: 'The model this tool asks for by default.' },
    SUBAGENT_FIELD,
  ],
  opencode: [
    ...CONNECTION_FIELDS,
    { key: 'model', label: 'Model', kind: 'text', group: 'models',
      hint: 'The model this tool asks for by default. Every model saved here stays in the provider\'s list.' },
    SUBAGENT_FIELD,
  ],
  hermes: [
    ...CONNECTION_FIELDS,
    { key: 'model', label: 'Default model', kind: 'text', group: 'models',
      hint: 'The model Hermes asks for by default.' },
    ...HERMES_ROLES.map((r): Field => ({
      key: r.id, label: r.label, kind: 'text', group: 'roles',
      placeholder: 'inherit default',
      hint: 'The model this role uses. Empty leaves the role as it is in the file.',
    })),
  ],
};

// Claude Code reads a trailing [1m] as "this model has a 1M window"; without it it
// assumes 200K. The suffix must be last, so an existing marker is stripped first.
const CONTEXT_MARKER = /\[1m\]$/i;
const WINDOW_1M = 1_000_000;

const stripMarker = (id: string): string => id.replace(CONTEXT_MARKER, '').trim();

// Fields that name a model get the picker button, derived rather than listed twice.
const ALL_FIELDS: Field[] = [...FIELDS, ...Object.values(SIMPLE_FIELDS).flat()];
const MODEL_KEYS: Set<string> = new Set(
  ALL_FIELDS.filter(f => f.group === 'models' || f.group === 'roles').map(f => f.key));

const fieldOf = (key: string): Field | undefined => ALL_FIELDS.find(f => f.key === key);

// The field set for one tool: Claude Code owns its whole settings file, the other
// three are patched into their own formats.
const fieldsFor = (t: Tool): Field[] => (t.mode === 'simple' ? SIMPLE_FIELDS[t.id] || [] : FIELDS);

// ------------------------------------------------------------------- state

let doc: Record<string, unknown> = {};   // the whole selected file
let filePath = '';
let baseMtimeMs = 0;
let home = '';                            // for shortening paths to ~
let dirty = false;
// One layout, two states: the picker alone, or the rail plus the editor.
let opened = false;

// Claude Code is the default and the only tool whose file is parsed as a document.
let tool: Tool = { id: 'claude', name: 'Claude Code', mode: 'env' };
let tools: Tool[] = [tool];

// The field that opened the picker: the dialog writes there and nowhere else.
let targetKey = '';

// The simple-mode draft, held outside the DOM so a re-render cannot lose it.
let values: SimpleValues = {};

// `loaded` is the full list from the endpoint; the rest only narrows it in the view.
let models: string[] = [];
let caps: Record<string, ModelCaps> = {};   // id -> what the endpoint reported about it
let loaded = false;
let filter = '';
let only1m = false;
let onlyVision = false;
let modelError = '';                      // '' | the endpoint's reason | a fetch failure
let modelsUrl = '';                       // the URL the list came from, for the note
let loadedFor = '';                       // base URL + token the list was read with

// A saved endpoint: the three values every tool asks for, typed once. `hasKey` is
// what the server said — the token itself is fetched per row, on Apply, and never
// rides the list reply.
interface Connection { name: string; baseUrl: string; model: string; hasKey?: boolean }
interface ConnectionsResponse {
  file?: string; exists?: boolean; atRest?: boolean;
  profiles?: Connection[]; error?: string;
}

let conns: Connection[] = [];     // the working copy the dialog edits
let connsLoaded = false;          // a reply has arrived at least once
let connsDirty = false;           // the working copy differs from the file
let connsError = '';              // the server's sentence, when a call failed
let connsAtRest = false;          // whether the server encrypts the token
let connsFile = '';               // where the store lives, for the note

// The form keys that hold the endpoint, per mode. Claude Code names them
// ANTHROPIC_*, the other three are patched through baseUrl/apiKey/model.
const connKeys = (): { base: string; key: string; model: string } => (tool.mode === 'simple'
  ? { base: 'baseUrl', key: 'apiKey', model: 'model' }
  : { base: 'ANTHROPIC_BASE_URL', key: 'ANTHROPIC_AUTH_TOKEN', model: 'ANTHROPIC_MODEL' });

// Does this saved endpoint describe what the form holds right now? Derived, never
// stored: a stored flag would go stale the moment the form is edited by hand.
function connMatches(c: Connection): boolean {
  const k = connKeys();
  const e = env();
  const url = (c.baseUrl || '').trim();
  if (!url || url !== (e[k.base] || '').trim()) return false;
  const m = (c.model || '').trim();
  return !m || stripMarker(m) === stripMarker(e[k.model] || '');
}

// Elements are found by their data-js hook, never by a CSS class, so renaming a
// class for styling can never break behaviour.
const $ = (name: string): HTMLElement =>
  document.querySelector(`[data-js="${name}"]`) as HTMLElement;

// The two places that write into one card in place look it up by key, not by class.
const fieldInput = (key: string): HTMLInputElement | null =>
  document.querySelector(`[data-field="${key}"]`) as HTMLInputElement | null;
const cardOf = (key: string): HTMLElement | null =>
  document.querySelector(`[data-card="${key}"]`) as HTMLElement | null;

// Inline SVG glyphs (currentColor): no icon font and no CDN, so this works offline.
const ICONS: Record<string, string> = {
  eye: '<path d="M1.5 8S3.7 3.8 8 3.8 14.5 8 14.5 8 12.3 12.2 8 12.2 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  eyeSlash: '<path d="M1.5 8S3.7 3.8 8 3.8c1.4 0 2.7.5 3.8 1.2M14.5 8S12.3 12.2 8 12.2c-1.4 0-2.7-.5-3.8-1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  trash: '<path d="M6 2h4v1.5h3V5H3V3.5h3V2zm-3.2 4h10.4l-.9 8.2a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8L2.8 6z" fill="currentColor"/>',
  xmark: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  arrowUp: '<path d="M8 13V3.6M3.6 8L8 3.6 12.4 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13.6 2.4v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  moon: '<path d="M14 9.5A5.5 5.5 0 0 1 6.5 2 5.5 5.5 0 1 0 14 9.5z" fill="currentColor"/>',
  sun: '<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  power: '<path d="M8 2.5v5.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M11.7 4.4a5 5 0 1 1-7.4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  // A test is one tiny request: a bolt, not a magnifier.
  bolt: '<path d="M9.5 1L3 9h3.5L6 15l7-8H9.5z" fill="currentColor"/>',
  // The model picker opens a list to choose from.
  list: '<path d="M6 4h7M6 8h7M6 12h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/>',
  // Capability glyphs. Anything the endpoint reports that has no glyph here still
  // renders, with a dot and its own key as the label.
  doc: '<path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  wave: '<path d="M2 8h1.5M5 4.5v7M8 2.5v11M11 5.5v5M14 7.5h-1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
  speaker: '<path d="M3 6h2.5L9 3v10L5.5 10H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M11.5 6a3 3 0 0 1 0 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  film: '<rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 3.5v9M10 3.5v9" stroke="currentColor" stroke-width="1.4"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.8" cy="6.4" r="1.2" fill="currentColor"/><path d="M3 11.5l3.5-3 2.5 2.2L11 8.5l2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  globe: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.4 8h11.2M8 2.4c1.6 1.7 2.4 3.6 2.4 5.6S9.6 12.9 8 13.6C6.4 12.9 5.6 11 5.6 8s.8-3.9 2.4-5.6z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  wrench: '<path d="M10.6 2.4a3.6 3.6 0 0 1-4.4 4.6l-3.2 3.2a1.6 1.6 0 1 0 2.2 2.2l3.2-3.2a3.6 3.6 0 0 1 4.6-4.4L11 6.4l1.4 1.4 1.6-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  brain: '<path d="M6.5 2.5a2.5 2.5 0 0 0-2.5 2.5 2.2 2.2 0 0 0-1 4 2.4 2.4 0 0 0 1.6 3.6 2.4 2.4 0 0 0 4.4-1V4a1.5 1.5 0 0 0-2.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 4.6a2 2 0 0 1 2.4 1.9 2.2 2.2 0 0 1 .7 4.2 2.2 2.2 0 0 1-3.1 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  dot: '<circle cx="8" cy="8" r="2.6" fill="currentColor"/>',
  // Thinking, as the three facts a gateway reports separately. A toggle switch for
  // "this can be turned off", level sliders for "the effort is settable".
  toggle: '<rect x="1.6" y="5" width="12.8" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.2" cy="8" r="1.9" fill="currentColor"/>',
  sliders: '<path d="M2.5 5h11M2.5 11h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="5" r="1.7" fill="currentColor"/><circle cx="10.5" cy="11" r="1.7" fill="currentColor"/>',
};

// Capability keys whose auto-humanized name reads badly. Everything else falls back to
// humanize(), so a key nobody anticipated still gets a label.
const CAP_LABELS: Record<string, string> = {
  thinkingCanDisable: 'Thinking can be turned off',
  thinkingEffortSupported: 'Reasoning effort is settable',
};

// Capability key -> glyph. The key list belongs to the endpoint, so this only names
// the ones worth a picture; everything else falls back to a dot and its own label.
const CAP_ICONS: Record<string, string> = {
  vision: 'eye', pdf: 'doc', audioInput: 'wave', audioOutput: 'speaker',
  videoInput: 'film', imageOutput: 'image', search: 'globe', tools: 'wrench',
  reasoning: 'brain',
  // Thinking is reported as three separate facts by some gateways: that it exists
  // (reasoning), that it can be turned off, and that the effort level is settable.
  thinkingCanDisable: 'toggle',
  thinkingEffortSupported: 'sliders',
};

// "audioInput" -> "Audio input", "pdf" -> "Pdf".
const humanize = (k: string): string => {
  const s = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function icon(name: string): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const doc = document as unknown as Document & { createElementNS?: (ns: string, tag: string) => Element };
  const s = (typeof doc.createElementNS === 'function' ? doc.createElementNS(NS, 'svg') : document.createElement('svg')) as unknown as HTMLElement;
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'icon');
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
  if (tool.mode === 'simple') return values;
  const e = doc.env;
  return e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, string>) : {};
};

function setEnv(key: string, value: string): void {
  if (tool.mode === 'simple') {
    values[key] = value;
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
  $('actionbar-dot').classList.add('actionbar__dot--dirty');
  ($('save') as HTMLButtonElement).disabled = false;
}

// Redraw one field card in place: rebuilding the form would replay every other
// card's entrance animation for a change that touched one field.
function refreshCard(key: string): void {
  const card = cardOf(key);
  const f = fieldOf(key);
  if (card && f) card.replaceWith(fieldCard(f));
}

// Case folding follows the platform: Linux paths are case-sensitive.
let platform = '';
const foldCase = (s: string): string =>
  platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;

// ~/.claude/settings.json reads better than the full path; the exact one stays in
// the title. Only a leading home dir is shortened.
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

// One card per tool; picking one scans it and opens the editor. The installed badge
// is the one thing a user cannot read off the config file, and unknown stays silent.
function renderTools(): void {
  // --i is the card's index, so the landing's entrance animation can stagger them.
  $('tool-picker').replaceChildren(...tools.map((t, i) => el('button', {
    class: `tool-card${t.id === tool.id && opened ? ' tool-card--selected' : ''}`,
    type: 'button',
    style: `--i:${i}`,
    'data-tool': t.id,
    'aria-pressed': String(t.id === tool.id && opened),
    onclick: () => openTool(t),
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
async function scan(): Promise<void> {
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
    home = j.home;
    platform = j.platform;
    // The registry rides along with every scan, so an early picker gets corrected.
    if (j.tools) { tools = j.tools; }
    await load();
  } catch (e) {
    $('rail-note').textContent = `Scan failed: ${(e as Error).message}`;
  } finally {
    card?.classList.remove('tool-card--busy');
    renderTools();
  }
}

// Back to the picker: the layout closes, the editor empties, nothing is fetched.
function closeEditor(): void {
  opened = false;
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

// ---------------------------------------------------------------- routing

// The open tool is the URL: #claude, #codex, … Pushing an entry on open means the
// browser's own Back closes the editor, Forward reopens it, and a link to a tool
// lands on that tool.
const toolFromUrl = (): Tool | null => {
  const id = location.hash.slice(1);
  return tools.find(t => t.id === id) || null;
};

// Picking a tool, from a card, a link, or a Back/Forward step. `keepUrl` is for the
// history handler: a cancelled confirm has to put the entry back, or the URL would
// say one tool while the screen shows another.
function openTool(t: Tool, keepUrl = false): void {
  if (t.id === tool.id && opened) return;
  if ((dirty || connectionsOpen()) && !confirm('Discard unsaved changes and open another tool?')) {
    if (keepUrl) history.pushState({ tool: tool.id }, '', `#${tool.id}`);
    return;
  }
  dirty = false;
  tool = t;
  $('rail-note').textContent = '';
  void scan();
}

addEventListener('popstate', () => {
  const t = toolFromUrl();
  if (t) { openTool(t, true); return; }
  if ((dirty || connectionsOpen()) && !confirm('Discard unsaved changes and go back to the tool list?')) {
    history.pushState({ tool: tool.id }, '', `#${tool.id}`);
    return;
  }
  dirty = false;
  closeEditor();
});

// ---------------------------------------------------------------- editor

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
function otherRow(key: string): HTMLElement {
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

function render(): void {
  opened = true;
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

// ------------------------------------------------------------------- models

// A window as a person reads it: 1M, 200K, or the plain number.
const fmtWindow = (n: number): string =>
  n >= WINDOW_1M ? `${+(n / WINDOW_1M).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : String(n);

function openPicker(key: string): void {
  targetKey = key;
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

function closePicker(): void {
  const dlg = $('model-picker') as HTMLDialogElement;
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
}

// A click that lands outside the panel closes it. Anything inside the panel is not a
// dismissal, and a keyboard or synthetic click carries no coordinates at all — so the
// target is what decides, and the box only separates the dialog's own padding from the
// backdrop behind it. One handler, both dialogs.
function outsideClick(hookName: string, close: () => void): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    const dlg = $(hookName);
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  };
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
  toast(ok ? `${id} answered in ${ms} ms` : `${id} did not answer: ${error || 'no answer'}`);
  btn.classList.remove('model-row__test--busy');
}

// The same probe, from the form: it reads the field itself, so a model can be checked
// without opening the dialog, and before it is saved. The icon stays put — only the
// colour and the tooltip carry the result.
function fieldTestButton(f: Field, input: HTMLInputElement): HTMLElement {
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
  toast(ok ? `${id} answered in ${ms} ms` : `${id} did not answer: ${error || 'no answer'}`);
  btn.classList.remove('field-card__test--busy');
}

// The provider the endpoint named, or the id's own prefix when it named none.
function providerOf(id: string): string {
  const named = caps[stripMarker(id)]?.provider;
  if (named) return named;
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : 'other';
}

function renderModels(): void {
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

async function loadModels(force: boolean): Promise<void> {
  // Read through the seam, so this also works for a tool using baseUrl/apiKey.
  const baseUrl = env()[tool.mode === 'simple' ? 'baseUrl' : 'ANTHROPIC_BASE_URL'] || '';
  const apiKey = env()[tool.mode === 'simple' ? 'apiKey' : 'ANTHROPIC_AUTH_TOKEN'] || '';
  // Re-read only when the endpoint changes, when the last read failed, or on demand.
  const sig = `${baseUrl}\n${apiKey}`;
  if (!force && loaded && sig === loadedFor) return;
  if (!baseUrl) {
    // The server needs a URL, and the default Anthropic API is not listable here.
    loaded = false;
    models = [];
    caps = {};
    modelError = 'No Base URL is set. Fill in the Base URL field, then reopen this picker.';
    renderModels();
    return;
  }

  const btn = $('model-picker-reload') as HTMLButtonElement;
  btn.disabled = true;
  btn.classList.add('button--busy');
  // A fetch in flight is not a loaded list: the count, the note and the rows all go,
  // and the list shows its spinner. Leaving `loaded` true here painted a stale count
  // over a list that was being replaced.
  loaded = false;
  modelError = '';
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
    models = (j.models || []).slice().sort((a, b) => a.localeCompare(b));
    caps = j.caps || {};
    modelsUrl = j.url || '';
    loaded = true;
    loadedFor = sig;
    // Keep the endpoint's own reason: "it returned no models" loses why.
    modelError = j.models ? '' : (j.error || 'this endpoint does not provide a model list.');
  } catch (e) {
    models = [];
    caps = {};
    loaded = false;
    modelError = `Could not load models: ${(e as Error).message}`;
  } finally {
    btn.classList.remove('button--busy');
    btn.disabled = false;
    renderModels();
  }
}

// ---------------------------------------------------------------------- io

let toastTimer = 0;
// A popover, not a z-index: a modal <dialog> lives in the top layer, where no z-index
// reaches. A popover lives there too — but showing it once is not enough. The dialog
// that opens later is inserted after it in the top layer and paints over it, so every
// toast re-promotes itself. hidePopover() on an open popover is a no-op, not an error,
// which is why the pair can run unconditionally.
type Popover = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
const toastEl = (): Popover => $('toast') as Popover;

function toast(msg: string): void {
  const t = toastEl();
  t.textContent = msg;
  // Re-promote: without this the second toast of a session paints behind the picker.
  try { t.hidePopover?.(); } catch { /* not open */ }
  try { t.showPopover?.(); } catch { /* unsupported */ }
  t.classList.add('toast--shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('toast--shown'), 2600);
}

function hideToast(): void {
  clearTimeout(toastTimer);
  const t = toastEl();
  t.classList.remove('toast--shown');
  t.textContent = '';
  try { t.hidePopover?.(); } catch { /* already closed */ }
}

async function load(): Promise<void> {
  const s: SettingsResponse = await fetch(`/api/settings?tool=${encodeURIComponent(tool.id)}`).then(r => r.json());
  if (!s.selected) { closeEditor(); return; }

  filePath = s.file || '';
  baseMtimeMs = s.mtimeMs || 0;

  const bs: HTMLElement[] = [];
  if (tool.mode === 'simple') {
    values = { ...(s.values || {}) };
    doc = {};
  } else {
    doc = s.parsed || {};
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

  dirty = false;
  $('actionbar-dot').classList.remove('actionbar__dot--dirty');
  ($('save') as HTMLButtonElement).disabled = !!s.parseError;
  $('editor-banners').replaceChildren(...bs);
  // A fresh file means the previous list belongs to a different endpoint.
  models = [];
  caps = {};
  loaded = false;
  modelError = '';
  filter = '';
  only1m = false;
  onlyVision = false;
  modelsUrl = '';
  loadedFor = '';
  targetKey = '';
  ($('model-picker-filter') as HTMLInputElement).value = '';
  ($('filter-1m') as HTMLInputElement).checked = false;
  ($('filter-vision') as HTMLInputElement).checked = false;
  render();
  // A broken file still gets its banners and path, but no fields to edit.
  $('editor-form').style.display = s.parseError ? 'none' : '';
}

async function save(): Promise<void> {
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
      baseMtimeMs = j.mtimeMs;
      return;
    }
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    baseMtimeMs = j.mtimeMs;
    dirty = false;
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

// ---------------------------------------------------------------- theme

// A stored choice wins; with none, the CSS follows the OS. Guarded for the check-ui
// shim, where localStorage and matchMedia do not exist.
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
  const btn = document.querySelector('[data-js="theme-toggle"]') as HTMLElement | null;
  if (!btn) return;
  const dark = t === 'dark';
  // Swap the glyph only: the button also carries its label span.
  const glyph = btn.querySelector('.icon');
  const next = icon(dark ? 'sun' : 'moon');
  if (glyph) glyph.replaceWith(next); else btn.prepend(next);
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
  $('theme-toggle').addEventListener('click', () => {
    paintTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  // With no manual choice, keep the icon in step when the OS flips.
  try {
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', () => {
      if (!storedTheme()) syncThemeButton(osTheme());
    });
  } catch { /* older browsers */ }
}

// ------------------------------------------------------------- connections

function connInput(i: number, field: keyof Connection): HTMLInputElement | null {
  return document.querySelector(`[data-conn="${i}:${field}"]`) as HTMLInputElement | null;
}

const connectionsOpen = (): boolean =>
  (($('connections') as unknown as HTMLDialogElement).open === true);

// One row is one endpoint: its name, then the three values. The name is a field like
// any other, so nothing has to be re-rendered while it is being typed.
function connRow(c: Connection, i: number): HTMLElement {
  const field = (key: keyof Connection, label: string, kind: 'text' | 'secret', placeholder = ''): HTMLElement => {
    const input = el('input', {
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
        connsDirty = true;
        connsError = '';
        ($('connections-save') as HTMLButtonElement).disabled = false;
      },
    }) as HTMLInputElement;
    const row = el('div', { class: 'conn__row' }, input);
    if (kind === 'secret') {
      const eye = el('button', {
        class: 'button button--ghost button--icon button--small', type: 'button',
        title: 'reveal the token', 'aria-label': 'Show token',
        onclick: () => {
          const shown = input.type === 'password';
          input.type = shown ? 'text' : 'password';
          eye.replaceChildren(icon(shown ? 'eyeSlash' : 'eye'));
        },
      }, icon('eye'));
      row.append(eye);
    }
    return el('label', { class: 'conn__field' }, el('span', { class: 'conn__label', text: label }), row);
  };

  const badges: HTMLElement[] = [];
  if (c.hasKey) {
    badges.push(el('span', {
      class: 'badge badge--ok', text: 'key stored',
      title: connsAtRest ? 'encrypted at rest' : 'stored as plain text',
    }));
  } else {
    badges.push(el('span', { class: 'badge', text: 'no key' }));
  }
  // Only worth saying when a tool is open and the endpoint is not the one in the form.
  if (opened && connMatches(c)) badges.push(el('span', { class: 'badge badge--ok', text: 'in the form' }));

  const apply = el('button', {
    class: 'button button--ghost button--small conn__apply', type: 'button',
    title: `Fill ${tool.name}'s form from this endpoint`,
    'aria-label': `Apply ${c.name || 'this endpoint'} to ${tool.name}`,
  }, 'Apply') as HTMLButtonElement;
  apply.addEventListener('click', () => { void applyConnection(c, apply); });

  return el('section', { class: 'conn', 'data-conn-row': String(i) },
    el('div', { class: 'conn__top' },
      field('name', 'Name', 'text', 'local gateway'),
      ...badges,
      el('button', {
        class: 'button button--ghost button--icon button--small button--danger', type: 'button',
        title: `delete ${c.name || 'this endpoint'}`, 'aria-label': `Delete ${c.name || 'this endpoint'}`,
        onclick: () => {
          conns.splice(i, 1);
          connsDirty = true;
          renderConnections();
          ($('connections-save') as HTMLButtonElement).disabled = false;
        },
      }, icon('trash'))),
    field('baseUrl', 'Base URL', 'text', 'http://localhost:20128'),
    field('model', 'Model', 'text', 'provider/model-id'),
    field('apiKey', 'Token', 'secret', c.hasKey ? 'leave empty to keep the stored key' : 'paste the token'),
    opened ? apply : null);
}

function renderConnections(): void {
  const list = $('connections-list');
  $('connections-sub').textContent = opened
    ? `Apply fills ${tool.name}'s form. Save is what writes the file.`
    : 'Open a tool to apply one of these to its form.';
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
  connsLoaded = false;
  connsError = '';
  renderConnections();
  try {
    const r = await fetch('/api/connections');
    const j: ConnectionsResponse = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    conns = (j.profiles || []).map(p => ({
      name: p.name || '', baseUrl: p.baseUrl || '', model: p.model || '', hasKey: !!p.hasKey,
    }));
    connsAtRest = !!j.atRest;
    connsFile = j.file || '';
    connsDirty = false;
  } catch (e) {
    conns = [];
    connsError = `could not read the saved endpoints: ${(e as Error).message}`;
  }
  connsLoaded = true;   // an error shows as a note, not as a spinner that never stops
  renderConnections();
}

function openConnections(): void {
  const dlg = $('connections') as unknown as HTMLDialogElement;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  void loadConnections();
}

function closeConnections(): void {
  const dlg = $('connections') as unknown as HTMLDialogElement;
  if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
}

// Fill the form from one endpoint. The token is asked for by name, one row at a time,
// and nothing here writes a config — Save is still the only writer.
async function applyConnection(c: Connection, btn: HTMLButtonElement): Promise<void> {
  if (!opened) return;
  if (dirty && !confirm('Discard the unsaved changes in the form and fill it from this endpoint?')) return;
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
    connsError = `could not read the stored token: ${(e as Error).message}`;
    renderConnections();
    return;
  } finally {
    btn.classList.remove('button--busy');
    btn.disabled = false;
  }
  setEnv(k.base, c.baseUrl);
  // A model picked from a gateway may carry Claude Code's [1m] marker; the other three
  // tools read the bare id.
  if (c.model) setEnv(k.model, stripMarker(c.model));
  if (apiKey) setEnv(k.key, apiKey);
  connsDirty = false;
  closeConnections();
  // The dialog covered the form, so a full redraw is invisible here.
  render();
  toast(`filled from ${c.name} — Save writes it to ${tool.name}`);
}

async function saveConnections(): Promise<void> {
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
    connsDirty = false;
    connsError = '';
    toast(`saved ${j.count} endpoint${j.count === 1 ? '' : 's'}`);
    await loadConnections();
  } catch (e) {
    connsError = `not saved: ${(e as Error).message}`;
    renderConnections();
  } finally {
    btn.classList.remove('button--busy');
    btn.disabled = !connsDirty;
  }
}

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

$('reload').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  reload();
});

$('save').addEventListener('click', () => { void save(); });

// The button only exists while the editor is open, so it needs no state check. It
// always lands on the picker: the sidebar's way out is the landing page, not one
// step back through whatever tools were opened before.
$('editor-back').addEventListener('click', () => {
  if (dirty && !confirm('Discard unsaved changes and go back to the tool list?')) return;
  dirty = false;
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

$('model-picker-close').addEventListener('click', closePicker);

// A click outside the panel closes it.
$('model-picker').addEventListener('click', outsideClick('model-picker', closePicker));

$('model-picker-filter').addEventListener('input', (e: Event) => {
  filter = (e.target as HTMLInputElement).value;
  renderModels();
});

$('filter-1m').addEventListener('change', (e: Event) => {
  only1m = (e.target as HTMLInputElement).checked;
  renderModels();
});

$('filter-vision').addEventListener('change', (e: Event) => {
  onlyVision = (e.target as HTMLInputElement).checked;
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
    if (Array.isArray(j.tools) && j.tools.length) { tools = j.tools; renderTools(); }
  } catch { /* the landing still works with the default tool */ }
  // A link to a tool opens that tool, once the registry that names it has arrived.
  const t = toolFromUrl();
  if (t) openTool(t);
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
$('stop-server').addEventListener('click', () => {
  if (!confirm('Stop the server? The page will stop working until you start it again.')) return;
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
$('to-top').append(icon('arrowUp'));
$('stop-server').prepend(icon('power'));
$('connections-open').addEventListener('click', openConnections);
$('connections-close').addEventListener('click', () => {
  if (connsDirty && !confirm('Discard the unsaved endpoints?')) return;
  connsDirty = false;
  closeConnections();
});
// Escape closes a dialog without asking. This editor never throws a typed token away
// silently, so the cancel is intercepted and the confirm decides.
$('connections').addEventListener('cancel', (e: Event) => {
  e.preventDefault();
  if (connsDirty && !confirm('Discard the unsaved endpoints?')) return;
  connsDirty = false;
  closeConnections();
});
$('connections').addEventListener('click', outsideClick('connections', () => {
  if (connsDirty && !confirm('Discard the unsaved endpoints?')) return;
  connsDirty = false;
  closeConnections();
}));
$('connections-new').addEventListener('click', () => {
  conns.push({ name: '', baseUrl: '', model: '', hasKey: false });
  connsDirty = true;
  connsError = '';
  renderConnections();
  ($('connections-save') as HTMLButtonElement).disabled = false;
  connInput(conns.length - 1, 'name')?.focus();
});
$('connections-save').addEventListener('click', () => { void saveConnections(); });
renderTools();
void loadTools();
onScroll();
