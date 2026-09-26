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

const SCRATCH = mkdtempSync(join(tmpdir(), 'csui-save-'));
const FILE = join(SCRATCH, 'settings.json');
const BAK = join(SCRATCH, 'backups');
const PORT = 8843;

// HOME/USERPROFILE are redirected too: the non-Claude tools keep their configs in
// their own dotfolders under the home dir, and those must land in the scratch dir
// as well. os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so both.
const server = spawn(process.execPath, [join(process.cwd(), 'server.js'), '--port', String(PORT)], {
  env: { ...process.env, CLAUDE_CONFIG_DIR: SCRATCH, HOME: SCRATCH, USERPROFILE: SCRATCH },
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

finish();
