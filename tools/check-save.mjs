// Dev-only. Exercises the save path end to end against a scratch config dir.
//
// The server edits exactly one file — <CLAUDE_CONFIG_DIR>/settings.json — so this
// launches its own server with CLAUDE_CONFIG_DIR pointed at a temp directory. The
// user's real ~/.claude/settings.json is never in scope, by construction.
//   node tools/check-save.mjs
import { writeFileSync, readFileSync, readdirSync, existsSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';

const SCRATCH = mkdtempSync(join(tmpdir(), 'csui-save-'));
const FILE = join(SCRATCH, 'settings.json');
const BAK = join(SCRATCH, 'backups');
const PORT = 8843;

// HOME/USERPROFILE are redirected too: the non-Claude tools keep their configs in
// their own dotfolders under the home dir, and those must land in the scratch dir
// as well. os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so both.
//
// HERMES_HOME must be redirected as well, and for the same reason: the real one is
// set machine-wide by the Hermes installer, so a server started without it would
// read the live config out from under the running agent. Both the main server and
// the HERMES_HOME probe below are pinned to scratch dirs.
const scratchEnv = extra => ({
  ...process.env, CLAUDE_CONFIG_DIR: SCRATCH, HOME: SCRATCH, USERPROFILE: SCRATCH,
  HERMES_HOME: join(SCRATCH, '.hermes'), ...extra,
});
const server = spawn(process.execPath, [join(process.cwd(), 'server.js'), '--port', String(PORT)], {
  env: scratchEnv(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const get = p => fetch(`http://127.0.0.1:${PORT}${p}`).then(r => r.json());
const post = (p, body) => fetch(`http://127.0.0.1:${PORT}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json() }));

const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass, detail });

function finish() {
  server.kill();
  rmSync(SCRATCH, { recursive: true, force: true });
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

// Wait for the server to accept connections.
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { await get('/api/settings'); up = true; } catch { await new Promise(r => setTimeout(r, 100)); }
}
if (!up) { console.error('server never came up:\n' + log); process.exit(1); }

// --- the server is pointed at the scratch dir, not the real one -------------
const s0 = await get('/api/settings');
ok('server edits the scratch config dir', s0.selected === FILE, s0.selected);
ok('the real settings.json is out of scope', !s0.selected.includes('.claude'), s0.selected);
ok('scratch file starts absent', s0.exists === false);

const scan0 = await post('/api/scan', {});
ok('scan reports not found', scan0.body.found === false && scan0.body.file === FILE, JSON.stringify(scan0.body.file));

// --- create -----------------------------------------------------------------
const doc = { env: { ANTHROPIC_BASE_URL: 'http://localhost:20128', API_TIMEOUT_MS: '3000000' }, permissions: { defaultMode: 'default' } };
const r1 = await post('/api/settings', { doc, baseMtimeMs: s0.mtimeMs });
ok('create succeeds', r1.status === 200 && r1.body.ok === true, `status ${r1.status}`);
ok('create writes no backup (nothing to back up)', !r1.body.backup, String(r1.body.backup));
const written = JSON.parse(readFileSync(FILE, 'utf8'));
ok('create writes the doc', written.env.ANTHROPIC_BASE_URL === 'http://localhost:20128' && written.permissions.defaultMode === 'default');

const scan1 = await post('/api/scan', {});
ok('scan reports found after create', scan1.body.found === true, JSON.stringify(scan1.body.found));

// --- change -----------------------------------------------------------------
const s1 = await get('/api/settings');
const doc2 = JSON.parse(JSON.stringify(s1.parsed));
doc2.env.ANTHROPIC_MODEL = 'test-model';
const r2 = await post('/api/settings', { doc: doc2, baseMtimeMs: s1.mtimeMs });
ok('change succeeds', r2.status === 200, `status ${r2.status}`);
ok('change writes a backup', !!r2.body.backup, String(r2.body.backup));
ok('backup holds the previous version',
  existsSync(r2.body.backup) && !readFileSync(r2.body.backup, 'utf8').includes('test-model'),
  'previous version has no ANTHROPIC_MODEL');
ok('the new value landed', JSON.parse(readFileSync(FILE, 'utf8')).env.ANTHROPIC_MODEL === 'test-model');

// --- no-op ------------------------------------------------------------------
const before = readdirSync(BAK).length;
const s2 = await get('/api/settings');
const r3 = await post('/api/settings', { doc: s2.parsed, baseMtimeMs: s2.mtimeMs });
ok('no-op save succeeds', r3.status === 200, `status ${r3.status}`);
ok('no-op save writes no backup', !r3.body.backup && readdirSync(BAK).length === before,
  `${before} -> ${readdirSync(BAK).length}`);

// --- rotation ---------------------------------------------------------------
for (let i = 0; i < 8; i++) {
  const s = await get('/api/settings');
  const d = JSON.parse(JSON.stringify(s.parsed));
  d.env.API_TIMEOUT_MS = String(3000000 + i);
  await post('/api/settings', { doc: d, baseMtimeMs: s.mtimeMs });
}
const kept = readdirSync(BAK).filter(f => f.startsWith('settings.json.backup.')).length;
ok('rotation caps the backup count at 5', kept === 5, `${kept} kept`);

// --- stale write ------------------------------------------------------------
const s3 = await get('/api/settings');
const stale = await post('/api/settings', { doc: s3.parsed, baseMtimeMs: 1 });
ok('a stale baseMtimeMs is refused with 409', stale.status === 409, `status ${stale.status}`);

// --- bad input --------------------------------------------------------------
const bad = await post('/api/settings', { baseMtimeMs: s3.mtimeMs });
ok('a body with no doc is refused', bad.status === 400, `status ${bad.status}`);

// --- non-env keys survive the whole cycle -----------------------------------
const s4 = await get('/api/settings');
ok('non-env keys survive the save cycle', s4.parsed.permissions.defaultMode === 'default',
  JSON.stringify(s4.parsed.permissions));

// --- a non-Claude tool writes its own format, in its own home ----------------
// The simple tools are the ones with real risk: this project has no TOML or YAML
// parser, so their configs are patched as text. What has to hold is that the keys
// nobody owns come back byte-identical, and that a token never lands in a file
// that does not expect one.
//
// HOME is pointed at the scratch dir, so ~/.codex and ~/.hermes land there and the
// real ones are out of scope by construction.
const tools0 = await get('/api/tools');
ok('the tool registry is served', Array.isArray(tools0.tools) && tools0.tools.length === 4,
  (tools0.tools || []).map(t => t.id).join());
ok('claude is the only full-env tool',
  tools0.tools.filter(t => t.mode === 'env').map(t => t.id).join() === 'claude');
ok('every tool is named', tools0.tools.every(t => t.name));

const codexGet = await get('/api/settings?tool=codex');
ok('codex reports its own file', codexGet.file === join(SCRATCH, '.codex', 'config.toml'), codexGet.file);
ok('codex starts absent', codexGet.exists === false);
ok('codex starts with empty values',
  codexGet.values.baseUrl === '' && codexGet.values.model === '', JSON.stringify(codexGet.values));

// Seed a config the way the real tool would, with sections this editor must not touch.
mkdirSync(join(SCRATCH, '.codex'), { recursive: true });
writeFileSync(join(SCRATCH, '.codex', 'config.toml'), [
  'model = "old"',
  'model_reasoning_effort = "medium"',
  '',
  '[windows]',
  'sandbox = "elevated"',
  '',
].join('\n'));

const cw = await post('/api/settings', {
  tool: 'codex', values: { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-codex', model: 'gpt-5' },
});
ok('a codex save succeeds', cw.status === 200 && cw.body.ok === true, `status ${cw.status} ${JSON.stringify(cw.body)}`);
const codexText = readFileSync(join(SCRATCH, '.codex', 'config.toml'), 'utf8');
ok('codex: the provider section is written', codexText.includes('[model_providers.9router]'));
ok('codex: the base URL is normalised', codexText.includes('base_url = "http://127.0.0.1:8787/v1"'), codexText);
ok('codex: the model is written', /^model = "gpt-5"$/m.test(codexText), codexText);
ok('codex: the provider is selected', /^model_provider = "9router"$/m.test(codexText));
ok('codex: a section nobody owns survives', codexText.includes('[windows]\nsandbox = "elevated"'));
ok('codex: a scalar nobody owns survives', codexText.includes('model_reasoning_effort = "medium"'));
const codexBack = await get('/api/settings?tool=codex');
ok('codex: the values read back', codexBack.values.apiKey === 'sk-codex' && codexBack.values.model === 'gpt-5',
  JSON.stringify(codexBack.values));
ok('codex: the first write was backed up', existsSync(join(SCRATCH, '.codex', 'backups')));

// A bad base URL must be refused before it reaches a config file.
const badUrl = await post('/api/settings', { tool: 'codex', values: { baseUrl: 'not a url', model: 'm' } });
ok('a base URL with no scheme is refused', badUrl.status === 400, `status ${badUrl.status}`);
const noModel = await post('/api/settings', { tool: 'codex', values: { baseUrl: 'http://h', model: '' } });
ok('a save with no model is refused', noModel.status === 400, `status ${noModel.status}`);
const noValues = await post('/api/settings', { tool: 'codex', values: null });
ok('a save with no values is refused', noValues.status === 400, `status ${noValues.status}`);
const badTool = await post('/api/settings', { tool: 'nope', values: { baseUrl: 'http://h', model: 'm' } });
ok('an unknown tool is refused', badTool.status === 400, `status ${badTool.status}`);
const badToolGet = await get('/api/settings?tool=nope');
ok('an unknown tool is refused on read too', badToolGet.error !== undefined, JSON.stringify(badToolGet));

// hermes: the key belongs in .env, and only there.
const hw = await post('/api/settings', {
  tool: 'hermes', values: { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-hermes', model: 'hermes-3' },
});
ok('a hermes save succeeds', hw.status === 200, `status ${hw.status} ${JSON.stringify(hw.body)}`);
const hermesYaml = readFileSync(join(SCRATCH, '.hermes', 'config.yaml'), 'utf8');
ok('hermes: the model block is written', hermesYaml.includes('default: "hermes-3"'), hermesYaml);
ok('hermes: the block points at the env var', hermesYaml.includes('api_key: ${OPENAI_API_KEY}'));
ok('hermes: the token is NOT in the yaml', !hermesYaml.includes('sk-hermes'), hermesYaml);
ok('hermes: the token IS in .env',
  readFileSync(join(SCRATCH, '.hermes', '.env'), 'utf8').includes('OPENAI_API_KEY=sk-hermes'));
const hermesBack = await get('/api/settings?tool=hermes');
ok('hermes: the model reads back', hermesBack.values.model === 'hermes-3', JSON.stringify(hermesBack.values));
ok('hermes: the token is not echoed back', hermesBack.values.apiKey === '', JSON.stringify(hermesBack.values));

// opencode: JSONC in the wild, and another provider must not be disturbed.
mkdirSync(join(SCRATCH, '.config', 'opencode'), { recursive: true });
writeFileSync(join(SCRATCH, '.config', 'opencode', 'opencode.json'),
  '{\n  "provider": { "other": { "options": { "baseURL": "https://x/v1" } } },\n}\n');
const og = await get('/api/settings?tool=opencode');
ok('opencode: a JSONC file with a trailing comma is read', og.parseError === null, String(og.parseError));
const ow = await post('/api/settings', {
  tool: 'opencode', values: { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-oc', model: 'gpt-5' },
});
ok('an opencode save succeeds', ow.status === 200, `status ${ow.status} ${JSON.stringify(ow.body)}`);
const ocJson = JSON.parse(readFileSync(join(SCRATCH, '.config', 'opencode', 'opencode.json'), 'utf8'));
ok('opencode: the provider is written', ocJson.provider['9router'].options.baseURL === 'http://127.0.0.1:8787/v1');
ok('opencode: the active model is namespaced', ocJson.model === '9router/gpt-5', ocJson.model);
ok('opencode: another provider is untouched', ocJson.provider.other.options.baseURL === 'https://x/v1');

// A file this editor cannot parse must not be overwritten by one it can write.
writeFileSync(join(SCRATCH, '.config', 'opencode', 'opencode.json'), '{ not json');
const ocBad = await get('/api/settings?tool=opencode');
ok('opencode: an unparseable file is reported', !!ocBad.parseError, String(ocBad.parseError));
const ocBadSave = await post('/api/settings', {
  tool: 'opencode', values: { baseUrl: 'http://h', apiKey: '', model: 'm' },
});
ok('opencode: a save over a broken file is refused',
  ocBadSave.status === 409 || ocBadSave.status === 500, `status ${ocBadSave.status}`);
ok('opencode: the broken file is left exactly as it was',
  readFileSync(join(SCRATCH, '.config', 'opencode', 'opencode.json'), 'utf8') === '{ not json');

// --- the claude path is unaffected by any of this ---------------------------
const stillClaude = await get('/api/settings');
ok('a bare /api/settings still means claude', stillClaude.selected === FILE, stillClaude.selected);
const stillClaude2 = await get('/api/settings?tool=claude');
ok('?tool=claude is the same file', stillClaude2.selected === FILE, stillClaude2.selected);
ok('the claude file still holds its env', stillClaude2.parsed.env.ANTHROPIC_MODEL === 'test-model',
  JSON.stringify(stillClaude2.parsed.env));

// --- the read that carries a token is gated like the write ------------------
// A DNS-rebinding page reaches 127.0.0.1 with Host=evil.com and no Origin. The
// GET reply holds env.ANTHROPIC_AUTH_TOKEN, so it must be refused the same way.
const rawGet = (path, headers) => new Promise(resolve => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers }, res => {
    let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, d }));
  });
  req.end();
});
const rebind = await rawGet('/api/settings', { Host: 'evil.example.com' });
ok('a rebound Host cannot read settings', rebind.status === 403, `status ${rebind.status}`);
ok('the refused reply carries no token', !rebind.d.includes('ANTHROPIC_AUTH_TOKEN'), rebind.d.slice(0, 80));
const rebindTools = await rawGet('/api/tools', { Host: 'evil.example.com' });
ok('a rebound Host cannot read the tool list', rebindTools.status === 403, `status ${rebindTools.status}`);
const goodHost = await rawGet('/api/settings', { Host: `127.0.0.1:${PORT}` });
ok('the real page still reads settings', goodHost.status === 200, `status ${goodHost.status}`);

// --- a save with no mtime must not overwrite a file that appeared since ------
// baseMtimeMs 0 means "there was no file when I loaded". A file created by another
// writer in the meantime is a conflict, not a free overwrite.
const s5 = await get('/api/settings');
await post('/api/settings', { doc: { env: { A: 'x' } }, baseMtimeMs: s5.mtimeMs });
rmSync(FILE);                                   // file gone at load -> mtimeMs 0
const created = await get('/api/settings');
ok('an absent file reports mtime 0', created.exists === false && created.mtimeMs === 0, `${created.exists} ${created.mtimeMs}`);
writeFileSync(FILE, '{\n  "env": {\n    "A": "someone-else"\n  }\n}\n');   // external writer wins the race
const clobber = await post('/api/settings', { doc: { env: { A: 'mine' } }, baseMtimeMs: 0 });
ok('a file created since load is a 409, not a silent overwrite', clobber.status === 409, `status ${clobber.status}`);
ok('the external writer\'s content survived', readFileSync(FILE, 'utf8').includes('someone-else'),
  readFileSync(FILE, 'utf8'));

// --- a doc that is not an object is refused ----------------------------------
const notObj = await post('/api/settings', { doc: 'not-an-object', baseMtimeMs: 0 });
ok('a string doc is refused', notObj.status === 400, `status ${notObj.status}`);
const arrDoc = await post('/api/settings', { doc: ['a'], baseMtimeMs: 0 });
ok('an array doc is refused', arrDoc.status === 400, `status ${arrDoc.status}`);

// --- CRLF survives a simple-mode save ----------------------------------------
mkdirSync(join(SCRATCH, '.hermes'), { recursive: true });
writeFileSync(join(SCRATCH, '.hermes', 'config.yaml'),
  'model:\r\n  default: old\r\n  provider: custom\r\n  base_url: http://x/v1\r\n\r\nagent:\r\n  max_turns: 5\r\n');
await post('/api/settings', { tool: 'hermes', values: { baseUrl: 'http://y', apiKey: '', model: 'new' } });
const crlf = readFileSync(join(SCRATCH, '.hermes', 'config.yaml'), 'utf8');
ok('a CRLF config stays CRLF after a simple save', !/(?<!\r)\n/.test(crlf), JSON.stringify(crlf.slice(0, 60)));
ok('the untouched keys below the block survive', crlf.includes('agent:\r\n  max_turns: 5'));

// --- a model: block keeps the keys this editor has no field for --------------
// The rebuild this replaced dropped context_length and rewrote the user's own
// api_key reference to OPENAI_API_KEY, which broke a live config.
writeFileSync(join(SCRATCH, '.hermes', 'config.yaml'), [
  'model:',
  '  default: kenari/x',
  '  provider: custom',
  '  base_url: https://ai.example/v1',
  '  context_length: 0',
  '  api_key: ${MY_OWN_KEY}',
  'agent:',
  '  max_turns: 5',
  '',
].join('\n'));
await post('/api/settings', { tool: 'hermes', values: { baseUrl: 'https://ai.example', apiKey: '', model: 'new-model' } });
const keptBlock = readFileSync(join(SCRATCH, '.hermes', 'config.yaml'), 'utf8');
ok('a key the editor has no field for survives the block', keptBlock.includes('context_length: 0'), keptBlock);
ok('the user\'s own api_key reference is left alone', keptBlock.includes('${MY_OWN_KEY}'), keptBlock);
ok('the model the editor owns was updated', keptBlock.includes('default: "new-model"'), keptBlock);
ok('the block is still emitted once', (keptBlock.match(/^model:/gm) || []).length === 1);
ok('keys below the block survive', keptBlock.includes('agent:\n  max_turns: 5'));

// --- HERMES_HOME decides where Hermes is edited ------------------------------
// The Hermes installer puts HERMES_HOME in the user env; ~/.hermes can be an
// empty leftover. Editing that leftover writes a config nothing ever reads.
const altHome = join(SCRATCH, 'hermes-home');
mkdirSync(altHome, { recursive: true });
writeFileSync(join(altHome, 'config.yaml'), 'model:\n  default: elsewhere\n');
const srv2 = spawn(process.execPath, [join(process.cwd(), 'server.js'), '--port', String(PORT + 1)], {
  env: scratchEnv({ HERMES_HOME: altHome }),
  stdio: ['ignore', 'ignore', 'ignore'],
});
let up2 = false;
for (let i = 0; i < 60 && !up2; i++) {
  try { await fetch(`http://127.0.0.1:${PORT + 1}/api/tools`); up2 = true; }
  catch { await new Promise(r => setTimeout(r, 100)); }
}
if (up2) {
  const h2 = await fetch(`http://127.0.0.1:${PORT + 1}/api/settings?tool=hermes`).then(r => r.json());
  ok('HERMES_HOME moves the hermes config path', h2.file === join(altHome, 'config.yaml'), h2.file);
} else {
  ok('HERMES_HOME moves the hermes config path', false, 'second server never came up');
}
srv2.kill();

// --- CODEX_HOME and XDG_CONFIG_HOME decide where those tools are edited -------
// Same class of bug as HERMES_HOME: a tool that reads a config from somewhere
// else entirely gets an edit nothing will ever open.
const toolHome = join(SCRATCH, 'tool-home');
mkdirSync(join(toolHome, 'codex'), { recursive: true });
mkdirSync(join(toolHome, 'xdg', 'opencode'), { recursive: true });
writeFileSync(join(toolHome, 'codex', 'config.toml'), 'model = "from-codex-home"\n');
writeFileSync(join(toolHome, 'xdg', 'opencode', 'opencode.json'), '{ "model": "from-xdg" }\n');
const srv3 = spawn(process.execPath, [join(process.cwd(), 'server.js'), '--port', String(PORT + 2)], {
  env: scratchEnv({
    CODEX_HOME: join(toolHome, 'codex'),
    // On Windows opencode ignores XDG, so the expectation differs by platform.
    XDG_CONFIG_HOME: join(toolHome, 'xdg'),
  }),
  stdio: ['ignore', 'ignore', 'ignore'],
});
let up3 = false;
for (let i = 0; i < 60 && !up3; i++) {
  try { await fetch(`http://127.0.0.1:${PORT + 2}/api/tools`); up3 = true; }
  catch { await new Promise(r => setTimeout(r, 100)); }
}
if (up3) {
  const cx = await fetch(`http://127.0.0.1:${PORT + 2}/api/settings?tool=codex`).then(r => r.json());
  ok('CODEX_HOME moves the codex config path', cx.file === join(toolHome, 'codex', 'config.toml'), cx.file);
  ok('CODEX_HOME config is the one read', cx.values.model === 'from-codex-home', JSON.stringify(cx.values));

  const oc = await fetch(`http://127.0.0.1:${PORT + 2}/api/settings?tool=opencode`).then(r => r.json());
  const wantXdg = process.platform !== 'win32';
  ok(`XDG_CONFIG_HOME ${wantXdg ? 'moves' : 'is ignored on win32 for'} the opencode path`,
    oc.file === join(wantXdg ? join(toolHome, 'xdg', 'opencode') : join(SCRATCH, '.config', 'opencode'), 'opencode.json'),
    oc.file);
} else {
  ok('CODEX_HOME moves the codex config path', false, 'third server never came up');
}
srv3.kill();

// --- a BOM must not make a valid file look broken ---------------------------
// Notepad and a few Windows editors write one. Before this was handled, JSON.parse
// threw, the UI said "not valid JSON", and the save was refused: a valid file the
// editor could not touch. The BOM must also survive the write, or a save would
// silently reformat the user's file.
{
  const bomFile = join(SCRATCH, 'bom.json');
  const bomDoc = '{"env":{"ANTHROPIC_MODEL":"m","NOTE":"ünïcödé 日本語"}}';
  writeFileSync(bomFile, '\uFEFF' + bomDoc);
  const mod = await import('file:///' + join(process.cwd(), 'server.js').replace(/\\/g, '/'));
  const read = mod.default.readSettings(bomFile);
  ok('a BOM file parses instead of reporting invalid JSON', read.parseError === null, String(read.parseError));
  ok('the BOM is reported to the client', read.bom === true, String(read.bom));
  ok('the unicode value survives the parse', read.parsed.env.NOTE === 'ünïcödé 日本語', read.parsed.env.NOTE);
  ok('a BOM file is not flagged as needing normalisation',
    read.normalized === true, 'canonical JSON differs from the body, so normalized is honest');
  ok('the BOM is not counted as part of the document', !JSON.stringify(read.parsed).includes('\uFEFF'));
}

finish();
