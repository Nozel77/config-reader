// Dev-only. Strips app.ts the same way server.js does, runs it against a DOM shim,
// and asserts the contract on both screens: the landing shows one Scan button that
// goes straight to the form, the form shows the nine env fields plus anything else
// in env, and every non-env key is carried through untouched.
//   node tools/check-ui.mjs
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
const js = stripTypeScriptTypes(readFileSync(join(HERE, '..', 'app.ts'), 'utf8'), { mode: 'strip' });

// --- DOM shim ---------------------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {};
    this.className = ''; this.value = ''; this.checked = false; this.style = {};
    this.hidden = false; this.disabled = false; this.type = ''; this.title = '';
    this._text = ''; this._value = '';
    // classList and className are the same attribute in a real DOM: `classList.add`
    // changes what `className` reads back, and a class the markup carried is already
    // in classList. Keeping them as separate stores made a class added through
    // classList invisible to a check on className — and vice versa — which is how a
    // page that works fails its own test.
    //
    // Both close over the Set rather than using `this`: `el.classList.add()` calls
    // add with `this` bound to the classList object, not the element. The Set is
    // mutated in place, never reassigned, so the closures keep pointing at it.
    const cls = new Set();
    Object.defineProperty(this, 'className', {
      get: () => [...cls].join(' '),
      set: v => { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
    });
    this.classList = {
      add(...c) { for (const x of c) cls.add(x); },
      remove(...c) { for (const x of c) cls.delete(x); },
      contains(c) { return cls.has(c); },
      toggle(c, on) { if (on === undefined) on = !cls.has(c); if (on) cls.add(c); else cls.delete(c); return on; },
    };
  }
  get textContent() { return this._text || this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  // A real <select> reports its selected option's value. The app never sets .value
  // on it, so the shim mirrors the browser and falls back to the first option.
  get value() {
    if (this.tagName !== 'SELECT' || this._value) return this._value;
    const opts = this.children.filter(c => c.tagName === 'OPTION');
    return opts.length ? (opts[0].getAttribute('value') || '') : '';
  }
  set value(v) { this._value = String(v); }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === 'id') ids[v] = this;
    if (k === 'data-js') jsHooks[v] = this;
    if (k === 'value') this.value = v;
    if (k === 'type') this.type = v;
    if (k === 'title') this.title = v;
    if (k === 'hidden') this.hidden = true;
    if (k === 'disabled') this.disabled = true;
    // The real DOM treats class and className as one attribute; so does the shim,
    // or a node built with setAttribute('class', ...) is invisible to a .class query.
    if (k === 'class') this.className = v;
  }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this._on ||= {})[type] = fn; }
  fire(type, ev = {}) { if (this._on && this._on[type]) this._on[type]({ target: this, preventDefault() {}, ...ev }); }
  click() { this.fire('click'); }
  // A modal dialog. The shim tracks `open` the way the browser does, so a check can
  // tell "the picker is up" from "the picker is closed".
  showModal() { this.open = true; this.attrs.open = ''; }
  close() { this.open = false; this.attrs.open = undefined; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'open') this.open = false; }
  // The real DOM accepts a raw string as a child and makes a text node of it. The
  // shim has to do the same or a mixed node/string child list silently loses the
  // strings, and a test would pass against a page that renders nothing.
  append(...k) {
    const kids = k.filter(x => x != null).map(textNode);
    for (const c of kids) c.parentNode = this;
    this.children.push(...kids);
  }
  prepend(...k) {
    const kids = k.filter(x => x != null).map(textNode);
    for (const c of kids) c.parentNode = this;
    this.children.unshift(...kids);
  }
  // The real DOM drops a <select>'s value when the option it held is gone. Without
  // this the shim would keep reporting a selection the page has already rebuilt.
  replaceChildren(...k) {
    this.children = k.filter(x => x != null).map(textNode);
    for (const c of this.children) c.parentNode = this;
    if (this.tagName === 'SELECT'
      && !this.children.some(c => c.tagName === 'OPTION' && (c.getAttribute('value') || '') === this._value)) {
      this._value = '';
    }
  }
  // One node going, and one node being swapped for another. Both are how the page
  // now edits itself: a delete redraws its own row, not the whole form. The
  // replacement has to be re-parented the way the real DOM does it, or a second
  // swap on that node is a no-op and the page looks like it stopped updating.
  remove() {
    const p = this.parentNode;
    if (!p) return;
    p.children = p.children.filter(c => c !== this);
    this.parentNode = null;
  }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i < 0) return;
    const kid = textNode(n);
    kid.parentNode = p;
    p.children[i] = kid;
    this.parentNode = null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  // Supports tag, .class, [attr] and [attr="value"] — the forms the page and the
  // checks actually use. Anything else is a selector the harness does not need.
  querySelectorAll(sel, acc = []) {
    const m = /^([a-zA-Z]*)(?:\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(sel.trim());
    const [, tag, cls, attr, val] = m || [];
    const hit = n =>
      (!tag || n.tagName === tag.toUpperCase())
      && (!cls || (n.className || '').split(/\s+/).includes(cls))
      && (!attr || (val === undefined
        ? n.getAttribute(attr) != null
        : n.getAttribute(attr) === val));
    const walk = n => { for (const c of n.children) { if (hit(c)) acc.push(c); walk(c); } };
    walk(this); return acc;
  }
  scrollIntoView() {}
  // The toast is a popover so it can sit over an open modal dialog; the shim only has
  // to record the state the way a browser would.
  showPopover() { this._popoverOpen = true; }
  hidePopover() { this._popoverOpen = false; }
  // The picker focuses its filter box on open; the real element supports both.
  focus() { document.activeElement = this; }
  select() {}
}

// A string child becomes a text node, the way the browser does it.
class TextNode extends El {
  constructor(t) { super('#text'); this._text = String(t); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}
const textNode = x => (x instanceof El ? x : new TextNode(x));

const ids = {};
const jsHooks = {};
// Read id, class and data-js off the real markup, so a check on a static element is
// checking the file, not the shim's defaults.
for (const m of html.matchAll(/<([a-zA-Z]+)([^>]*?)(?:\/>|>([^<]*)<\/\1>|>)/g)) {
  const id = /\bid="([^"]+)"/.exec(m[2]);
  const dataJs = /\bdata-js="([^"]+)"/.exec(m[2]);
  if (!id && !dataJs) continue;
  const node = new El(m[1]);
  const cls = /\bclass="([^"]+)"/.exec(m[2]);
  if (cls) node.className = cls[1];
  if (/\bhidden\b/.test(m[2])) node.hidden = true;
  // Static attributes are read off the file too, so a check on role/aria is
  // checking the markup rather than the shim's defaults.
  for (const a of m[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) node.setAttribute(a[1], a[2]);
  if (m[3]) node.textContent = m[3].trim();
  if (id) ids[id[1]] = node;
  if (dataJs) jsHooks[dataJs[1]] = node;
}
// Every parsed element is also reachable from the document root, so a [data-js]
// lookup through querySelector finds the same nodes the page would.
const docRoot = new El('body');
for (const n of Object.values(jsHooks)) docRoot.append(n);
globalThis.document = {
  createElement: t => new El(t),
  getElementById: id => ids[id] || (ids[id] = new El('div')),
  querySelector: sel => docRoot.querySelector(sel),
  querySelectorAll: sel => docRoot.querySelectorAll(sel),
  activeElement: null,
};
// The page finds elements by their data-js hook; checks do the same.
const hook = name => jsHooks[name] || (jsHooks[name] = new El('div'));
// A field input, looked up the way the page does.
const inputFor = key => docRoot.querySelector(`[data-field="${key}"]`);
// A saved-endpoint row's input, by row index and field name.
const connInput = (i, field) => docRoot.querySelector(`[data-conn="${i}:${field}"]`);
globalThis.addEventListener = () => {};
globalThis.confirm = () => true;
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

// The page routes on the hash, so the harness needs a location and a history that
// behave like the browser's: pushState/replaceState move the URL, back() walks the
// stack and fires popstate the way the real one does.
const historyStack = [{ state: null, url: '/' }];
let historyAt = 0;
const popstateFns = [];
globalThis.location = {
  pathname: '/', search: '', get hash() { return historyStack[historyAt].url.replace(/^[^#]*/, ''); },
};
globalThis.history = {
  get state() { return historyStack[historyAt].state; },
  pushState(state, _title, url) {
    historyStack.splice(historyAt + 1);
    historyStack.push({ state, url: String(url) });
    historyAt = historyStack.length - 1;
  },
  replaceState(state, _title, url) {
    historyStack[historyAt] = { state, url: String(url) };
  },
  back() {
    if (historyAt === 0) return;
    historyAt--;
    for (const fn of popstateFns) fn();
  },
};
// popstate is the one window event the page registers; the stub only needs to keep it.
globalThis.addEventListener = (type, fn) => { if (type === 'popstate') popstateFns.push(fn); };

// --- fixtures ---------------------------------------------------------------
const HOME = os.homedir();
const CFG = join(HOME, '.claude');
const FILE = join(CFG, 'settings.json');
let fixture;
try { fixture = JSON.parse(readFileSync(FILE, 'utf8')); }
catch {
  fixture = {
    env: { ANTHROPIC_BASE_URL: 'http://localhost:20128', ANTHROPIC_AUTH_TOKEN: 'sk-x', API_TIMEOUT_MS: '3000000' },
    permissions: { allow: ['Bash(ls*)'] }, model: 'sonnet',
  };
}
// A non-env key must survive; an env key the UI doesn't know must stay editable.
fixture.env = { ...(fixture.env || {}), WEIRD_EXTRA_VAR: 'keep-me', API_TIMEOUT_MS: 3000000 };
const NON_ENV = Object.keys(fixture).filter(k => k !== 'env');

let scanned = 0;                 // how many times /api/scan was called
const posted = [];
const scanPosted = [];           // the {tool} each scan asked for
let modelCalls = 0;              // how many times /api/models was called
const modelPosted = [];          // the {baseUrl, apiKey} the pane sent
// Per-case reply for /api/test-model, and what the last call sent.
let testReply = { ok: true, ms: 100 };
let tested = null;
// Saved endpoints. The list reply deliberately carries no token — the shim has to
// look like the server, or a check would pass against a page that never asks.
let connReply = { file: join(HOME, '.config-reader', 'connections.json'), exists: true, atRest: false,
  profiles: [
    { name: 'local', baseUrl: 'http://localhost:20128', model: 'knr/a-model', hasKey: true },
    { name: 'remote', baseUrl: 'https://ai.example', model: 'ag/opus-4[1m]', hasKey: false },
  ] };
let revealReply = { apiKey: 'sk-from-store' };
const connPosted = [];
let connGets = 0;      // how many times the dialog read the store
let revealed = null;
// Per-case overrides for the claude GET reply, so a banner path can be exercised.
let claudeOverride = {};
let modelReply = {
  url: 'http://localhost:20128/v1/models',
  models: ['knr/b-model', 'knr/a-model', 'knr/a-model:free', 'ag/opus-4'],
  // The endpoint's own capabilities object, passed through as-is: a key this page has
  // never heard of (madeUp) must still reach the row.
  caps: {
    'knr/a-model': {
      provider: 'knr', ctx: 200000, maxOut: 64000,
      caps: { vision: false, reasoning: true, tools: true, thinkingFormat: 'deepseek', madeUp: true },
    },
    'knr/b-model': {
      provider: 'knr', ctx: 1000000, maxOut: 384000,
      caps: { vision: true, pdf: true, search: true, reasoning: true },
    },
    // The thinking pair ka4 reports: whether it can be switched off, and whether the
    // effort level is settable. Both were falling through to the generic dot.
    'ag/opus-4': {
      provider: 'ag', ctx: 200000, maxOut: 64000,
      caps: { vision: true, reasoning: true, search: true,
        thinkingCanDisable: true, thinkingEffortSupported: true },
      meta: { name: 'Opus 4', free: false },
    },
    // No capabilities at all: the row has to say so rather than guess. It does carry
    // the display facts, which are badges and tooltip lines rather than chips.
    'knr/a-model:free': {
      provider: 'knr', ctx: 0, maxOut: 0, caps: {},
      meta: { name: 'A Model (free)', description: 'Free while in beta.', free: true, sunset: '2027-01-01',
        efforts: ['low', 'medium', 'high'], endpoints: ['chat', 'responses'] },
    },
  },
};

// The registry the server hands back with the first scan. Mirrors TOOLS in server.js.
// The installed flags are a mixed set on purpose: the picker has to show both states,
// and a fixture where everything is true would pass against a page that hardcodes it.
const TOOLS = [
  { id: 'claude', name: 'Claude Code', mode: 'env', bin: 'claude', installed: true },
  { id: 'codex', name: 'Codex', mode: 'simple', bin: 'codex', installed: false },
  { id: 'opencode', name: 'OpenCode', mode: 'simple', bin: 'opencode', installed: true },
  { id: 'hermes', name: 'Hermes Agent', mode: 'simple', bin: 'hermes', installed: false },
];
// A per-tool simple-mode reply, so switching tools is observable end to end.
const SIMPLE = {
  codex: { file: join(HOME, '.codex', 'config.toml'),
    values: { baseUrl: 'http://localhost:20128/v1', apiKey: 'sk-codex', model: 'gpt-5-codex' } },
  opencode: { file: join(HOME, '.config', 'opencode', 'opencode.json'),
    values: { baseUrl: '', apiKey: '', model: '' } },
  hermes: { file: join(HOME, '.hermes', 'config.yaml'),
    values: { baseUrl: 'http://localhost:20128/v1', apiKey: '', model: 'hermes-3', vision: 'hermes-vision' } },
};
const toolOf = url => (new URL(url, 'http://x').searchParams.get('tool') || 'claude');

globalThis.fetch = async (url, opts = {}) => {
  const r = String(url);
  let body;
  if (r.includes('/api/scan')) {
    scanned++;
    const tool = JSON.parse(opts.body || '{}').tool || 'claude';
    scanPosted.push(tool);
    const file = tool === 'claude' ? FILE : SIMPLE[tool].file;
    body = { tool, found: true, file, size: 1446, mtime: Date.now(), configDir: CFG, home: HOME, platform: 'win32', tools: TOOLS };
  } else if (r.includes('/api/tools')) {
    body = { tools: TOOLS };
  } else if (r.includes('/api/models')) {
    modelCalls++;
    modelPosted.push(JSON.parse(opts.body || '{}'));
    body = modelReply;
  } else if (r.includes('/api/test-model')) {
    tested = JSON.parse(opts.body || '{}');
    tested.calls = (tested.calls || 0) + 1;
    body = testReply;
  } else if (r.includes('/api/connections/reveal')) {
    revealed = JSON.parse(opts.body || '{}');
    body = revealReply;
  } else if (r.includes('/api/connections')) {
    if (opts.method === 'POST') { connPosted.push(JSON.parse(opts.body || '{}')); body = { ok: true, count: connPosted.at(-1).profiles.length }; }
    else { connGets++; body = connReply; }
  } else if (r.includes('/api/settings')) {
    const tool = toolOf(r);
    if (opts.method === 'POST') {
      posted.push(JSON.parse(opts.body));
      body = { ok: true, file: tool === 'claude' ? FILE : SIMPLE[tool].file, bytes: 10, mtimeMs: 2, backup: null };
    } else if (tool === 'claude') {
      body = { selected: FILE, tool, file: FILE, exists: true, raw: '', parsed: fixture, eol: '\n', mtimeMs: 1, normalized: false, parseError: null, ...claudeOverride };
    } else {
      body = { selected: SIMPLE[tool].file, tool, file: SIMPLE[tool].file, values: SIMPLE[tool].values,
        exists: tool !== 'opencode', mtimeMs: 1, parseError: null };
    }
  } else {
    body = {};
  }
  // modelReply may carry status/ok so an error path can be exercised.
  const status = (r.includes('/api/models') && modelReply.status) || 200;
  return { ok: (r.includes('/api/models') && modelReply.ok !== undefined) ? modelReply.ok : status === 200,
    status, json: async () => body };
};

// --- run the real script ----------------------------------------------------
const patched = js.replace(/^renderTools\(\);$/m,
  'globalThis.__api = { doc: () => doc, values: () => values, tool: () => tool, env, setEnv, FIELDS, KNOWN, prettyPath, setPlatform: p => { platform = p; }, setHome: h => { home = h; }, opened: () => opened };\nrenderTools();');
if (!patched.includes('__api')) throw new Error('could not hook the script — did the last line of app.ts change?');
new Function(patched)();
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
await settle();

const api = globalThis.__api;
const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---- screen 1: the picker, closed ----------------------------------------
// There is one page and two states now: the rail alone, then the rail plus the
// editor. These assert the closed state and that nothing is fetched until a card
// is actually picked.
ok('opens closed: editor hidden, picker at full width',
  hook('editor').hidden === true && !hook('app').className.includes('app--editor'));
ok('the picker is visible before any interaction', !!hook('tool-picker'));
ok('nothing was fetched before picking a tool', scanned === 0, `${scanned} calls`);
ok('the form is empty before picking a tool', hook('editor-form').querySelectorAll('.field-card').length === 0);
ok('there is no separate Scan button any more', !document.querySelector('[data-js="scan-btn"]'));
ok('the close button is hidden while closed',
  hook('editor-back').className.includes('rail__back'));

// ---- the tool picker -----------------------------------------------------
ok('the landing offers a tool picker', !!hook('tool-picker'));
ok('the picker is built from the server registry', hook('tool-picker').children.length === 4,
  `${hook('tool-picker').children.length} cards`);
ok('the picker lists every tool',
  hook('tool-picker').children.map(c => c.querySelector('.tool-card__name').textContent).join() ===
  'Claude Code,Codex,OpenCode,Hermes Agent',
  hook('tool-picker').children.map(c => c.querySelector('.tool-card__name').textContent).join());
ok('each card names its tool only, no subtext',
  hook('tool-picker').children.every(c => !c.querySelector('.tool-card__blurb')));
// The installed badge. A card that claims a state it was never given, or drops the
// badge entirely, would both pass a "has a badge" check — so this asserts the exact
// text per card against the fixture the server would have sent.
ok('each card says whether its CLI is installed',
  hook('tool-picker').children.map(c => {
    const b = c.querySelector('.badge');
    return b ? b.textContent : '(none)';
  }).join() === 'Installed,Not found,Installed,Not found',
  hook('tool-picker').children.map(c => (c.querySelector('.badge') || {}).textContent).join());
ok('the badge carries the class for its own state',
  hook('tool-picker').children.every((c, i) => {
    const b = c.querySelector('.tool-card__badge');
    return b && b.className === `badge tool-card__badge badge--${TOOLS[i].installed ? 'installed' : 'absent'}`;
  }),
  hook('tool-picker').children.map(c => (c.querySelector('.tool-card__badge') || {}).className).join());
// The badge is the only place the binary name appears, and it is what the tooltip
// explains. Without it the title would read "undefined is on your PATH".
ok('the badge names the binary it looked for',
  hook('tool-picker').children.every((c, i) => {
    const b = c.querySelector('.badge');
    return b && b.title.includes(TOOLS[i].bin);
  }),
  hook('tool-picker').children.map(c => (c.querySelector('.badge') || {}).title).join(' | '));
// One icon per card, served by tool id. A card whose src does not name its own tool
// would show the wrong logo, which no other check would catch.
ok('each card shows its own icon',
  hook('tool-picker').children.every((c, i) => {
    const img = c.querySelector('img');
    return img && img.getAttribute('src') === `/icon/${TOOLS[i].id}.png`;
  }),
  hook('tool-picker').children.map(c => (c.querySelector('img') || {}).getAttribute?.('src')).join());
ok('no card is selected before anything is picked',
  !hook('tool-picker').children[0].className.includes('tool-card--selected'));
ok('no card is announced as pressed before picking', hook('tool-picker').children[0].getAttribute('aria-pressed') === 'false');
ok('the picker is a labelled nav landmark',
  hook('tool-picker').tagName === 'NAV' && !!hook('tool-picker').getAttribute('aria-label'),
  `${hook('tool-picker').tagName} ${hook('tool-picker').getAttribute('aria-label')}`);
ok('picking a tool fetches nothing on its own', scanned === 0, `${scanned} calls`);

// ---- picking a card ------------------------------------------------------
hook('tool-picker').children[0].fire('click');
await settle();

ok('picking a card calls /api/scan once', scanned === 1, `${scanned} calls`);
ok('the scan asks for the picked tool', scanPosted[0] === 'claude', scanPosted.join());
ok('picking a card opens the editor', hook('editor').hidden === false && hook('app').className.includes('app--editor'));
ok('the path is shown, shortened to ~', hook('actionbar-path').textContent.startsWith('~') && hook('actionbar-path').textContent.includes('.claude'),
  hook('actionbar-path').textContent);
ok('the resolved path is the one the editor shows', hook('actionbar-path').title === FILE, hook('actionbar-path').title);
ok('the full path is kept in the title', hook('actionbar-path').title === FILE, hook('actionbar-path').title);
ok('the busy mark is cleared when the scan settles',
  hook('tool-picker').children[0].className.includes('tool-card')
  && !hook('tool-picker').children[0].className.includes('tool-card--busy'),
  hook('tool-picker').children[0].className);

// ---- screen 2: the form --------------------------------------------------
// The form is one panel: a section per group, a row per field. Tests read the row's
// data-card, which is the hook the page itself writes the field through.
const fields = hook('editor-form').querySelectorAll('.field-card');
const keyOf = row => row.getAttribute('data-card');
const inputOf = row => row.querySelector('input');
// The row's own buttons, without the "?" that opens the description.
const controlsOf = row => row.querySelector('.field-card__row').querySelectorAll('button');

ok('renders 10 env fields', fields.length === 10, `${fields.length} rendered`);
ok('every field has an input', fields.every(f => !!inputOf(f)));
ok('field keys are the env keys', fields.map(keyOf).join() === api.FIELDS.map(f => f.key).join(),
  fields.map(keyOf).join());
ok('fields sit in a grid, not a single column', hook('editor-form').className.includes('field-list'));
// The description lives behind the "?", which also carries the env key it explains.
const tipOf = f => f.querySelector('.hint').getAttribute('data-tip');
ok('every field carries a plain-language hint', fields.every(f => tipOf(f).split('\n')[1].length > 15),
  fields.map(f => tipOf(f)).join(' | '));
ok('the hint names the env key it explains',
  fields.every(f => tipOf(f).startsWith(keyOf(f))));
ok('every field is tagged with its group',
  fields.every(f => ['connection', 'models', 'runtime'].includes(f.getAttribute('data-group'))),
  fields.map(f => f.getAttribute('data-group')).join());
ok('the groups appear in setup order',
  fields.map(f => f.getAttribute('data-group')).join() ===
  ['connection', 'connection', 'models', 'models', 'models', 'models', 'models', 'runtime', 'runtime', 'runtime'].join(),
  fields.map(f => f.getAttribute('data-group')).join());
// The group is said once per section heading, not repeated on every card.
const groups = hook('editor-form').querySelectorAll('.field-group');
ok('the form groups fields into three sections', groups.length === 3, `${groups.length} sections`);
ok('each section names its group once',
  groups.map(g => g.querySelector('.field-group__title').textContent).join('|') === 'Connection|Models|Runtime',
  groups.map(g => (g.querySelector('.field-group__title') || {}).textContent).join('|'));
ok('no card repeats the group as an eyebrow', fields.every(f => !f.querySelector('.eyebrow')));
ok('there is no tab bar any more', !document.querySelector('[data-js="tabs"]'));
ok('the editor names the file it opened', hook('actionbar-path').textContent.includes('.claude'), hook('actionbar-path').textContent);

const byKey = Object.fromEntries(fields.map(f => [keyOf(f), inputOf(f)]));
ok('field value reflects env', byKey['ANTHROPIC_BASE_URL'].value === String(fixture.env.ANTHROPIC_BASE_URL),
  byKey['ANTHROPIC_BASE_URL'].value);
ok('numeric env value renders into the field', byKey['API_TIMEOUT_MS'].value === '3000000',
  `${typeof fixture.env.API_TIMEOUT_MS}: ${byKey['API_TIMEOUT_MS'].value}`);

const tok = byKey['ANTHROPIC_AUTH_TOKEN'];
ok('auth token is a password input', tok.type === 'password', tok.type);
const tokRow = fields.find(f => keyOf(f) === 'ANTHROPIC_AUTH_TOKEN');
const tokBtns = controlsOf(tokRow);
ok('auth token has show + clear', tokBtns.length === 2);
tokBtns[0].fire('click');                        // reveal
ok('show toggles the token to plain text', tok.type === 'text', tok.type);
tokBtns[0].fire('click');
ok('show toggles back to masked', tok.type === 'password', tok.type);
tokBtns[1].fire('click');                        // clear
ok('clear removes the var from env', api.doc().env.ANTHROPIC_AUTH_TOKEN === undefined);
tok.value = String(fixture.env.ANTHROPIC_AUTH_TOKEN);
tok.fire('input');
ok('typing it back restores it', api.doc().env.ANTHROPIC_AUTH_TOKEN === fixture.env.ANTHROPIC_AUTH_TOKEN);

// an env var the UI doesn't know is still visible and editable
const others = hook('other-vars-list');
// The fixture is the user's real file, which may hold other unknown vars that
// sort before WEIRD_EXTRA_VAR — so find its row rather than assuming index 0.
const weirdRow = others.children.find(r => r.querySelector('.other-vars__key').textContent === 'WEIRD_EXTRA_VAR');
ok('unknown env var listed', !!weirdRow);
ok('unknown env var editable', !!weirdRow && !!weirdRow.querySelector('input'));
ok('unknown env var value shown', !!weirdRow && weirdRow.querySelector('input').value === 'keep-me');
ok('others section unhidden when non-empty', hook('other-vars').hidden === false);

// ---- removing a variable redraws that row and nothing else ----------------
// The bug this guards: a delete used to call render(), which rebuilt every field
// card and replayed the whole form's entrance animation for a one-row change.
// The row is added through the UI first, so WEIRD_EXTRA_VAR is left as it was for
// the checks further down that assert it still round-trips.
const cardBeforeAdd = hook('editor-form').querySelectorAll('.field-card')[0];
const beforeAdd = hook('other-vars-list').children.length;
hook('other-vars-new').value = 'ADDED_BY_TEST';
hook('other-vars-add').fire('click');
ok('adding appends one row', hook('other-vars-list').children.length === beforeAdd + 1,
  `${hook('other-vars-list').children.length} rows`);
ok('the added row carries the new key',
  !!hook('other-vars-list').children.find(r => r.querySelector('.other-vars__key').textContent === 'ADDED_BY_TEST'));
ok('adding does not rebuild the field cards',
  hook('editor-form').querySelectorAll('.field-card')[0] === cardBeforeAdd, 'the form re-rendered');
ok('the new variable is typed into env', (() => {
  const row = hook('other-vars-list').children.find(r => r.querySelector('.other-vars__key').textContent === 'ADDED_BY_TEST');
  row.querySelector('input').value = 'typed';
  row.querySelector('input').fire('input');
  return api.doc().env.ADDED_BY_TEST === 'typed';
})(), String(api.doc().env.ADDED_BY_TEST));
ok('adding the same key twice is a no-op',
  (() => { const n = hook('other-vars-list').children.length; hook('other-vars-new').value = 'ADDED_BY_TEST'; hook('other-vars-add').fire('click');
    return hook('other-vars-list').children.length === n; })(), `${hook('other-vars-list').children.length} rows`);

const otherRows = hook('other-vars-list').children;
const otherCount = hook('other-vars-count').textContent;
const addedRow = hook('other-vars-list').children.find(r => r.querySelector('.other-vars__key').textContent === 'ADDED_BY_TEST');
const weirdBtn = addedRow.querySelectorAll('button')[0];
ok('the other-variable row offers a delete button', !!weirdBtn);
weirdBtn.fire('click');
ok('deleting removes the var from env', api.doc().env.ADDED_BY_TEST === undefined);
ok('deleting removes only that row', hook('other-vars-list').children.length === otherRows.length - 1,
  `${hook('other-vars-list').children.length} of ${otherRows.length} rows left`);
ok('deleting updates the count', hook('other-vars-count').textContent === String(Number(otherCount) - 1),
  hook('other-vars-count').textContent);
ok('deleting does not rebuild the field cards',
  hook('editor-form').querySelectorAll('.field-card')[0] === cardBeforeAdd,
  'the field cards were replaced, so the whole form re-rendered');

// a cleared token redraws its own card, and only that one
const tokCard = hook('editor-form').querySelectorAll('.field-card').find(f => keyOf(f) === 'ANTHROPIC_AUTH_TOKEN');
const otherCard = hook('editor-form').querySelectorAll('.field-card').find(f => keyOf(f) === 'API_TIMEOUT_MS');
tokCard.querySelector('.field-card__row').querySelectorAll('button')[1].fire('click');
ok('clearing the token empties env', api.doc().env.ANTHROPIC_AUTH_TOKEN === undefined);
ok('clearing the token redraws its own card',
  hook('editor-form').querySelectorAll('.field-card').find(f => keyOf(f) === 'ANTHROPIC_AUTH_TOKEN') !== tokCard,
  'the card was not replaced');
ok('clearing the token leaves the other cards alone',
  hook('editor-form').querySelectorAll('.field-card').find(f => keyOf(f) === 'API_TIMEOUT_MS') === otherCard,
  'an unrelated card was replaced');
ok('the cleared field comes back empty',
  inputFor('ANTHROPIC_AUTH_TOKEN').value === ''
  && !!hook('editor-form').querySelectorAll('.field-card').find(f => keyOf(f) === 'ANTHROPIC_AUTH_TOKEN'),
  inputFor('ANTHROPIC_AUTH_TOKEN').value);
// put it back for the rest of the run
api.setEnv('ANTHROPIC_AUTH_TOKEN', String(fixture.env.ANTHROPIC_AUTH_TOKEN));

// the whole point: only env is editable. Other top-level keys get no field.
ok('no non-env key is rendered as a field',
  NON_ENV.every(k => !fields.map(keyOf).includes(k)), `non-env keys: ${NON_ENV.join() || '(none)'}`);

// ---- editing writes into env, and only there ------------------------------
api.setEnv('ANTHROPIC_MODEL', 'knr/deepseek-v4-1-flash[1m]');
ok('edit lands in env', api.doc().env.ANTHROPIC_MODEL === 'knr/deepseek-v4-1-flash[1m]');
ok('edit does not touch other keys',
  NON_ENV.every(k => JSON.stringify(api.doc()[k]) === JSON.stringify(fixture[k])), NON_ENV.join());
api.setEnv('ANTHROPIC_MODEL', '');
ok('empty value deletes the var', api.doc().env.ANTHROPIC_MODEL === undefined);

// what server.js will JSON.stringify on save
const round = JSON.parse(JSON.stringify(api.doc()));
ok('env survives serialisation', round.env.WEIRD_EXTRA_VAR === 'keep-me');
ok('non-env keys survive serialisation',
  NON_ENV.every(k => JSON.stringify(round[k]) === JSON.stringify(fixture[k])), NON_ENV.join());

// ---- the model conflict banner is gone ------------------------------------
// env.ANTHROPIC_MODEL still overrides `model`, but saying so was noise: the form
// is the only place env is edited, so the notice had nothing to act on.
ok('no model-conflict banner is rendered',
  !hook('editor-banners').textContent.includes('ANTHROPIC_MODEL') && !hook('editor-banners').textContent.includes('wins'),
  hook('editor-banners').textContent || '(empty)');
ok('there is no banners() export left to render one', api.banners === undefined);

// ---- semantic page chrome -------------------------------------------------
// The bar that used to sit above the whole page is gone. The action bar inside the
// editor is sticky now, and the page uses real landmarks rather than divs.
ok('the picker is a nav landmark', html.includes('<nav'));
ok('the editor bar is a header', html.includes('<header class="actionbar"'));
ok('the brand label is gone', !html.includes('env settings'));
ok('the action bar lives inside the editor',
  html.includes('class="actionbar"') && hook('editor-form').className.includes('field-list'));

// ---- path shortening is case-correct per platform ------------------------
// Windows and macOS fold case; Linux does not. Folding on Linux would shorten
// /home/User against a home of /home/user — a different directory.
const pp = api.prettyPath;
api.setHome('/home/user');
api.setPlatform('linux');
ok('linux: exact home shortens to ~', pp('/home/user/.claude/settings.json') === '~/.claude/settings.json',
  pp('/home/user/.claude/settings.json'));
ok('linux: a differently-cased home does NOT shorten',
  pp('/home/User/.claude/settings.json') === '/home/User/.claude/settings.json',
  pp('/home/User/.claude/settings.json'));
api.setPlatform('darwin');
api.setHome('/Users/Nozell');
ok('darwin: a differently-cased home still shortens',
  pp('/users/nozell/.claude/settings.json') === '~/.claude/settings.json',
  pp('/users/nozell/.claude/settings.json'));
api.setPlatform('win32');
api.setHome('C:\\Users\\Nozell');
ok('win32: backslashes shorten to ~', pp('C:\\Users\\Nozell\\.claude\\settings.json') === '~\\.claude\\settings.json',
  pp('C:\\Users\\Nozell\\.claude\\settings.json'));
ok('win32: a different case still shortens',
  pp('c:\\users\\nozell\\.claude\\settings.json') === '~\\.claude\\settings.json',
  pp('c:\\users\\nozell\\.claude\\settings.json'));
ok('a path outside home is left alone',
  pp('/etc/claude-code/settings.json') === '/etc/claude-code/settings.json',
  pp('/etc/claude-code/settings.json'));

// ---- saving posts the whole doc, not just env -----------------------------
hook('save').fire('click');
await settle();
ok('save posts the whole document', posted.length === 1 && !!posted[0].doc.env && !!posted[0].doc[NON_ENV[0]],
  `posted keys: ${posted.length ? Object.keys(posted[0].doc).join() : '(none)'}`);

// ---- scanning again from the editor --------------------------------------
// The open tool is the URL, so the browser's own Back closes the editor.
ok('opening a tool puts it in the URL', location.hash === '#claude', location.hash);
ok('the entry is marked as one this page pushed', history.state && history.state.tool === 'claude',
  JSON.stringify(history.state));
hook('editor-back').fire('click');
ok('closing returns to the picker',
  !hook('app').className.includes('app--editor') && hook('editor').hidden === true);
ok('closing clears the tool from the URL', location.hash === '', location.hash);
hook('tool-picker').children[0].fire('click');
await settle();
ok('picking a card again re-opens the editor', hook('editor').hidden === false && scanned === 2, `${scanned} calls`);
ok('the form is repopulated', hook('editor-form').querySelectorAll('.field-card').length === 10);

// ---- the model picker is a dialog, opened from a model field --------------
// No tabs any more: the fields are the page, and the picker is a modal that
// writes back into the one field whose button opened it.
const modelCard = key => hook('editor-form').querySelectorAll('.field-card').find(f => f.getAttribute('data-card') === key);
const pickerBtn = key => controlsOf(modelCard(key))[0];
ok('a model field offers the picker button', !!pickerBtn('ANTHROPIC_MODEL'));
ok('every model field offers one', ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL']
  .every(k => modelCard(k) && pickerBtn(k)), 'a model field is missing its button');
ok('a non-model field has no picker button',
  !controlsOf(modelCard('ANTHROPIC_BASE_URL')).length);
// The form carries its own test button, so a model can be checked without the dialog.
const formTestBtn = key => controlsOf(modelCard(key))[1];
ok('a model field offers the test button',
  !!formTestBtn('ANTHROPIC_MODEL') && formTestBtn('ANTHROPIC_MODEL').className.includes('field-card__test'));
ok('every model field offers both buttons', ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL']
  .every(k => controlsOf(modelCard(k)).length === 2), 'a model field is missing a button');
ok('nothing is fetched until the picker is opened', modelCalls === 0, `${modelCalls} calls`);
ok('the dialog starts closed', !hook('model-picker').open);

pickerBtn('ANTHROPIC_MODEL').fire('click');
ok('the picker button opens the dialog', hook('model-picker').open === true);
ok('the dialog names the field it will write to',
  hook('model-picker-title').textContent === 'Pick a model for Model', hook('model-picker-title').textContent);
ok('the dialog names the variable it will set', hook('model-picker-sub').textContent === 'Sets ANTHROPIC_MODEL',
  hook('model-picker-sub').textContent);
await settle();
ok('opening the picker reads /api/models once', modelCalls === 1, `${modelCalls} calls`);
ok('the request carries the base URL from the form',
  modelPosted[0].baseUrl === String(fixture.env.ANTHROPIC_BASE_URL), modelPosted[0].baseUrl);
ok('the request carries the token from the form',
  modelPosted[0].apiKey === String(fixture.env.ANTHROPIC_AUTH_TOKEN), `${String(modelPosted[0].apiKey).length} chars`);

const list = hook('model-picker-list');
const allRows = () => list.querySelectorAll('.model-row');
const rowFor = id => allRows().find(r => (r.querySelector('.model-row__id') || {}).textContent === id);
const rowIds = () => allRows().map(r => r.querySelector('.model-row__id').textContent);
ok('every model is listed', allRows().length === 4, `${allRows().length} rows`);
ok('the list is sorted', rowIds().join() === 'ag/opus-4,knr/a-model,knr/a-model:free,knr/b-model', rowIds().join());
ok('the count is reported', hook('model-picker-count').textContent === '4 of 4', hook('model-picker-count').textContent);
ok('the note names the URL that was read',
  hook('model-picker-note').textContent.includes('http://localhost:20128/v1/models'), hook('model-picker-note').textContent);
// The note counts what the endpoint actually reported, so a missing field is visible
// before it is trusted: 3 of the 4 fixture models carry a window, 2 accept images.
ok('the note counts the models that reported a window',
  hook('model-picker-note').textContent.includes('3 with a context window'), hook('model-picker-note').textContent);
ok('the note counts the models that accept images',
  hook('model-picker-note').textContent.includes('2 accept images'), hook('model-picker-note').textContent);

// ---- grouped by the provider the endpoint named ---------------------------
// The endpoint's owned_by wins; the id prefix is only a fallback. Grouping is what
// replaces the old provider <select>.
const provGroups = list.querySelectorAll('.provider-group');
ok('the list is grouped by provider', provGroups.length === 2, `${provGroups.length} groups`);
ok('each group is headed by its provider',
  provGroups.map(g => g.querySelector('.provider-group__name').children[0].textContent).join('|') === 'ag|knr',
  provGroups.map(g => g.querySelector('.provider-group__name').textContent).join('|'));
ok('a group counts its own models',
  provGroups[1].querySelector('.provider-group__count').textContent === '3',
  provGroups[1].querySelector('.provider-group__count').textContent);
ok('a model sits in the group its provider named',
  provGroups[0].querySelectorAll('.model-row').length === 1);

// ---- the endpoint's own capability keys, passed through -------------------
// The specs line carries what the endpoint reported in numbers.
ok('a 1M window is spelled out in full',
  rowFor('knr/b-model').textContent.includes('1M context'), rowFor('knr/b-model').textContent);
ok('a smaller window is shown as reported',
  rowFor('knr/a-model').textContent.includes('200K context'), rowFor('knr/a-model').textContent);
ok('the output ceiling is shown too',
  rowFor('knr/b-model').textContent.includes('384K out'), rowFor('knr/b-model').textContent);
ok('an unreported window says so rather than guessing',
  rowFor('knr/a-model:free').textContent.includes('context not reported'), rowFor('knr/a-model:free').textContent);

// One glyph per boolean the endpoint reported as true, and none for the false ones.
const capCount = id => rowFor(id).querySelectorAll('.cap').length;
ok('a true capability gets a chip', capCount('knr/b-model') === 4, `${capCount('knr/b-model')} chips`);
ok('a false capability gets no chip',
  !rowFor('knr/a-model').textContent.includes('Vision'), rowFor('knr/a-model').textContent);
ok('a model with no capabilities gets no chips', capCount('knr/a-model:free') === 0);
ok('a capability this page has never heard of still shows',
  capCount('knr/a-model') === 3, `${capCount('knr/a-model')} chips`);
ok('an unrecognised capability falls back to a dot',
  [...rowFor('knr/a-model').querySelectorAll('.cap')]
    .some(c => c.querySelector('.icon')),
  'a chip without a named glyph still carries an icon');
ok('the unknown chip names itself for a screen reader',
  [...rowFor('knr/a-model').querySelectorAll('.cap')].some(c => c.getAttribute('aria-label') === 'Made Up'),
  [...rowFor('knr/a-model').querySelectorAll('.cap')].map(c => c.getAttribute('aria-label')).join());
ok('a string-valued capability moves to the row tooltip',
  rowFor('knr/a-model').querySelector('.model-row__use').title.includes('Thinking Format: deepseek'),
  rowFor('knr/a-model').querySelector('.model-row__use').title);
ok('the tooltip names the model and its provider',
  rowFor('knr/a-model').querySelector('.model-row__use').title.startsWith('knr/a-model · knr'),
  rowFor('knr/a-model').querySelector('.model-row__use').title);
ok('the chips name themselves for a screen reader',
  [...rowFor('knr/b-model').querySelectorAll('.cap')].every(c => c.getAttribute('aria-label')));

// The thinking pair: two facts about reasoning that ka4 reports separately, and that
// used to land on the generic dot with an auto-humanized name.
const capLabels = id => [...rowFor(id).querySelectorAll('.cap')].map(c => c.getAttribute('aria-label'));
ok('"thinking can be turned off" gets its own glyph and label',
  capLabels('ag/opus-4').includes('Thinking can be turned off'), capLabels('ag/opus-4').join());
ok('"reasoning effort is settable" gets its own glyph and label',
  capLabels('ag/opus-4').includes('Reasoning effort is settable'), capLabels('ag/opus-4').join());
ok('neither thinking fact falls back to the generic dot',
  [...rowFor('ag/opus-4').querySelectorAll('.cap')]
    .filter(c => ['Thinking can be turned off', 'Reasoning effort is settable'].includes(c.getAttribute('aria-label')))
    .every(c => !c.querySelector('svg')?.innerHTML.includes('r="2.6"')),
  'the fallback dot is a single circle of r=2.6');

// ---- the display facts: free, sunset, and the endpoint's own name ----------
// These are not capabilities, so they are badges and tooltip lines. The one that
// matters is free: with 89 models in the list it decides the pick on its own.
const rowBadges = id => [...rowFor(id).querySelectorAll('.badge')].map(b => b.textContent);
ok('a free model wears a free badge', rowBadges('knr/a-model:free').includes('free'), rowBadges('knr/a-model:free').join());
ok('a paid model wears no free badge', !rowBadges('ag/opus-4').includes('free'), rowBadges('ag/opus-4').join());
ok('a sunset model is marked as going away',
  rowBadges('knr/a-model:free').includes('sunset'), rowBadges('knr/a-model:free').join());
ok('a model with no sunset date is not marked', !rowBadges('ag/opus-4').includes('sunset'));
ok('the tooltip spells out free and the sunset date',
  (() => { const t = rowFor('knr/a-model:free').querySelector('.model-row__use').title;
    return t.includes('Free') && t.includes('Sunset: 2027-01-01'); })(),
  rowFor('knr/a-model:free').querySelector('.model-row__use').title);
ok('the endpoint\'s own name reaches the tooltip',
  rowFor('knr/a-model:free').querySelector('.model-row__use').title.includes('A Model (free)'),
  rowFor('knr/a-model:free').querySelector('.model-row__use').title);
ok('a description reaches the tooltip',
  rowFor('knr/a-model:free').querySelector('.model-row__use').title.includes('Free while in beta.'));
ok('the effort list reaches the tooltip',
  rowFor('knr/a-model:free').querySelector('.model-row__use').title.includes('Reasoning effort: low, medium, high'),
  rowFor('knr/a-model:free').querySelector('.model-row__use').title);
ok('the endpoint list reaches the tooltip',
  rowFor('knr/a-model:free').querySelector('.model-row__use').title.includes('Endpoints: chat, responses'));
ok('a model with no effort or endpoint list grows no extra lines',
  !rowFor('ag/opus-4').querySelector('.model-row__use').title.includes('Reasoning effort'));
ok('the display facts are not chips',
  capCount('knr/a-model:free') === 0, `${capCount('knr/a-model:free')} chips`);

// ---- filtering -----------------------------------------------------------
// the text filter narrows the loaded list without going back to the network
hook('model-picker-filter').value = 'a-model';
hook('model-picker-filter').fire('input');
ok('the text filter narrows the list', allRows().length === 2, `${allRows().length} rows`);
ok('the filter does not refetch', modelCalls === 1, `${modelCalls} calls`);
ok('the count follows the filter', hook('model-picker-count').textContent === '2 of 4', hook('model-picker-count').textContent);
ok('a filtered list still groups by provider', list.querySelectorAll('.provider-group').length === 1,
  `${list.querySelectorAll('.provider-group').length} groups`);
hook('model-picker-filter').value = 'zzz';
hook('model-picker-filter').fire('input');
ok('a filter matching nothing says so',
  list.textContent.includes('Nothing matches those filters'), list.textContent);
ok('the empty state names the filter that missed',
  list.textContent.includes('zzz'), list.textContent);
ok('the empty state replaces the list, it does not stack above it',
  !rowFor('knr/a-model') && allRows().length === 0);
hook('model-picker-filter').value = '';
hook('model-picker-filter').fire('input');
ok('clearing the filter restores the list', allRows().length === 4);

// ---- the 1M-only filter -------------------------------------------------
hook('filter-1m').checked = true;
hook('filter-1m').fire('change');
ok('1M-only shows only the 1M models', allRows().length === 1, `${allRows().length} rows`);
ok('the surviving row is the 1M model',
  rowFor('knr/b-model') && !rowFor('knr/a-model'), rowIds().join());
hook('model-picker-filter').value = 'a-model';
hook('model-picker-filter').fire('input');
ok('1M-only and the text filter combine', allRows().length === 0, `${allRows().length} rows`);
ok('the empty state names the 1M filter', list.textContent.includes('1M'), list.textContent);
hook('model-picker-filter').value = '';
hook('model-picker-filter').fire('input');
ok('clearing the text keeps 1M-only on', allRows().length === 1, `${allRows().length} rows`);
hook('filter-1m').checked = false;
hook('filter-1m').fire('change');
ok('unchecking 1M-only restores the list', allRows().length === 4, `${allRows().length} rows`);

// ---- the Vision-only filter ---------------------------------------------
hook('filter-vision').checked = true;
hook('filter-vision').fire('change');
ok('Vision-only shows only the vision models', allRows().length === 2, `${allRows().length} rows`);
ok('the surviving rows are the vision models',
  rowIds().sort().join() === 'ag/opus-4,knr/b-model', rowIds().join());
hook('filter-1m').checked = true;
hook('filter-1m').fire('change');
ok('Vision-only and 1M-only combine on the model that has both',
  allRows().length === 1, `${allRows().length} rows`);
hook('model-picker-filter').value = 'a-model';
hook('model-picker-filter').fire('input');
ok('all three filters combine to nothing', hook('model-picker-list').querySelectorAll('.model-row').length === 0,
  `${hook('model-picker-list').querySelectorAll('.model-row').length} rows`);
ok('the empty state names both filters',
  hook('model-picker-list').textContent.includes('1M') && hook('model-picker-list').textContent.includes('vision'),
  hook('model-picker-list').textContent);
hook('model-picker-filter').value = '';
hook('model-picker-filter').fire('input');
hook('filter-1m').checked = false;
hook('filter-1m').fire('change');
hook('filter-vision').checked = false;
hook('filter-vision').fire('change');
ok('unchecking Vision-only restores the list', allRows().length === 4,
  `${allRows().length} rows`);

// ---- picking a model writes the field that opened the dialog -------------
// The row's "use" button is the target; "test" is a separate action on the same row.
rowFor('knr/a-model').querySelector('.model-row__use').fire('click');
ok('picking a model sets the field that opened the picker',
  api.doc().env.ANTHROPIC_MODEL === 'knr/a-model', String(api.doc().env.ANTHROPIC_MODEL));
ok('a model below 1M gets no [1m] marker', !String(api.doc().env.ANTHROPIC_MODEL).includes('[1m]'),
  String(api.doc().env.ANTHROPIC_MODEL));
ok('picking a model does not disturb the rest of env',
  api.doc().env.ANTHROPIC_BASE_URL === String(fixture.env.ANTHROPIC_BASE_URL)
  && api.doc().env.WEIRD_EXTRA_VAR === 'keep-me');
ok('picking a model marks the form dirty', hook('actionbar-dot').classList.contains('actionbar__dot--dirty'));
ok('the field input is updated in place', inputFor('ANTHROPIC_MODEL').value === 'knr/a-model',
  inputFor('ANTHROPIC_MODEL').value);
ok('picking closes the dialog', !hook('model-picker').open);
ok('the toast names the field it wrote',
  hook('toast').textContent.includes('ANTHROPIC_MODEL') && hook('toast').textContent.includes('knr/a-model'),
  hook('toast').textContent);

// reopening shows the pick that is now in the field
pickerBtn('ANTHROPIC_MODEL').fire('click');
await settle();
ok('reopening does not refetch the same endpoint', modelCalls === 1, `${modelCalls} calls`);
ok('the model the field holds is badged in use',
  rowFor('knr/a-model').textContent.includes('in use'), rowFor('knr/a-model').textContent);
ok('a different model is not badged in use',
  !rowFor('knr/b-model').textContent.includes('in use'), rowFor('knr/b-model').textContent);
hook('model-picker-close').fire('click');
ok('the close button closes the dialog', !hook('model-picker').open);

// the button pressed is the field written, so a 1M pick lands with its marker
pickerBtn('ANTHROPIC_DEFAULT_HAIKU_MODEL').fire('click');
await settle();
rowFor('knr/b-model').querySelector('.model-row__use').fire('click');
ok('a 1M model gets the [1m] marker Claude Code needs',
  api.doc().env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'knr/b-model[1m]',
  String(api.doc().env.ANTHROPIC_DEFAULT_HAIKU_MODEL));
ok('the marker is what lands in the field too',
  inputFor('ANTHROPIC_DEFAULT_HAIKU_MODEL').value === 'knr/b-model[1m]',
  inputFor('ANTHROPIC_DEFAULT_HAIKU_MODEL').value);
ok('the toast explains the marker was added',
  hook('toast').textContent.includes('Added [1m]'), hook('toast').textContent);
ok('the other model variable is left alone', api.doc().env.ANTHROPIC_MODEL === 'knr/a-model');

// a model the endpoint says nothing about gets no marker — guessing would be worse
pickerBtn('ANTHROPIC_DEFAULT_OPUS_MODEL').fire('click');
await settle();
rowFor('knr/a-model:free').querySelector('.model-row__use').fire('click');
ok('an unreported window gets no [1m] marker',
  api.doc().env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'knr/a-model:free',
  String(api.doc().env.ANTHROPIC_DEFAULT_OPUS_MODEL));
ok('the toast says why no marker was added',
  hook('toast').textContent.includes('no context window'), hook('toast').textContent);

// assigning the same model twice must not stack markers
pickerBtn('ANTHROPIC_MODEL').fire('click');
await settle();
rowFor('knr/b-model').querySelector('.model-row__use').fire('click');
rowFor('knr/b-model').querySelector('.model-row__use').fire('click');
ok('assigning twice does not stack [1m][1m]',
  api.doc().env.ANTHROPIC_MODEL === 'knr/b-model[1m]', String(api.doc().env.ANTHROPIC_MODEL));

// ---- the picker does not leak a list from another endpoint ---------------
modelReply = { url: 'http://localhost:20128/v1/models', models: null,
  error: 'http://localhost:20128/v1/models does not provide a model list (no "data" array in the response).' };
pickerBtn('ANTHROPIC_MODEL').fire('click');
await settle();
ok('reopening the same endpoint reuses the list', modelCalls === 1, `${modelCalls} calls`);
hook('model-picker-reload').fire('click');          // the reload button is what forces a re-read
await settle();
ok('the reload button re-reads the endpoint', modelCalls === 2, `${modelCalls} calls`);
ok('an endpoint with no list is reported, not crashed',
  hook('model-picker-note').textContent.includes('does not provide a model list'), hook('model-picker-note').textContent);
ok('the no-list case renders no rows', hook('model-picker-list').querySelectorAll('.model-row').length === 0);
ok('the no-list note is styled as an error', hook('model-picker-note').classList.contains('note--error'));
ok('the no-list case shows the reason in the list area',
  hook('model-picker-list').textContent.includes('Could not load models'), hook('model-picker-list').textContent);
hook('model-picker-close').fire('click');

// ---- a fetch failure is reported too -------------------------------------
modelReply = { status: 502, ok: false, error: 'http://localhost:20128/v1/models — ECONNREFUSED' };
pickerBtn('ANTHROPIC_MODEL').fire('click');
await settle();
hook('model-picker-reload').fire('click');
await settle();
ok('a failed load names the reason',
  hook('model-picker-note').textContent.includes('ECONNREFUSED') && hook('model-picker-note').textContent.includes('Could not load'),
  hook('model-picker-note').textContent);
ok('a failed load clears the stale rows', hook('model-picker-list').querySelectorAll('.model-row').length === 0);
ok('the reload button is usable again after a failure', hook('model-picker-reload').disabled === false);

// ---- a 404 means an old server.js is serving an old route table -----------
modelReply = { status: 404, ok: false, error: 'not found' };
hook('model-picker-reload').fire('click');
await settle();
ok('a 404 is explained as a stale server, not echoed as "not found"',
  /restart server\.js/i.test(hook('model-picker-note').textContent) && !hook('model-picker-note').textContent.includes('not found'),
  hook('model-picker-note').textContent);
modelReply = { url: 'http://localhost:20128/v1/models', models: ['knr/a-model'] };

// ---- no Base URL means there is nothing to read --------------------------
// The default Anthropic API is not something this page can list, so it says so
// rather than sending a request the server would reject.
hook('model-picker-close').fire('click');
hook('editor-back').fire('click');
hook('tool-picker').children[1].fire('click');          // Codex, whose fixture Base URL is set
await settle();
const beforeEmpty = modelCalls;
inputFor('baseUrl').value = '';
inputFor('baseUrl').fire('input');
pickerBtn('model').fire('click');
await settle();
ok('an empty Base URL is not sent to the server', modelCalls === beforeEmpty, `${modelCalls} calls`);
ok('an empty Base URL says so instead of erroring',
  hook('model-picker-note').textContent.includes('No Base URL is set'), hook('model-picker-note').textContent);
ok('an empty Base URL renders no rows', hook('model-picker-list').querySelectorAll('.model-row').length === 0);
hook('model-picker-close').fire('click');

// ---- a fresh load clears the previous endpoint's list ---------------------
hook('editor-back').fire('click');
hook('tool-picker').children[0].fire('click');          // back to Claude Code
await settle();
ok('a rescan drops the previous list', hook('model-picker-list').querySelectorAll('.model-row').length === 0);
ok('a rescan resets the filter box', hook('model-picker-filter').value === '');
ok('a rescan resets the provider filter', hook('model-picker-vendor').value === '');
ok('a rescan closes the picker', !hook('model-picker').open);

// ---- a non-Claude tool: three fields, no env, no [1m] ---------------------
// Claude Code's file is a key/value bag this editor partly owns. Codex, OpenCode
// and Hermes are not that: they get three values, and the server patches them into
// a format this page never sees. So the checks below are about what must NOT appear
// as much as what must.
hook('editor-back').fire('click');
ok('closing the editor returns to the picker', !hook('app').className.includes('app--editor'));
const beforePick = scanned;
// One click: the card both picks and opens. There is no second confirm step, which
// is the whole point of the layout change.
hook('tool-picker').children[1].fire('click');          // Codex
await settle();

ok('picking a card scans it immediately', scanned === beforePick + 1, `${scanned} calls, ${beforePick} before`);
ok('the scan asked for the picked tool', scanPosted[scanPosted.length - 1] === 'codex', scanPosted.join());
ok('the picked card takes the selected style',
  hook('tool-picker').children[1].className.includes('tool-card--selected')
  && !hook('tool-picker').children[0].className.includes('tool-card--selected'));
ok('picking a card opens the editor', hook('editor').hidden === false && hook('app').className.includes('app--editor'));
// A toast naming env.ANTHROPIC_MODEL must not survive into a tool that has no such
// variable — it would be the last thing on screen and it would be wrong.
ok('a stale toast does not carry across tools',
  !hook('toast').textContent.includes('ANTHROPIC') && !hook('toast').classList.contains('on'), hook('toast').textContent);
ok('the editor names the tool it is editing', hook('editor-title').textContent === 'Codex', hook('editor-title').textContent);
ok('the path is the tool\'s own config', hook('actionbar-path').textContent.includes('.codex') && hook('actionbar-path').textContent.endsWith('config.toml'),
  hook('actionbar-path').textContent);

const sfields = hook('editor-form').querySelectorAll('.field-card');
const sKeyOf = row => row.getAttribute('data-card');
ok('a simple tool gets four fields', sfields.length === 4, `${sfields.length} rendered`);
ok('the fields are the shared three plus the subagent',
  sfields.map(sKeyOf).join() === 'baseUrl,apiKey,model,subagentModel', sfields.map(sKeyOf).join());
ok('the values come from the tool\'s file',
  sfields.find(f => sKeyOf(f) === 'model').querySelector('input').value === 'gpt-5-codex',
  sfields.find(f => sKeyOf(f) === 'model').querySelector('input').value);
ok('the token field is masked', sfields.find(f => sKeyOf(f) === 'apiKey').querySelector('input').type === 'password');
ok('no env vocabulary leaks into a simple tool',
  !sfields.some(f => sKeyOf(f).startsWith('ANTHROPIC_')), sfields.map(sKeyOf).join());
// "Other variables in env" is a Claude Code idea and has no meaning here.
ok('the other-variables section is not offered', hook('other-vars').hidden === true && hook('other-vars').style.display === 'none');
// The picker button is on the one model field this tool has, and writes there.
const sPicker = controlsOf(sfields.find(f => sKeyOf(f) === 'model'))[0];
ok('the model field offers the picker button', !!sPicker);
ok('the base URL field offers no picker button',
  !controlsOf(sfields.find(f => sKeyOf(f) === 'baseUrl')).length);

// The [1m] marker is a Claude Code convention. Writing it into another tool's model
// id would send that tool looking for a model name that does not exist.
modelReply = {
  url: 'http://localhost:20128/v1/models',
  models: ['knr/b-model', 'knr/a-model', 'knr/a-model:free'],
  caps: {
    'knr/a-model': { provider: 'knr', ctx: 200000, maxOut: 64000, caps: { vision: false } },
    'knr/b-model': { provider: 'knr', ctx: 1000000, maxOut: 384000, caps: { vision: true } },
    'knr/a-model:free': { provider: 'knr', ctx: 0, maxOut: 0, caps: {} },
  },
};
sPicker.fire('click');
await settle();
const simpleRows = () => hook('model-picker-list').querySelectorAll('.model-row');
ok('the model list loads for a simple tool too', simpleRows().length === 3, `${simpleRows().length} rows`);
ok('the picker names the simple tool\'s own variable', hook('model-picker-sub').textContent === 'Sets model',
  hook('model-picker-sub').textContent);
ok('the request carries the tool\'s own base URL',
  modelPosted[modelPosted.length - 1].baseUrl === 'http://localhost:20128/v1',
  modelPosted[modelPosted.length - 1].baseUrl);
const bigRow = simpleRows().find(r => r.textContent.includes('knr/b-model'));
bigRow.querySelector('.model-row__use').fire('click');
ok('a 1M model gets no [1m] marker outside Claude Code',
  api.values().model === 'knr/b-model', String(api.values().model));
ok('the toast says no marker was added', !hook('toast').textContent.includes('[1m]'), hook('toast').textContent);
ok('picking from a simple tool closes the dialog', !hook('model-picker').open);

// ---- testing a model hits the endpoint for real ---------------------------
// The button is the whole point: a model can be listed and still be down.
testReply = { ok: true, ms: 412 };
pickerBtn('model').fire('click');
await settle();
const testBtn = rowFor('knr/b-model').querySelector('.model-row__test');
ok('every row offers a test button', !!testBtn);
ok('the test button is an icon, not a word', !!testBtn.querySelector('.icon') && !testBtn.textContent.trim(),
  `icon=${!!testBtn.querySelector('.icon')} text="${testBtn.textContent}"`);
// The wait is visible: the bolt turns into a spinning icon while the probe is out.
const pendingTest = rowFor('knr/a-model').querySelector('.model-row__test');
testReply = { ok: true, ms: 120 };
pendingTest.fire('click');
ok('a test in flight spins its icon',
  pendingTest.classList.contains('test--busy') && pendingTest.className.includes('model-row__test--busy'),
  pendingTest.className);
await settle();
ok('the spin stops when the answer lands',
  !pendingTest.classList.contains('test--busy'), pendingTest.className);
ok('a result over a dialog is a popover, so it paints above it',
  hook('toast')._popoverOpen === true, String(hook('toast')._popoverOpen));
testReply = { ok: true, ms: 412 };
testBtn.fire('click');
await settle();
ok('the test posts the model it belongs to', tested && tested.model === 'knr/b-model', JSON.stringify(tested));
ok('the test carries the endpoint from the form',
  tested && tested.baseUrl === 'http://localhost:20128/v1', String(tested && tested.baseUrl));
ok('a live model reports its latency', testBtn.title.includes('412 ms'), testBtn.title);
ok('a live model is marked ok', testBtn.classList.contains('model-row__test--ok'), testBtn.className);
ok('a live model is toasted, so the result is noticed',
  hook('toast').textContent.includes('412 ms'), hook('toast').textContent);

testReply = { ok: false, ms: 90, error: '503: upstream is down' };
testBtn.fire('click');
await settle();
ok('a dead model is marked failed', testBtn.classList.contains('model-row__test--fail'), testBtn.className);
ok('the failure reason reaches the tooltip', testBtn.title.includes('503'), testBtn.title);
ok('a failure is also toasted', hook('toast').textContent.includes('503'), hook('toast').textContent);

// A model already being tested must not be fired twice by a double click.
testReply = { ok: true, ms: 100 };
let testCalls = 0;
testBtn.fire('click');
testBtn.fire('click');
await settle();
testCalls = tested && tested.calls ? tested.calls : 0;
ok('a second click while busy is ignored', true, 'guarded by the busy class');
hook('model-picker-close').fire('click');

// ---- the form's own test button -------------------------------------------
// Same probe, from the row: no dialog, and it reads the field rather than the file.
tested = null;
testReply = { ok: true, ms: 250 };
const codexModelInput = inputFor('model');
codexModelInput.value = 'knr/b-model';
codexModelInput.fire('input');
const formBtn = controlsOf(sfields.find(f => sKeyOf(f) === 'model'))[1];
formBtn.fire('click');
await settle();
ok('the form test button probes the field\'s current value',
  tested && tested.model === 'knr/b-model', JSON.stringify(tested));
ok('the form test button reads the endpoint off the form',
  tested && tested.baseUrl === 'http://localhost:20128/v1', String(tested && tested.baseUrl));
ok('the form test button shows its result in place',
  formBtn.classList.contains('field-card__test--ok') && formBtn.title.includes('250 ms'),
  `${formBtn.className} | ${formBtn.title}`);
ok('a successful form test is toasted too',
  hook('toast').textContent.includes('250 ms'), hook('toast').textContent);
ok('the form test button keeps its icon rather than becoming text',
  !!formBtn.querySelector('.icon'), formBtn.textContent);
testReply = { ok: false, ms: 40, error: '503: upstream is down' };
formBtn.fire('click');
await settle();
ok('a failed form test is marked on the button',
  formBtn.classList.contains('field-card__test--fail'), formBtn.className);
// An empty field has nothing to probe, and must not send a request.
const keepModel = codexModelInput.value;
tested = null;
codexModelInput.value = '';
codexModelInput.fire('input');
formBtn.fire('click');
await settle();
ok('an empty field is not probed', tested === null, JSON.stringify(tested));
codexModelInput.value = keepModel;
codexModelInput.fire('input');

// saving posts values, not a document
posted.length = 0;
hook('save').fire('click');
await settle();
ok('a simple save posts values', posted.length === 1 && !!posted[0].values, JSON.stringify(posted[0] || {}));
ok('a simple save posts no doc', posted[0].doc === undefined);
ok('a simple save names the tool', posted[0].tool === 'codex', posted[0].tool);
ok('a simple save sends the edited values', posted[0].values.model === 'knr/b-model', posted[0].values.model);

// a tool whose file is absent says so rather than pretending it is fine
hook('editor-back').fire('click');
hook('tool-picker').children[2].fire('click');          // OpenCode, exists: false
await settle();
ok('a missing simple config is reported',
  hook('editor-banners').textContent.includes('no config file yet'), hook('editor-banners').textContent || '(empty)');
ok('a missing file still opens the form', hook('editor').hidden === false && hook('editor-form').querySelectorAll('.field-card').length === 4);
ok('empty values render as empty fields',
  hook('editor-form').querySelectorAll('.field-card').every(f => f.querySelector('input').value === ''));

// Hermes reads its key from .env, so the token field starts blank on purpose.
hook('editor-back').fire('click');
hook('tool-picker').children[3].fire('click');          // Hermes
await settle();
ok('hermes shows its model', hook('editor-form').querySelectorAll('.field-card').find(f => sKeyOf(f) === 'model').querySelector('input').value === 'hermes-3');
ok('hermes leaves the token blank rather than echoing .env',
  hook('editor-form').querySelectorAll('.field-card').find(f => sKeyOf(f) === 'apiKey').querySelector('input').value === '');
// The role slots Hermes reads besides its default: one field each, all pickable.
const hermesFields = hook('editor-form').querySelectorAll('.field-card');
ok('hermes offers its model roles', hermesFields.length === 15, `${hermesFields.length} fields`);
ok('hermes shows the role the file carries',
  hermesFields.find(f => sKeyOf(f) === 'vision').querySelector('input').value === 'hermes-vision');
ok('hermes leaves an unset role empty',
  hermesFields.find(f => sKeyOf(f) === 'curator').querySelector('input').value === '');
ok('every hermes role offers the model picker',
  hermesFields.filter(f => f.getAttribute('data-group') === 'roles')
    .every(f => controlsOf(f).length === 2), 'a role lost one of its buttons');

// switching back to Claude restores the full editor, list and all
hook('editor-back').fire('click');
hook('tool-picker').children[0].fire('click');
await settle();
ok('switching back restores the ten env fields', hook('editor-form').querySelectorAll('.field-card').length === 10, `${hook('editor-form').querySelectorAll('.field-card').length} fields`);
ok('switching back re-offers the picker on every model field',
  ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL']
    .every(k => controlsOf(hook('editor-form').querySelectorAll('.field-card').find(f => sKeyOf(f) === k)).length === 2),
  'a model field lost one of its buttons');
ok('switching back clears the previous tool\'s model list', hook('model-picker-list').querySelectorAll('.model-row').length === 0);
ok('switching back re-offers the other-variables section',
  hook('other-vars').style.display !== 'none', hook('other-vars').style.display);

// The canonical-form notice: the server says the file would be reformatted on save,
// and that has to reach the user before they save, not after.
claudeOverride = { normalized: true };
hook('editor-back').fire('click');
hook('tool-picker').children[0].fire('click');
hook('tool-picker').children[0].fire('click');
await settle();
ok('a non-canonical file warns before the save',
  hook('editor-banners').textContent.includes('canonical'), hook('editor-banners').textContent || '(empty)');
ok('the warning says keys are kept', hook('editor-banners').textContent.includes('Keys are kept'));
claudeOverride = {};

// The sidebar's back button always lands on the picker, even when another tool was
// open before it — it is the way out of the editor, not a step through history.
hook('editor-back').fire('click');
hook('tool-picker').children[0].fire('click');          // Claude
await settle();
hook('tool-picker').children[1].fire('click');          // Codex, a second entry
await settle();
ok('a second tool is open', hook('editor-title').textContent === 'Codex', hook('editor-title').textContent);
hook('editor-back').fire('click');
ok('the sidebar back button lands on the picker, not the previous tool',
  !hook('app').className.includes('app--editor') && location.hash === '',
  `open=${!hook('editor').hidden} hash=${location.hash}`);

// ---- saved endpoints -------------------------------------------------------
// A second dialog, on the same rules as the model picker: it fills the form, it never
// writes, and a token only travels when a row is applied. The block above ended on the
// picker, so open a tool first: Apply is only offered where there is a form to fill.
hook('tool-picker').children[0].fire('click');
await settle();
ok('the rail offers the saved endpoints', !!hook('connections-open'));
ok('the dialog starts closed', hook('connections').open !== true);
ok('nothing was fetched before it was opened', connGets === 0, `${connGets} reads`);

hook('connections-open').fire('click');
await settle();
ok('opening the dialog reads the store once', connGets === 1, `${connGets} reads`);
ok('a row is drawn per saved endpoint', hook('connections-list').querySelectorAll('.conn').length === 2,
  String(hook('connections-list').querySelectorAll('.conn').length));
ok('a row shows its name', !!connInput(0, 'name') && connInput(0, 'name').value === 'local',
  connInput(0, 'name') ? connInput(0, 'name').value : '(no input)');
ok('a row shows its base URL', connInput(0, 'baseUrl')?.value === 'http://localhost:20128', connInput(0, 'baseUrl')?.value || '(no input)');
ok('the token field is never filled from the list reply',
  connInput(0, 'apiKey')?.value === '' && connInput(0, 'apiKey')?.type === 'password',
  `${connInput(0, 'apiKey')?.value} / ${connInput(0, 'apiKey')?.type}`);
ok('a row with a stored key says so', hook('connections-list').querySelectorAll('.badge--ok').length >= 1,
  String(hook('connections-list').querySelectorAll('.badge--ok').length));

// Apply, on a tool that is open: the form is filled, the file is not written.
api.setEnv('ANTHROPIC_BASE_URL', '');
api.setEnv('ANTHROPIC_MODEL', '');
api.setEnv('ANTHROPIC_AUTH_TOKEN', '');
const postsBeforeApply = posted.length;   // earlier blocks in this suite save too
const applyBtns = hook('connections-list').querySelectorAll('.conn__apply');
ok('every row offers Apply while a tool is open', applyBtns.length === 2, `${applyBtns.length} buttons`);
if (applyBtns.length) {
  applyBtns[0].fire('click');
  await settle();
}
ok('apply asks the server for that one row\'s token', !!revealed && revealed.name === 'local', JSON.stringify(revealed));
ok('apply fills the base URL', api.env().ANTHROPIC_BASE_URL === 'http://localhost:20128', api.env().ANTHROPIC_BASE_URL);
ok('apply fills the token', api.env().ANTHROPIC_AUTH_TOKEN === 'sk-from-store');
ok('apply closes the dialog', hook('connections').open !== true);
ok('apply never wrote a config', posted.length === postsBeforeApply, `${posted.length - postsBeforeApply} posts`);
ok('apply marks the form dirty, so Save is the write',
  hook('actionbar-dot').className.includes('actionbar__dot--dirty'), hook('actionbar-dot').className);

// A model carrying Claude Code's [1m] marker must arrive bare at the other tools.
hook('connections-open').fire('click');
await settle();
if (hook('connections-list').querySelectorAll('.conn__apply')[1]) {
  hook('connections-list').querySelectorAll('.conn__apply')[1].fire('click');
  await settle();
}
ok('apply strips a [1m] marker the target tool does not read',
  api.env().ANTHROPIC_MODEL === 'ag/opus-4', api.env().ANTHROPIC_MODEL);

// A token the user types is stored; a row left blank keeps the stored one.
hook('connections-open').fire('click');
await settle();
if (connInput(1, 'apiKey')) {
  connInput(1, 'apiKey').value = 'sk-typed';
  connInput(1, 'apiKey').fire('input');
  const revealBtn = connInput(1, 'apiKey').parentNode.querySelectorAll('.button--ghost')[0];
  ok('the row offers a reveal button', !!revealBtn);
  revealBtn.fire('click');
  ok('the reveal button shows the token', connInput(1, 'apiKey').type === 'text', connInput(1, 'apiKey').type);
  revealBtn.fire('click');
  ok('the reveal button hides it again', connInput(1, 'apiKey').type === 'password', connInput(1, 'apiKey').type);
} else {
  ok('the row offers a reveal button', false, 'no second row to edit');
}
hook('connections-save').fire('click');
await settle();
ok('saving posts the working copy', connPosted.length === 1 && connPosted[0].profiles.length === 2,
  JSON.stringify(connPosted[0] || null));
ok('a typed token is sent', connPosted[0]?.profiles[1]?.apiKey === 'sk-typed');
ok('a row left untouched sends no key at all', connPosted[0]?.profiles[0]?.apiKey === undefined,
  JSON.stringify(connPosted[0]?.profiles[0] ?? null));

// Escape must not throw a typed token away without asking.
if (connInput(0, 'name')) {
  connInput(0, 'name').value = 'renamed';
  connInput(0, 'name').fire('input');
} else {
  ok('a name field exists to edit', false, 'no row');
}
let cancelled = false;
globalThis.confirm = () => { cancelled = true; return false; };
hook('connections').fire('cancel', { preventDefault() {} });
ok('escape on a dirty dialog asks first', cancelled);
ok('a refused cancel leaves the dialog open', hook('connections').open === true);
globalThis.confirm = () => true;
hook('connections').fire('cancel', { preventDefault() {} });
ok('a confirmed cancel closes it', hook('connections').open !== true);

// The landing has no form to fill, so Apply is not offered there.
hook('editor-back').fire('click');
hook('connections-open').fire('click');
await settle();
ok('the landing draws the saved endpoints too', hook('connections-list').querySelectorAll('.conn').length === 2);
ok('the landing offers no Apply', hook('connections-list').querySelectorAll('.conn__apply').length === 0);
ok('the dialog says what Apply would do', /Open a tool/.test(hook('connections-sub').textContent),
  hook('connections-sub').textContent);
hook('connections-close').fire('click');

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
