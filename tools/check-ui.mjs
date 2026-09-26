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
    this.classList = {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); return on; },
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
    if (k === 'id') ids[v] = this;   // so the models pane can find a field input by id
    if (k === 'value') this.value = v;
    if (k === 'type') this.type = v;
    if (k === 'title') this.title = v;
    if (k === 'hidden') this.hidden = true;
    if (k === 'disabled') this.disabled = true;
  }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { (this._on ||= {})[type] = fn; }
  fire(type, ev = {}) { if (this._on && this._on[type]) this._on[type]({ target: this, preventDefault() {}, ...ev }); }
  click() { this.fire('click'); }
  // The real DOM accepts a raw string as a child and makes a text node of it. The
  // shim has to do the same or a mixed node/string child list silently loses the
  // strings, and a test would pass against a page that renders nothing.
  append(...k) { this.children.push(...k.filter(x => x != null).map(textNode)); }
  prepend(...k) { this.children.unshift(...k.filter(x => x != null).map(textNode)); }
  // The real DOM drops a <select>'s value when the option it held is gone. Without
  // this the shim would keep reporting a selection the page has already rebuilt.
  replaceChildren(...k) {
    this.children = k.filter(x => x != null).map(textNode);
    if (this.tagName === 'SELECT'
      && !this.children.some(c => c.tagName === 'OPTION' && (c.getAttribute('value') || '') === this._value)) {
      this._value = '';
    }
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel, acc = []) {
    const m = /^([a-zA-Z]*)(?:\.([\w-]+))?$/.exec(sel.trim());
    const [, tag, cls] = m || [];
    const hit = n => (!tag || n.tagName === tag.toUpperCase()) && (!cls || (n.className || '').split(/\s+/).includes(cls));
    const walk = n => { for (const c of n.children) { if (hit(c)) acc.push(c); walk(c); } };
    walk(this); return acc;
  }
  scrollIntoView() {}
}

// A string child becomes a text node, the way the browser does it.
class TextNode extends El {
  constructor(t) { super('#text'); this._text = String(t); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
}
const textNode = x => (x instanceof El ? x : new TextNode(x));

const ids = {};
// Read id, class *and* plain-text content off the real markup, so a check on a
// static element is checking the file, not the shim's defaults.
for (const m of html.matchAll(/<([a-zA-Z]+)([^>]*?)(?:\/>|>([^<]*)<\/\1>|>)/g)) {
  const id = /\bid="([^"]+)"/.exec(m[2]);
  if (!id) continue;
  const node = new El(m[1]);
  const cls = /\bclass="([^"]+)"/.exec(m[2]);
  if (cls) node.className = cls[1];
  if (/\bhidden\b/.test(m[2])) node.hidden = true;
  // Static attributes are read off the file too, so a check on role/aria is
  // checking the markup rather than the shim's defaults.
  for (const a of m[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) node.setAttribute(a[1], a[2]);
  if (m[3]) node.textContent = m[3].trim();
  ids[id[1]] = node;
}
globalThis.document = {
  createElement: t => new El(t),
  getElementById: id => ids[id] || (ids[id] = new El('div')),
  activeElement: null,
};
globalThis.addEventListener = () => {};
globalThis.confirm = () => true;
globalThis.setTimeout = () => 0;
globalThis.clearTimeout = () => {};

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
let modelReply = {
  url: 'http://localhost:20128/v1/models',
  models: ['knr/b-model', 'knr/a-model', 'knr/a-model:free'],
  // b-model has a 1M window, a-model does not, a-model:free is not reported at all.
  windows: { 'knr/a-model': 200000, 'knr/b-model': 1000000 },
  // b-model takes images, a-model is text-only, a-model:free says nothing.
  vision: { 'knr/b-model': true, 'knr/a-model': false },
};

// The registry the server hands back with the first scan. Mirrors TOOLS in server.js.
const TOOLS = [
  { id: 'claude', name: 'Claude Code', mode: 'env' },
  { id: 'codex', name: 'Codex', mode: 'simple' },
  { id: 'opencode', name: 'OpenCode', mode: 'simple' },
  { id: 'hermes', name: 'Hermes Agent', mode: 'simple' },
];
// A per-tool simple-mode reply, so switching tools is observable end to end.
const SIMPLE = {
  codex: { file: join(HOME, '.codex', 'config.toml'),
    values: { baseUrl: 'http://localhost:20128/v1', apiKey: 'sk-codex', model: 'gpt-5-codex' } },
  opencode: { file: join(HOME, '.config', 'opencode', 'opencode.json'),
    values: { baseUrl: '', apiKey: '', model: '' } },
  hermes: { file: join(HOME, '.hermes', 'config.yaml'),
    values: { baseUrl: 'http://localhost:20128/v1', apiKey: '', model: 'hermes-3' } },
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
  } else if (r.includes('/api/settings')) {
    const tool = toolOf(r);
    if (opts.method === 'POST') {
      posted.push(JSON.parse(opts.body));
      body = { ok: true, file: tool === 'claude' ? FILE : SIMPLE[tool].file, bytes: 10, mtimeMs: 2, backup: null };
    } else if (tool === 'claude') {
      body = { selected: FILE, tool, file: FILE, exists: true, raw: '', parsed: fixture, eol: '\n', mtimeMs: 1, normalized: false, parseError: null };
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
const patched = js.replace(/^showLanding\(\);$/m,
  'globalThis.__api = { doc: () => doc, values: () => values, tool: () => tool, env, setEnv, FIELDS, KNOWN, prettyPath, setPlatform: p => { platform = p; }, setHome: h => { home = h; } };\nrenderTabs();\nshowLanding();');
if (!patched.includes('__api')) throw new Error('could not hook the script — did the last line of app.ts change?');
new Function(patched)();
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };
await settle();

const api = globalThis.__api;
const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass, detail });

// ---- screen 1: the landing -----------------------------------------------
ok('opens on the landing, not the form', ids.onboard.hidden === false && ids.editor.hidden === true);
ok('landing has a Scan button', !!ids.scanbtn);
ok('the Scan button is the orange primary action', ids.scanbtn.className.includes('scan'));
// The path is tool-dependent now, so the landing cannot name it before a scan —
// it names the tool instead, and the path is filled in from what the scan returns.
ok('the landing names the tool it will configure', ids.scanbtn.textContent.includes('Claude Code'),
  ids.scanbtn.textContent);
ok('the path is not guessed before scanning', !ids.scantarget.textContent.includes('.claude'),
  ids.scantarget.textContent);
ok('the path line is hidden until a scan fills it', ids.scanpath.hidden === true);
ok('nothing was fetched before pressing Scan', scanned === 0, `${scanned} calls`);
ok('the form is empty before scanning', ids.form.querySelectorAll('.field').length === 0);

// ---- the tool picker -----------------------------------------------------
ok('the landing offers a tool picker', !!ids.toolpick);
ok('the picker is built from the server registry', ids.toolpick.children.length === 4,
  `${ids.toolpick.children.length} cards`);
ok('the picker lists every tool',
  ids.toolpick.children.map(c => c.querySelector('.toolname').textContent).join() ===
  'Claude Code,Codex,OpenCode,Hermes Agent',
  ids.toolpick.children.map(c => c.querySelector('.toolname').textContent).join());
ok('each card names its tool only, no subtext',
  ids.toolpick.children.every(c => !c.querySelector('.toolblurb')));
// One icon per card, served by tool id. A card whose src does not name its own tool
// would show the wrong logo, which no other check would catch.
ok('each card shows its own icon',
  ids.toolpick.children.every((c, i) => {
    const img = c.querySelector('img');
    return img && img.getAttribute('src') === `/icon/${TOOLS[i].id}.png`;
  }),
  ids.toolpick.children.map(c => (c.querySelector('img') || {}).getAttribute?.('src')).join());
ok('claude is selected to begin with', ids.toolpick.children[0].className.includes('on'));
ok('the picker is a radiogroup', ids.toolpick.getAttribute('role') === 'radiogroup');
ok('the selected card is announced as pressed', ids.toolpick.children[0].getAttribute('aria-pressed') === 'true');
ok('picking a tool fetches nothing on its own', scanned === 0, `${scanned} calls`);

// ---- pressing Scan -------------------------------------------------------
ids.scanbtn.fire('click');
await settle();

ok('Scan calls /api/scan once', scanned === 1, `${scanned} calls`);
ok('Scan asks the server for the selected tool', scanPosted[0] === 'claude', scanPosted.join());
ok('Scan goes straight to the form', ids.editor.hidden === false && ids.onboard.hidden === true);
ok('the path is shown, shortened to ~', ids.path.textContent.startsWith('~') && ids.path.textContent.includes('.claude'),
  ids.path.textContent);
ok('the path line appears once there is a path', ids.scanpath.hidden === false);
ok('the full path is kept in the title', ids.path.title === FILE, ids.path.title);
ok('Scan resets its own label', ids.scanbtn.textContent === 'Scan Claude Code', ids.scanbtn.textContent);

// ---- screen 2: the form --------------------------------------------------
// Fields live one level down now: the form holds a section per group, and each
// section holds its cards. Tests query the cards, not the form's direct children.
const fields = ids.form.querySelectorAll('.field');
const keyOf = row => row.querySelector('.fkey').textContent;
const inputOf = row => row.querySelector('input');

ok('renders 9 env fields', fields.length === 9, `${fields.length} rendered`);
ok('every field has an input', fields.every(f => !!inputOf(f)));
ok('field keys are the env keys', fields.map(keyOf).join() === api.FIELDS.map(f => f.key).join(),
  fields.map(keyOf).join());
ok('fields sit in a grid, not a single column', ids.form.className.includes('grid'));
// Each card says what the variable is for, and carries its group for the section.
ok('every field has a plain-language hint', fields.every(f => f.querySelector('.hint').textContent.length > 15),
  fields.map(f => f.querySelector('.hint').textContent.length).join());
ok('every field is tagged with its group',
  fields.every(f => ['connection', 'models', 'runtime'].includes(f.getAttribute('data-group'))),
  fields.map(f => f.getAttribute('data-group')).join());
ok('the groups appear in setup order',
  fields.map(f => f.getAttribute('data-group')).join() ===
  ['connection', 'connection', 'models', 'models', 'models', 'models', 'models', 'runtime', 'runtime'].join(),
  fields.map(f => f.getAttribute('data-group')).join());
// The group is said once per section heading, not repeated on every card.
const groups = ids.form.querySelectorAll('.fgroup');
ok('the form groups fields into three sections', groups.length === 3, `${groups.length} sections`);
ok('each section names its group once',
  groups.map(g => g.querySelector('.fgrouphead').textContent).join('|') === 'Connection|Models|Runtime',
  groups.map(g => (g.querySelector('.fgrouphead') || {}).textContent).join('|'));
ok('no card repeats the group as an eyebrow', fields.every(f => !f.querySelector('.eyebrow')));
ok('the tab bar is a segmented control', ids.tabs.className.includes('tabs'));
ok('the landing still names the file it looks for', ids.scantarget.textContent.includes('.claude'));

const byKey = Object.fromEntries(fields.map(f => [keyOf(f), inputOf(f)]));
ok('field value reflects env', byKey['ANTHROPIC_BASE_URL'].value === String(fixture.env.ANTHROPIC_BASE_URL),
  byKey['ANTHROPIC_BASE_URL'].value);
ok('numeric env value renders into the field', byKey['API_TIMEOUT_MS'].value === '3000000',
  `${typeof fixture.env.API_TIMEOUT_MS}: ${byKey['API_TIMEOUT_MS'].value}`);

const tok = byKey['ANTHROPIC_AUTH_TOKEN'];
ok('auth token is a password input', tok.type === 'password', tok.type);
const tokRow = fields.find(f => keyOf(f) === 'ANTHROPIC_AUTH_TOKEN');
const tokBtns = tokRow.querySelectorAll('button');
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
const others = ids.otherlist;
// The fixture is the user's real file, which may hold other unknown vars that
// sort before WEIRD_EXTRA_VAR — so find its row rather than assuming index 0.
const weirdRow = others.children.find(r => r.querySelector('.fkey').textContent === 'WEIRD_EXTRA_VAR');
ok('unknown env var listed', !!weirdRow);
ok('unknown env var editable', !!weirdRow && !!weirdRow.querySelector('input'));
ok('unknown env var value shown', !!weirdRow && weirdRow.querySelector('input').value === 'keep-me');
ok('others section unhidden when non-empty', ids.others.hidden === false);

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
  !ids.banners.textContent.includes('ANTHROPIC_MODEL') && !ids.banners.textContent.includes('wins'),
  ids.banners.textContent || '(empty)');
ok('there is no banners() export left to render one', api.banners === undefined);

// ---- no sticky header bar -------------------------------------------------
ok('the header bar is gone from the markup', !html.includes('<header'));
ok('the brand label is gone', !html.includes('env settings'));
ok('the action bar lives inside the editor',
  html.includes('class="actionbar"') && ids.form.className.includes('grid'));

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
ids.save.fire('click');
await settle();
ok('save posts the whole document', posted.length === 1 && !!posted[0].doc.env && !!posted[0].doc[NON_ENV[0]],
  `posted keys: ${posted.length ? Object.keys(posted[0].doc).join() : '(none)'}`);

// ---- scanning again from the editor --------------------------------------
ids.switch.fire('click');
ok('scan-again returns to the landing', ids.onboard.hidden === false && ids.editor.hidden === true);
ids.scanbtn.fire('click');
await settle();
ok('a second scan re-enters the form', ids.editor.hidden === false && scanned === 2, `${scanned} calls`);
ok('the form is repopulated', ids.form.querySelectorAll('.field').length === 9);

// ---- tabs: Environment | Models -------------------------------------------
ok('the tab bar is built', ids.tabs.children.length === 2, `${ids.tabs.children.length} tabs`);
ok('the tabs are Environment then Models',
  ids.tabs.children.map(t => t.textContent).join('|') === 'Environment|Models',
  ids.tabs.children.map(t => t.textContent).join('|'));
ok('the env tab opens selected', ids.tab_paneenv.classList.contains('on') && ids.paneenv.hidden === false);
ok('the models pane starts hidden', ids.panemodels.hidden === true);
ok('the selected tab is announced as such', ids.tab_paneenv.getAttribute('aria-selected') === 'true');
ok('a fresh load returns to the env tab', ids.paneenv.hidden === false, `models hidden: ${ids.panemodels.hidden}`);

ids.tab_panemodels.fire('click');
ok('clicking Models shows that pane', ids.panemodels.hidden === false);
ok('clicking Models hides the env pane', ids.paneenv.hidden === true);
ok('the clicked tab takes the selected style', ids.tab_panemodels.classList.contains('on')
  && !ids.tab_paneenv.classList.contains('on'));
ok('the aria-selected flag follows', ids.tab_panemodels.getAttribute('aria-selected') === 'true'
  && ids.tab_paneenv.getAttribute('aria-selected') === 'false');
ids.tab_paneenv.fire('click');
ok('clicking Environment switches back', ids.paneenv.hidden === false && ids.panemodels.hidden === true);
ids.tab_panemodels.fire('click');

// ---- loading the model list ----------------------------------------------
ok('no model list was fetched on load', modelCalls === 0, `${modelCalls} calls`);
ok('the target select is offered', ids.modeltarget.children.length === 5,
  `${ids.modeltarget.children.length} options`);
ok('the target select defaults to ANTHROPIC_MODEL', ids.modeltarget.value === 'ANTHROPIC_MODEL', ids.modeltarget.value);

ids.loadmodels.fire('click');
await settle();
ok('Load models calls /api/models once', modelCalls === 1, `${modelCalls} calls`);
ok('the request carries the base URL from the form',
  modelPosted[0].baseUrl === String(fixture.env.ANTHROPIC_BASE_URL), modelPosted[0].baseUrl);
ok('the request carries the token from the form',
  modelPosted[0].apiKey === String(fixture.env.ANTHROPIC_AUTH_TOKEN), `${String(modelPosted[0].apiKey).length} chars`);
ok('Load models resets its label', ids.loadmodels.textContent === 'Load models', ids.loadmodels.textContent);

const rows = ids.modellist.children;
const rowIds = rows.map(r => r.querySelector('code').textContent);
ok('every model is listed', rows.length === 3, `${rows.length} rows`);
ok('the list is sorted', rowIds.join() === 'knr/a-model,knr/a-model:free,knr/b-model', rowIds.join());
ok('the count is reported', ids.modelnote.textContent.includes('3 found'), ids.modelnote.textContent);

// the filter narrows the loaded list without going back to the network
ids.modelfilter.value = 'a-model';
ids.modelfilter.fire('input');
ok('the filter narrows the list', ids.modellist.children.length === 2, `${ids.modellist.children.length} rows`);
ok('the filter does not refetch', modelCalls === 1, `${modelCalls} calls`);
ids.modelfilter.value = 'zzz';
ids.modelfilter.fire('input');
ok('a filter matching nothing says so', ids.modelempty.textContent.includes('Nothing matches that filter'),
  ids.modelempty.textContent);
ok('the empty state names the filter that missed',
  ids.modelempty.textContent.includes('zzz'), ids.modelempty.textContent);
ok('the empty state replaces the list, it does not stack above it',
  ids.modellist.children.length === 0 && ids.modelempty.hidden === false);
ids.modelfilter.value = '';
ids.modelfilter.fire('input');
ok('clearing the filter restores the list', ids.modellist.children.length === 3);
ok('the empty state hides once there are rows', ids.modelempty.hidden === true);

// ---- the 1M-only filter -------------------------------------------------
// Fixture windows: knr/b-model is 1M, knr/a-model is 200K, knr/a-model:free is
// unreported — so only one row may survive the checkbox.
ids.only1m.checked = true;
ids.only1m.fire('change');
ok('1M-only shows only the 1M models', ids.modellist.children.length === 1,
  `${ids.modellist.children.length} rows`);
ok('the surviving row is the 1M model',
  ids.modellist.children[0].querySelector('code').textContent === 'knr/b-model',
  ids.modellist.children[0].querySelector('code').textContent);
ids.modelfilter.value = 'a-model';
ids.modelfilter.fire('input');
ok('1M-only and the text filter combine', ids.modellist.children.length === 0,
  `${ids.modellist.children.length} rows`);
ok('the empty state names the 1M filter',
  ids.modelempty.textContent.includes('1M'), ids.modelempty.textContent);
ids.modelfilter.value = '';
ids.modelfilter.fire('input');
ok('clearing the text keeps 1M-only on', ids.modellist.children.length === 1,
  `${ids.modellist.children.length} rows`);
ids.only1m.checked = false;
ids.only1m.fire('change');
ok('unchecking 1M-only restores the list', ids.modellist.children.length === 3,
  `${ids.modellist.children.length} rows`);

// ---- vision badges + Vision-only filter ----------------------------------
// Fixture vision: b-model takes images, a-model is text-only, a-model:free
// says nothing — so it earns no badge either way.
const vText = i => ids.modellist.children[i].textContent;
ok('a vision model is badged vision',
  vText(2).includes('vision') && !vText(2).includes('no vision'), vText(2));
ok('a text-only model is badged no vision', vText(0).includes('no vision'), vText(0));
ok('a model with no vision report earns no vision badge', !vText(1).includes('vision'), vText(1));
ids.onlyvision.checked = true;
ids.onlyvision.fire('change');
ok('Vision-only shows only the vision models', ids.modellist.children.length === 1,
  `${ids.modellist.children.length} rows`);
ok('the surviving row is the vision model',
  ids.modellist.children[0].querySelector('code').textContent === 'knr/b-model',
  ids.modellist.children[0].querySelector('code').textContent);
ids.only1m.checked = true;
ids.only1m.fire('change');
ok('Vision-only and 1M-only combine on the model that has both',
  ids.modellist.children.length === 1, `${ids.modellist.children.length} rows`);
ids.modelfilter.value = 'a-model';
ids.modelfilter.fire('input');
ok('all three filters combine to nothing', ids.modellist.children.length === 0,
  `${ids.modellist.children.length} rows`);
ok('the empty state names both filters',
  ids.modelempty.textContent.includes('1M') && ids.modelempty.textContent.includes('vision'),
  ids.modelempty.textContent);
ids.modelfilter.value = '';
ids.modelfilter.fire('input');
ids.only1m.checked = false;
ids.only1m.fire('change');
ids.onlyvision.checked = false;
ids.onlyvision.fire('change');
ok('unchecking Vision-only restores the list', ids.modellist.children.length === 3,
  `${ids.modellist.children.length} rows`);

// ---- picking a model writes the env var -----------------------------------
const useBtn = ids.modellist.children[0].querySelectorAll('button')[0];
ok('each row offers a use button', !!useBtn);
// Row 0 is knr/a-model (200K window), row 2 is knr/b-model (1M window).
useBtn.fire('click');
ok('picking a model sets the target env var', api.doc().env.ANTHROPIC_MODEL === 'knr/a-model',
  String(api.doc().env.ANTHROPIC_MODEL));
ok('a model below 1M gets no [1m] marker', !String(api.doc().env.ANTHROPIC_MODEL).includes('[1m]'),
  String(api.doc().env.ANTHROPIC_MODEL));
ok('picking a model does not disturb the rest of env',
  api.doc().env.ANTHROPIC_BASE_URL === String(fixture.env.ANTHROPIC_BASE_URL)
  && api.doc().env.WEIRD_EXTRA_VAR === 'keep-me');
ok('picking a model marks the form dirty', ids.dot.classList.contains('on'));
ok('the field input is updated in place', ids.f_ANTHROPIC_MODEL.value === 'knr/a-model',
  ids.f_ANTHROPIC_MODEL.value);
ok('the picked model is badged in use',
  ids.modellist.children[0].textContent.includes('in use'), ids.modellist.children[0].textContent);

// the target select decides which variable a pick lands in
ids.modeltarget.value = 'ANTHROPIC_DEFAULT_HAIKU_MODEL';
ids.modellist.children[2].querySelectorAll('button')[0].fire('click');
ok('a 1M model gets the [1m] marker Claude Code needs',
  api.doc().env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'knr/b-model[1m]',
  String(api.doc().env.ANTHROPIC_DEFAULT_HAIKU_MODEL));
ok('the marker is what lands in the field too',
  ids.f_ANTHROPIC_DEFAULT_HAIKU_MODEL.value === 'knr/b-model[1m]',
  ids.f_ANTHROPIC_DEFAULT_HAIKU_MODEL.value);
ok('the toast explains the marker was added',
  ids.toast.textContent.includes('added [1m]'), ids.toast.textContent);
ok('the other model variable is left alone', api.doc().env.ANTHROPIC_MODEL === 'knr/a-model');
ok('the right field input is updated', ids.f_ANTHROPIC_DEFAULT_HAIKU_MODEL.value === 'knr/b-model[1m]',
  ids.f_ANTHROPIC_DEFAULT_HAIKU_MODEL.value);

// a model the endpoint says nothing about gets no marker — guessing would be worse
ids.modeltarget.value = 'ANTHROPIC_DEFAULT_OPUS_MODEL';
ids.modellist.children[1].querySelectorAll('button')[0].fire('click');
ok('an unreported window gets no [1m] marker',
  api.doc().env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'knr/a-model:free',
  String(api.doc().env.ANTHROPIC_DEFAULT_OPUS_MODEL));
ok('the toast says why no marker was added',
  ids.toast.textContent.includes('no context window'), ids.toast.textContent);

// assigning the same model twice must not stack markers
ids.modeltarget.value = 'ANTHROPIC_MODEL';
ids.modellist.children[2].querySelectorAll('button')[0].fire('click');
ids.modellist.children[2].querySelectorAll('button')[0].fire('click');
ok('assigning twice does not stack [1m][1m]',
  api.doc().env.ANTHROPIC_MODEL === 'knr/b-model[1m]', String(api.doc().env.ANTHROPIC_MODEL));

// the 1M badge marks exactly the models that will get a marker
const rowText = i => ids.modellist.children[i].textContent;
ok('a 1M model is badged 1M', rowText(2).includes('1M'), rowText(2));
ok('a 200K model is not badged 1M', !rowText(0).includes('1M'), rowText(0));
// "in use" must survive the marker, or the row loses its badge the moment it is assigned
ok('a model assigned with a marker is still shown as in use',
  rowText(2).includes('in use'), rowText(2));
ok('a model assigned with a marker is still shown as in use (row 1)',
  rowText(1).includes('in use'), rowText(1));
ids.modeltarget.value = 'ANTHROPIC_MODEL';

// ---- an endpoint with no model list says so -------------------------------
modelReply = { url: 'http://localhost:20128/v1/models', models: null,
  error: 'http://localhost:20128/v1/models does not provide a model list (no "data" array in the response).' };
ids.loadmodels.fire('click');
await settle();
ok('an endpoint with no list is reported, not crashed',
  ids.modelempty.textContent.includes('does not provide a model list'), ids.modelempty.textContent);
ok('the no-list case renders no rows', ids.modellist.children.length === 0);
ok('the no-list note is styled as an error', ids.modelnote.classList.contains('err'));
ok('the empty state is visible in the no-list case', ids.modelempty.hidden === false);

// ---- a fetch failure is reported too -------------------------------------
modelReply = { status: 502, ok: false, error: 'http://localhost:20128/v1/models — ECONNREFUSED' };
ids.loadmodels.fire('click');
await settle();
ok('a failed load names the reason',
  ids.modelnote.textContent.includes('ECONNREFUSED') && ids.modelnote.textContent.includes('Could not load'),
  ids.modelnote.textContent);
ok('a failed load clears the stale rows', ids.modellist.children.length === 0);
ok('the button is usable again after a failure', ids.loadmodels.disabled === false);

// ---- a 404 means an old server.js is serving an old route table -----------
modelReply = { status: 404, ok: false, error: 'not found' };
ids.loadmodels.fire('click');
await settle();
ok('a 404 is explained as a stale server, not echoed as "not found"',
  ids.modelnote.textContent.includes('restart server.js') && !ids.modelnote.textContent.includes('not found'),
  ids.modelnote.textContent);
modelReply = { url: 'http://localhost:20128/v1/models', models: ['knr/a-model'] };

// ---- a fresh load clears the previous endpoint's list ---------------------
ids.tab_panemodels.fire('click');
ok('the models pane is open before rescanning', ids.panemodels.hidden === false);
ids.scanbtn.fire('click');
await settle();
ok('a rescan returns to the env tab', ids.paneenv.hidden === false && ids.panemodels.hidden === true);
ok('a rescan drops the previous list', ids.modellist.children.length === 0);
ids.tab_panemodels.fire('click');
ok('a rescan resets the filter box', ids.modelfilter.value === '' && ids.modellist.children.length === 0);

// ---- a non-Claude tool: three fields, no env, no [1m] ---------------------
// Claude Code's file is a key/value bag this editor partly owns. Codex, OpenCode
// and Hermes are not that: they get three values, and the server patches them into
// a format this page never sees. So the checks below are about what must NOT appear
// as much as what must.
ids.switch.fire('click');
ok('scan-again returns to the landing for a tool switch', ids.onboard.hidden === false);
const beforePick = scanned;
ids.toolpick.children[1].fire('click');          // Codex
await settle();

// Picking is a selection, not a navigation: it stays on the landing so the choice
// is visible before anything is read. Scan is what leaves.
ok('picking a tool does not scan on its own', scanned === beforePick, `${scanned} calls, ${beforePick} before`);
ok('picking a tool stays on the landing', ids.editor.hidden === true && ids.onboard.hidden === false);
ok('the picked card takes the selected style',
  ids.toolpick.children[1].className.includes('on') && !ids.toolpick.children[0].className.includes('on'));
ok('the Scan button names the newly picked tool', ids.scanbtn.textContent === 'Scan Codex', ids.scanbtn.textContent);
ok('a path from the previous tool is cleared', ids.scanpath.hidden === true);

ids.scanbtn.fire('click');
await settle();
ok('Scan scans the picked tool', scanned === beforePick + 1, `${scanned} calls, ${beforePick} before`);
ok('the scan asked for the picked tool', scanPosted[scanPosted.length - 1] === 'codex', scanPosted.join());
ok('Scan goes straight to the form', ids.editor.hidden === false && ids.onboard.hidden === true);
// A toast naming env.ANTHROPIC_MODEL must not survive into a tool that has no such
// variable — it would be the last thing on screen and it would be wrong.
ok('a stale toast does not carry across tools',
  !ids.toast.textContent.includes('ANTHROPIC') && !ids.toast.classList.contains('on'), ids.toast.textContent);
ok('the editor names the tool it is editing', ids.title.textContent === 'Codex', ids.title.textContent);
ok('the path is the tool\'s own config', ids.path.textContent.includes('.codex') && ids.path.textContent.endsWith('config.toml'),
  ids.path.textContent);

const sfields = ids.form.querySelectorAll('.field');
const sKeyOf = row => row.querySelector('.fkey').textContent;
ok('a simple tool gets three fields', sfields.length === 3, `${sfields.length} rendered`);
ok('the fields are the shared three',
  sfields.map(sKeyOf).join() === 'baseUrl,apiKey,model', sfields.map(sKeyOf).join());
ok('the values come from the tool\'s file',
  sfields.find(f => sKeyOf(f) === 'model').querySelector('input').value === 'gpt-5-codex',
  sfields.find(f => sKeyOf(f) === 'model').querySelector('input').value);
ok('the token field is masked', sfields.find(f => sKeyOf(f) === 'apiKey').querySelector('input').type === 'password');
ok('no env vocabulary leaks into a simple tool',
  !sfields.some(f => sKeyOf(f).startsWith('ANTHROPIC_')), sfields.map(sKeyOf).join());
// "Other variables in env" is a Claude Code idea and has no meaning here.
ok('the other-variables section is not offered', ids.others.hidden === true && ids.others.style.display === 'none');
ok('the models pane offers one target, not five', (() => {
  ids.tab_panemodels.fire('click');
  return ids.modeltarget.children.length === 1;
})(), `${ids.modeltarget.children.length} options`);
ok('the one target is the model field', ids.modeltarget.value === 'model', ids.modeltarget.value);

// The [1m] marker is a Claude Code convention. Writing it into another tool's model
// id would send that tool looking for a model name that does not exist.
modelReply = {
  url: 'http://localhost:20128/v1/models',
  models: ['knr/b-model', 'knr/a-model', 'knr/a-model:free'],
  windows: { 'knr/a-model': 200000, 'knr/b-model': 1000000 },
};
ids.loadmodels.fire('click');
await settle();
ok('the model list loads for a simple tool too', ids.modellist.children.length === 3, `${ids.modellist.children.length} rows`);
ok('the request carries the tool\'s own base URL',
  modelPosted[modelPosted.length - 1].baseUrl === 'http://localhost:20128/v1',
  modelPosted[modelPosted.length - 1].baseUrl);
const bigRow = ids.modellist.children.find(r => r.textContent.includes('knr/b-model'));
bigRow.querySelectorAll('button')[0].fire('click');
ok('a 1M model gets no [1m] marker outside Claude Code',
  api.values().model === 'knr/b-model', String(api.values().model));
ok('the toast says no marker was added', !ids.toast.textContent.includes('[1m]'), ids.toast.textContent);
ids.tab_paneenv.fire('click');

// saving posts values, not a document
posted.length = 0;
ids.save.fire('click');
await settle();
ok('a simple save posts values', posted.length === 1 && !!posted[0].values, JSON.stringify(posted[0] || {}));
ok('a simple save posts no doc', posted[0].doc === undefined);
ok('a simple save names the tool', posted[0].tool === 'codex', posted[0].tool);
ok('a simple save sends the edited values', posted[0].values.model === 'knr/b-model', posted[0].values.model);

// a tool whose file is absent says so rather than pretending it is fine
ids.switch.fire('click');
ids.toolpick.children[2].fire('click');          // OpenCode, exists: false
ids.scanbtn.fire('click');
await settle();
ok('a missing simple config is reported',
  ids.banners.textContent.includes('no config file yet'), ids.banners.textContent || '(empty)');
ok('a missing file still opens the form', ids.editor.hidden === false && ids.form.querySelectorAll('.field').length === 3);
ok('empty values render as empty fields',
  ids.form.querySelectorAll('.field').every(f => f.querySelector('input').value === ''));

// Hermes reads its key from .env, so the token field starts blank on purpose.
ids.switch.fire('click');
ids.toolpick.children[3].fire('click');          // Hermes
ids.scanbtn.fire('click');
await settle();
ok('hermes shows its model', ids.form.querySelectorAll('.field').find(f => sKeyOf(f) === 'model').querySelector('input').value === 'hermes-3');
ok('hermes leaves the token blank rather than echoing .env',
  ids.form.querySelectorAll('.field').find(f => sKeyOf(f) === 'apiKey').querySelector('input').value === '');

// switching back to Claude restores the full editor, list and all
ids.switch.fire('click');
ids.toolpick.children[0].fire('click');
ids.scanbtn.fire('click');
await settle();
ok('switching back restores the nine env fields', ids.form.querySelectorAll('.field').length === 9, `${ids.form.querySelectorAll('.field').length} fields`);
ok('switching back restores the five model targets', (() => {
  ids.tab_panemodels.fire('click');
  return ids.modeltarget.children.length === 5;
})(), `${ids.modeltarget.children.length} options`);
ok('switching back clears the previous tool\'s model list', ids.modellist.children.length === 0);
ok('switching back re-offers the other-variables section',
  ids.others.style.display !== 'none', ids.others.style.display);
ids.tab_paneenv.fire('click');

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
