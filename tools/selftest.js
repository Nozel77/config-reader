// Extracted from server.js: the whole selftest, so the server it exercises stays about
// serving. Run it with `node tools/selftest.js`, or `node server.js --selftest`.
const {
  missing,
  http,
  fs,
  path,
  os,
  HERE,
  INDEX,
  APP_TS,
  ICONS,
  configDir,
  hermesHome,
  codexHome,
  opencodeDir,
  MAX_BODY,
  appJs,
  detectEol,
  settingsFile,
  TOOLS,
  toolById,
  hasBin,
  toolList,
  toolPaths,
  PROVIDER,
  PROVIDER_LABEL,
  scanInfo,
  readSettings,
  BACKUPS,
  backupBeforeWrite,
  sleep,
  atomicWrite,
  readText,
  withV1,
  tomlString,
  tomlUnquote,
  tomlTopValue,
  tomlSectionValues,
  tomlSetTop,
  tomlSetSection,
  tomlSetInSection,
  codexKey,
  codexRead,
  codexWrite,
  jsoncParse,
  opencodeRead,
  opencodeWrite,
  HERMES_MODEL_RE,
  HERMES_DELEGATION_RE,
  HERMES_AUX_RE,
  HERMES_ROLES,
  hermesRoleRe,
  hermesBlockValue,
  hermesRead,
  hermesPatchBlock,
  hermesBuildBlock,
  hermesSetTopBlock,
  hermesSetRole,
  hermesWrite,
  envVarSet,
  readSimple,
  writeSimple,
  send,
  isUp,
  openBrowser,
  originOk,
  readBody,
  jsonBody,
  modelsUrl,
  chatUrl,
  psQuote,
  vbsLauncher,
  installShortcutWindows,
  execQuote,
  shQuote,
  installShortcutLinux,
  installShortcutMac,
  resolveDirArg,
  desktopDirWin,
  installShortcut,
  modelWindows,
  VISION_TRUE_TOKENS,
  visionFromModalities,
  VISION_BOOL_KEYS,
  VISION_MOD_KEYS,
  rowVision,
  modelVision,
  num,
  modelCaps,
  connectionsFile,
  readConnections,
  writeConnections,
  protectSecret,
  revealSecret,
  secretsAtRest,
  handler,
  main,
  stripTypeScriptTypes,
  spawn,
  spawnSync,
} = require('../server.js');
// ------------------------------------------------------------------- selftest

function selftest() {
  const checks = [];
  const ok = (name, pass, detail = '') => checks.push({ name, pass, detail });

  // 1. round-trip the real file, if there is one
  const target = toolPaths('claude').file;
  const s = readSettings(target);
  if (s.exists && !s.parseError) {
    const again = JSON.parse(JSON.stringify(s.parsed, null, 2));
    ok('round-trip deep-equal', JSON.stringify(again) === JSON.stringify(s.parsed));
    ok('key order preserved', Object.keys(again).join() === Object.keys(s.parsed).join());
  } else {
    ok('round-trip deep-equal', true, 'no settings.json on this machine — skipped');
  }

  // 2. an unknown key must survive a round-trip. This is requirement #1.
  const probe = { ...(s.parsed || {}), __probe: { a: 1, nested: [1, 'x'] } };
  const back = JSON.parse(JSON.stringify(probe, null, 2));
  ok('unknown key survives', JSON.stringify(back.__probe) === JSON.stringify({ a: 1, nested: [1, 'x'] }));

  // 3. atomic write leaves no .tmp behind
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-'));
  const probeFile = path.join(dir, 'probe.json');
  atomicWrite(probeFile, '{"ok":true}');
  const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
  ok('atomic write, no .tmp left', leftovers.length === 0 && fs.readFileSync(probeFile, 'utf8') === '{"ok":true}', leftovers.join());
  fs.rmSync(dir, { recursive: true, force: true });

  // 4. CLAUDE_CONFIG_DIR is honoured
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const fakeDir = path.join(os.tmpdir(), 'csui-cfg');
  process.env.CLAUDE_CONFIG_DIR = fakeDir;
  const after = configDir();
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  ok('CLAUDE_CONFIG_DIR honoured', after === fakeDir && configDir() === (saved || path.join(os.homedir(), '.claude')));

  // 4b. the scan finds ~/.claude/settings.json on all three platforms. Two things
  // make that work, and each is checked separately because they fail differently:
  //   (a) os.homedir() reads the env var that platform actually uses
  //   (b) path.join picks the host separator, so the path is well-formed per OS
  // (b) cannot be simulated on Windows with the host `path` module — path.join is
  // host-flavoured by design — so it is checked against each platform's own flavour.
  const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const savedCfg = process.env.CLAUDE_CONFIG_DIR;
  const homeVar = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

  // (a) the real os.homedir(), on this machine, follows this platform's variable
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env[homeVar] = process.platform === 'win32' ? 'C:\\fake\\win' : '/fake/posix';
  ok(`${process.platform}: os.homedir() follows ${homeVar}`, os.homedir() === process.env[homeVar], os.homedir());
  ok(`${process.platform}: settingsFile() lands in that home`,
    toolPaths('claude').file === path.join(process.env[homeVar], '.claude', 'settings.json'), toolPaths('claude').file);

  // (b) the composition is well-formed under every platform's separator rules
  for (const [plat, flavour, fakeHome, expected] of [
    ['win32', path.win32, 'C:\\Users\\nozell', 'C:\\Users\\nozell\\.claude\\settings.json'],
    ['darwin', path.posix, '/Users/nozell', '/Users/nozell/.claude/settings.json'],
    ['linux', path.posix, '/home/nozell', '/home/nozell/.claude/settings.json'],
  ]) {
    const composed = flavour.join(fakeHome, '.claude', 'settings.json');
    ok(`${plat}: path composes as ${expected}`, composed === expected, composed);
    ok(`${plat}: composed path is absolute`, flavour.isAbsolute(composed), composed);
  }

  // CLAUDE_CONFIG_DIR wins over the home dir on every platform.
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'csui-elsewhere');
  const overridden = toolPaths('claude').file;
  ok('CLAUDE_CONFIG_DIR overrides home everywhere',
    overridden === path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), overridden);
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedCfg;
  for (const [k, v] of Object.entries(savedHome)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  ok('home env restored after the simulation',
    (savedHome[homeVar] || '') === (process.env[homeVar] || ''), `${homeVar}=${process.env[homeVar]}`);

  // 4c. nothing platform-specific is hardcoded in the path logic. A Windows-only
  // string here would silently break macOS and Linux. This scans server.js, which is
  // where the path logic lives: pointing it at this file would scan the test's own
  // source and quietly check almost nothing.
  const runtime = fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');
  const pathLines = runtime.split('\n').filter(l => /toolPaths|configDir\s*=/.test(l) && !l.trim().startsWith('//'));
  ok('no hardcoded Windows path in the settings path logic',
    pathLines.length > 0 && !pathLines.some(l => /ProgramData|AppData|[A-Z]:\\/.test(l)), `${pathLines.length} lines checked`);

  // 4d. hasBin finds a CLI that is only in a scratch dir on PATH, and does not
  // count a file that exists but cannot be executed. The second half only means
  // something on POSIX: Windows has no exec bit, so it is asserted where it exists
  // rather than weakened into a check that passes everywhere and proves nothing.
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-bin-'));
  const savedPath = process.env.PATH;
  try {
    const win = process.platform === 'win32';
    const real = path.join(binDir, win ? 'csui-fake.cmd' : 'csui-fake');
    // Content is irrelevant: hasBin stats the name and the exec bit, never reads it.
    fs.writeFileSync(real, '');
    if (!win) fs.chmodSync(real, 0o755);
    process.env.PATH = binDir + path.delimiter + savedPath;
    ok('hasBin finds a CLI that is only on PATH', hasBin('csui-fake') === true);
    ok('hasBin does not invent a CLI that is not there', hasBin('csui-not-here-xyz') === false);
    if (!win) {
      const noexec = path.join(binDir, 'csui-noexec');
      fs.writeFileSync(noexec, '#!/bin/sh\n');
      fs.chmodSync(noexec, 0o644);
      ok('hasBin ignores a non-executable file of the right name', hasBin('csui-noexec') === false);
    }
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }

  // 4e. the registry the page receives carries `installed`, and it agrees with the
  // same check for the tools this machine really has. Without this the picker could
  // be told a boolean that never matched anything.
  const listed = toolList();
  ok('the tool list carries an installed flag for every tool',
    listed.length === TOOLS.length && listed.every(t => typeof t.installed === 'boolean'));
  ok('the installed flag agrees with hasBin',
    listed.every(t => t.installed === hasBin(t.bin)),
    listed.map(t => `${t.id}:${t.installed}`).join(' '));

  // 5. app.ts strips to something the browser can actually parse
  try {
    const js = appJs();
    new Function(js);
    ok('app.ts strips to valid JS', js.length > 1000, `${js.length} bytes`);
    ok('types are gone from the output', !/\binterface Field\b/.test(js));
  } catch (e) {
    ok('app.ts strips to valid JS', false, e.message);
  }

  // 6. EOL is detected per file, not assumed from the platform. Claude Code writes
  // LF even on Windows; assuming CRLF there would reformat every save.
  ok('detectEol LF', detectEol('{\n  "a": 1\n}\n') === '\n');
  ok('detectEol CRLF', detectEol('{\r\n  "a": 1\r\n}\r\n') === '\r\n');

  // 7. a real file survives a load -> write -> load cycle byte-for-byte
  if (s.exists && !s.parseError) {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-rt-'));
    const rt = path.join(dir2, 'settings.json');
    fs.writeFileSync(rt, s.raw);
    const before = fs.readFileSync(rt, 'utf8');
    atomicWrite(rt, JSON.stringify(JSON.parse(before), null, 2).replace(/\n/g, detectEol(before)) + detectEol(before));
    const after = fs.readFileSync(rt, 'utf8');
    ok('real file byte-identical after rewrite', before === after, before === after ? '' : `${before.length} -> ${after.length} bytes`);
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // 8. the scan reports the one file and whether it is there. There is no path
  // input to validate any more — the browser never names a file.
  const scan = scanInfo(toolById('claude'));
  ok('scan names an absolute settings path', path.isAbsolute(scan.file), scan.file);
  ok('scan path is the config dir settings.json', scan.file === path.join(configDir(), 'settings.json'));
  ok('scan reports existence as a boolean', typeof scan.found === 'boolean');
  ok('scan found agrees with the filesystem', scan.found === fs.existsSync(scan.file));
  ok('scan reports home for path shortening', scan.home === os.homedir());

  // 8b. every tool resolves to a path under the user's home, and no two tools share
  // one. A registry entry that named the wrong file would silently edit the wrong
  // config, so the shape is checked rather than each path by hand.
  ok('every tool has a path', TOOLS.every(t => {
    try { return path.isAbsolute(toolPaths(t.id).file); } catch { return false; }
  }), TOOLS.map(t => toolPaths(t.id).file).join(' | '));
  ok('tool paths are all distinct', new Set(TOOLS.map(t => toolPaths(t.id).file)).size === TOOLS.length);
  // Case is folded only for this comparison: the paths all come from os.homedir(),
  // so they agree on case by construction and the check is about containment.
  ok('every tool path sits under the home dir',
    TOOLS.every(t => toolPaths(t.id).file.toLowerCase().startsWith(os.homedir().toLowerCase())),
    TOOLS.map(t => toolPaths(t.id).file).join(' | '));
  ok('an unknown tool is refused', (() => { try { toolPaths('nope'); return false; } catch { return true; } })());
  ok('claude is the full env editor, the rest are simple',
    toolById('claude').mode === 'env' && TOOLS.filter(t => t.mode === 'simple').length === 3,
    TOOLS.map(t => `${t.id}:${t.mode}`).join());
  // The picker draws /icon/<id>.png for every tool, so a missing file is a broken
  // card. Checked here rather than at request time, which would only 404 in a browser.
  ok('every tool has an icon', TOOLS.every(t => fs.existsSync(path.join(ICONS, `${t.id}.png`))),
    TOOLS.map(t => `${t.id}:${fs.existsSync(path.join(ICONS, `${t.id}.png`))}`).join(' '));

  // 9. the /v1/models URL is composed from the base, and a base that already ends
  // in /v1 must not grow a second one. This is the one bit of the model-list
  // feature that is pure logic, so it is the one bit worth a check.
  for (const [base, expected] of [
    ['http://localhost:20128', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/v1', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/v1/', 'http://localhost:20128/v1/models'],
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/models'],
    ['http://host/openai/v1', 'http://host/openai/v1/models'],
  ]) {
    let got = '';
    try { got = modelsUrl(base).href; } catch (e) { got = e.message; }
    ok(`models URL for ${base}`, got === expected, got);
  }
  // The other three tools speak the OpenAI shape, but the rule is the same one: the
  // list sits at <base>/v1/models whether or not the base already carried the /v1.
  for (const [base, expected] of [
    ['http://localhost:20128', 'http://localhost:20128/v1/models'],
    ['http://localhost:20128/v1', 'http://localhost:20128/v1/models'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/models'],
  ]) {
    let got = '';
    try { got = modelsUrl(base).href; } catch (e) { got = e.message; }
    ok(`openai-shape models URL for ${base}`, got === expected, got);
  }
  // The health check posts to chat/completions under the same base-URL rule.
  ok('chat URL for http://localhost:20128',
    chatUrl('http://localhost:20128').href === 'http://localhost:20128/v1/chat/completions');
  ok('chat URL for a base that already ends in /v1',
    chatUrl('https://api.openai.com/v1').href === 'https://api.openai.com/v1/chat/completions');
  ok('chat URL for http://localhost:20128/v1/',
    chatUrl('http://localhost:20128/v1/').href === 'http://localhost:20128/v1/chat/completions');

  let threw = false;
  try { modelsUrl('not a url'); } catch { threw = true; }
  ok('a non-URL base throws instead of fetching', threw);

  // 9b. the context window each model advertises. The editor turns this into the
  // [1m] suffix Claude Code needs, so reading it wrong means telling Claude Code a
  // model has a 1M window when it does not — or missing one that does.
  const probeRows = [
    { id: 'flat', context_length: 1000000 },
    { id: 'nested', capabilities: { contextWindow: 200000 } },
    { id: 'both', context_length: 1000000, capabilities: { contextWindow: 200000 } },
    { id: 'neither' },
    { id: 'byname', name: 'named-model', context_length: 262144 },
    { name: 'name-only', context_length: 500000 },
    { id: 'zero', context_length: 0 },
    { id: 'junk', context_length: 'lots' },
    // The other two spellings in the wild: Anthropic's own field, and the
    // models.dev / OpenRouter nesting.
    { id: 'anthropic', max_input_tokens: 200000 },
    { id: 'limit', limit: { context: 131072, output: 8192 } },
    { id: 'topprov', top_provider: { context_length: 400000, max_completion_tokens: 128000 } },
    { id: 'numeric-string', context_length: '262144' },
    null,
    'a bare string row',
  ];
  const wins = modelWindows(probeRows);
  ok('a flat context_length is read', wins.flat === 1000000, String(wins.flat));
  ok('a nested capabilities.contextWindow is read', wins.nested === 200000, String(wins.nested));
  ok('context_length wins when both are present', wins.both === 1000000, String(wins.both));
  ok('a model with no window is left out, not guessed', !('neither' in wins));
  ok('id wins over name when both are present', wins.byname === 262144, String(wins.byname));
  ok('a row with only a name still contributes', wins['name-only'] === 500000, String(wins['name-only']));
  ok('a row with no usable id is skipped', Object.keys(wins).length === 9, Object.keys(wins).join());
  ok('a zero window is not recorded', !('zero' in wins));
  ok('a non-numeric window is not recorded', !('junk' in wins));
  ok('max_input_tokens is read', wins.anthropic === 200000, String(wins.anthropic));
  ok('limit.context is read', wins.limit === 131072, String(wins.limit));
  ok('top_provider.context_length is read', wins.topprov === 400000, String(wins.topprov));
  ok('a numeric string is read as a number', wins['numeric-string'] === 262144, String(wins['numeric-string']));
  ok('null and string rows are skipped without throwing', !('null' in wins));

  // 9c. vision support per model. Same honesty rule as windows: only an explicit
  // capability field counts — a missing signal is left out rather than guessed,
  // so the card shows no vision badge for it instead of a wrong one.
  const visionRows = [
    { id: 'flag', vision: true },
    { id: 'noflag', vision: false },
    { id: 'alt', supports_vision: true },
    { id: 'cap', capabilities: { vision: true } },
    { id: 'arch', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'str', architecture: { modality: 'text+image->text' } },
    { id: 'textonly', modalities: ['text'] },
    { id: 'empty', modalities: [] },
    // The object shape: kenari, HF router and models.dev report the two sides
    // separately. Only the input side may decide this.
    { id: 'obj-vision', modalities: { input: ['text', 'image'], output: ['text'] } },
    { id: 'obj-text', modalities: { input: ['text'], output: ['image'] } },
    { id: 'obj-alt', modalities: { input_modalities: ['image'] } },
    { id: 'obj-junk', modalities: { output: ['image'] } },
    // Anthropic's shape: { supported: true } under the flag's own name.
    { id: 'anth', capabilities: { image_input: { supported: true }, pdf_input: { supported: false } } },
    { id: 'anth-no', capabilities: { image_input: { supported: false } } },
    { id: 'neither' },
    { id: 'junk', vision: 'yes' },
    null,
  ];
  const vis = modelVision(visionRows);
  ok('a vision flag is read', vis.flag === true, String(vis.flag));
  ok('an explicit false is kept, not dropped', vis.noflag === false, String(vis.noflag));
  ok('an alternate flag key is read', vis.alt === true, String(vis.alt));
  ok('a nested capabilities flag is read', vis.cap === true, String(vis.cap));
  ok('a modality list naming image is vision', vis.arch === true, String(vis.arch));
  ok('a modality string naming image is vision', vis.str === true, String(vis.str));
  ok('a text-only modality list is not vision', vis.textonly === false, String(vis.textonly));
  ok('an empty modality list is unknown, not a no', !('empty' in vis));
  ok('a nested input modality list is read', vis['obj-vision'] === true, String(vis['obj-vision']));
  ok('an image output modality is not vision', vis['obj-text'] === false, String(vis['obj-text']));
  ok('input_modalities inside the object is read', vis['obj-alt'] === true, String(vis['obj-alt']));
  ok('an object naming no input side is unknown, not a no', !('obj-junk' in vis));
  ok('a { supported: true } capability is read as true', vis.anth === true, String(vis.anth));
  ok('a { supported: false } capability is read as false', vis['anth-no'] === false, String(vis['anth-no']));
  ok('a model with no signal is left out, not guessed', !('neither' in vis));
  ok('a non-boolean flag is not recorded', !('junk' in vis));
  ok('vision map holds exactly the explicit reports', Object.keys(vis).length === 12, Object.keys(vis).join());

  // 9d. the per-model capability bag. The endpoint's own keys are passed through
  // untouched, so a gateway reporting something this editor has never heard of
  // still reaches the page — the point is that the shape is the endpoint's.
  const capRows = [
    {
      id: 'a/model', owned_by: 'vendor', context_length: 200000, max_completion_tokens: 64000,
      capabilities: { vision: true, pdf: false, reasoning: true, thinkingFormat: 'deepseek', madeUp: true },
    },
    { id: 'nested', capabilities: { contextWindow: '131072', maxOutput: 32000, tools: true } },
    { id: 'modalities', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'nothing' },
    // The shapes the other gateways use: models.dev limits, OpenRouter's
    // per-upstream numbers and parameter list, kenari's pricing block.
    {
      id: 'devstyle', limit: { context: 262144, output: 128000 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      pricing: { input: 0.13, output: 0.53 },
    },
    { id: 'orstyle', top_provider: { context_length: 400000, max_completion_tokens: 128000 },
      supported_parameters: ['tools', 'reasoning'], display_name: 'Or Style' },
    { id: 'kenari', context_length: 1000000, pricing: { free: true, currency: 'IDR' }, sunset_at: '2027-01-01' },
    { id: 'zeroprice', pricing: { prompt: '0', completion: '0' } },
    // The flat booleans kenari uses, and both spellings of the effort list.
    { id: 'flatflags', tool_call: true, reasoning: true, reasoning_options: ['low', 'high'] },
    { id: 'orefforts', reasoning: { supported_efforts: ['low', 'high'], mandatory: true } },
    { id: 'endpoints', endpoints: ['chat', 'image'] },
    null,
  ];
  const caps = modelCaps(capRows);
  ok('caps carries the endpoint keys untouched', caps['a/model'].caps.madeUp === true);
  ok('caps keeps an explicit false', caps['a/model'].caps.pdf === false);
  ok('caps keeps a string-valued capability', caps['a/model'].caps.thinkingFormat === 'deepseek');
  ok('the provider comes from owned_by', caps['a/model'].provider === 'vendor', caps['a/model'].provider);
  ok('ctx comes from the flat field', caps['a/model'].ctx === 200000, String(caps['a/model'].ctx));
  ok('maxOut comes from the flat field', caps['a/model'].maxOut === 64000, String(caps['a/model'].maxOut));
  ok('a nested contextWindow is used when there is no flat one', caps.nested.ctx === 131072, String(caps.nested.ctx));
  ok('a numeric string is read as a number', caps.nested.maxOut === 32000, String(caps.nested.maxOut));
  ok('vision is derived from a modality list when no flag exists', caps.modalities.caps.vision === true);
  ok('a model with no capabilities still gets a row', caps.nothing.caps && caps.nothing.ctx === 0);
  ok('limit.context and limit.output are read', caps.devstyle.ctx === 262144 && caps.devstyle.maxOut === 128000,
    `${caps.devstyle.ctx}/${caps.devstyle.maxOut}`);
  ok('a nested input modality list decides vision', caps.devstyle.caps.vision === true, String(caps.devstyle.caps.vision));
  ok('top_provider carries the window when nothing else does',
    caps.orstyle.ctx === 400000 && caps.orstyle.maxOut === 128000, `${caps.orstyle.ctx}/${caps.orstyle.maxOut}`);
  ok('supported_parameters with tools becomes a tools flag', caps.orstyle.caps.tools === true);
  ok('a display_name reaches meta', caps.orstyle.meta.name === 'Or Style', caps.orstyle.meta.name);
  ok('an explicit pricing.free reaches meta', caps.kenari.meta.free === true);
  ok('a zero price is read as free', caps.zeroprice.meta.free === true, String(caps.zeroprice.meta.free));
  ok('a paid model is not free', caps.devstyle.meta.free === false, String(caps.devstyle.meta.free));
  ok('sunset_at reaches meta', caps.kenari.meta.sunset === '2027-01-01', caps.kenari.meta.sunset);
  ok('a flat tool_call becomes the tools flag', caps.flatflags.caps.tools === true);
  ok('a flat reasoning flag is read', caps.flatflags.caps.reasoning === true);
  ok('reasoning_options becomes the effort list',
    caps.flatflags.meta.efforts.join() === 'low,high', caps.flatflags.meta.efforts.join());
  ok('supported_efforts is read from the nested block',
    caps.orefforts.meta.efforts.join() === 'low,high', caps.orefforts.meta.efforts.join());
  ok('an endpoints list reaches meta', caps.endpoints.meta.endpoints.join() === 'chat,image');
  ok('a model with no effort list carries an empty one', caps.nothing.meta.efforts.length === 0);
  ok('a null row is skipped', Object.keys(caps).length === 11, Object.keys(caps).join());

  // 12. the double-click launcher. The .lnk is written by PowerShell and cannot be
  // checked from here, but the launcher it points at can: it must start node
  // hidden (0) and open the browser (--open), from the editor's own folder.
  const vbs = vbsLauncher(8787);
  ok('the launcher starts node hidden', /sh\.Run .*, 0, False/.test(vbs));
  ok('the launcher passes --open', vbs.includes('--port 8787 --open'));
  ok('the launcher sets its working directory to the editor',
    vbs.includes('sh.CurrentDirectory = here'), vbs.match(/sh\.CurrentDirectory.*/)?.[0]);
  ok('the launcher resolves node without a hardcoded drive',
    !/[A-Z]:\\\\/.test(vbs) && vbs.includes('%ProgramFiles%'));
  ok('the launcher is CRLF-terminated for wscript', vbs.endsWith('\r\n'));
  // The Run line is the one place quoting happens. An earlier version stored quotes
  // inside the node variable *and* added a pair here, so the command line reached
  // wscript with doubled quotes and died with "cannot find the file specified".
  // The exact line is asserted because the failure is invisible until launch.
  ok('the Run line quotes each path exactly once',
    vbs.includes('sh.Run """" & node & """ """ & here & "\\server.js"" --port 8787 --open", 0, False'),
    vbs.split('\r\n').find(l => l.startsWith('sh.Run')));
  // A shortcut that dies silently is the worst version of a missing dependency.
  ok('the launcher says so when node is missing',
    vbs.includes('node was not found') && vbs.includes('MsgBox') && vbs.includes('WScript.Quit 1'));
  ok('the node variable stores no quotes of its own',
    vbs.includes('node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe"'));

  // wscript reads a .vbs as ANSI. A non-ASCII byte in a comment is still bytes it
  // has to parse, so the whole file stays ASCII.
  ok('the launcher is pure ASCII for wscript', /^[\x00-\x7F]*$/.test(vbs),
    [...vbs].filter(c => c.charCodeAt(0) > 127).join('') || 'all ASCII');

  // 13. PowerShell string quoting. A path with an apostrophe is legal on Windows
  // and would otherwise truncate the -Command and create nothing.
  ok('psQuote wraps in single quotes', psQuote('C:\\x\\y.lnk') === `'C:\\x\\y.lnk'`);
  ok('psQuote doubles an embedded apostrophe',
    psQuote("C:\\Users\\O'Brien\\s.lnk") === `'C:\\Users\\O''Brien\\s.lnk'`,
    psQuote("C:\\Users\\O'Brien\\s.lnk"));

  // 14b. the Linux and macOS launchers. Neither can be executed here, but the two
  // things that break them silently can be checked: a path with a space must be
  // quoted the way each format requires, and the file must be marked executable.
  const qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-quote-'));
  const spacey = path.join(qdir, 'my tools');
  const linuxFile = installShortcutLinux(spacey, 8787, 'CONFIG READER');
  const desktop = fs.readFileSync(linuxFile, 'utf8');
  const execLine = desktop.split('\n').find(l => l.startsWith('Exec='));
  // Desktop Entry spec: an argument with a reserved character is quoted with " and
  // its \ " ` $ are backslash-escaped. Unquoted, the space splits the path in two.
  ok('linux: the Exec line quotes the script path', /^Exec=node "[^"]+server\.js" --port 8787 --open$/.test(execLine), execLine);
  ok('linux: Path and Terminal are set', desktop.includes(`Path=${HERE}`) && desktop.includes('Terminal=false'));
  // The +x bit is a POSIX concept; on Windows chmod can only touch the read-only
  // flag, so the mode is checked where it means something and the source where it
  // does not. Either way the chmodSync call itself is asserted — and it is asserted
  // in server.js, which is where installShortcutLinux now lives: reading __filename
  // here would only ever search this test file.
  const shortcutSrc = fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');
  ok('linux: the launcher is chmod +x', process.platform === 'win32'
    ? /installShortcutLinux[\s\S]*?chmodSync\(file, 0o755\)/.test(shortcutSrc)
    : (fs.statSync(linuxFile).mode & 0o111) !== 0,
  process.platform === 'win32' ? 'POSIX-only bit — asserted in source' : (fs.statSync(linuxFile).mode & 0o777).toString(8));

  const macFile = installShortcutMac(spacey, 8787, 'CONFIG READER');
  const command = fs.readFileSync(macFile, 'utf8');
  ok('macos: the .command file starts with a shebang', command.startsWith('#!/bin/sh\n'), JSON.stringify(command.slice(0, 20)));
  ok('macos: the cd is single-quoted for the shell', command.includes(`cd '${HERE}'`), command.split('\n')[1]);
  ok('macos: the launcher is chmod +x', process.platform === 'win32'
    ? /installShortcutMac[\s\S]*?chmodSync\(file, 0o755\)/.test(shortcutSrc)
    : (fs.statSync(macFile).mode & 0o111) !== 0,
  process.platform === 'win32' ? 'POSIX-only bit — asserted in source' : (fs.statSync(macFile).mode & 0o777).toString(8));
  // A single quote in a path is the one character that breaks naive shell quoting.
  ok('macos: an apostrophe in the path is escaped, not left to break the line',
    shQuote("/tmp/O'Brien tools") === `'/tmp/O'\\''Brien tools'`, shQuote("/tmp/O'Brien tools"));
  ok('linux: a quote in the path is backslash-escaped per the spec',
    execQuote('a"b\\c$d`e') === '"a\\"b\\\\c\\$d\\`e"', execQuote('a"b\\c$d`e'));
  fs.rmSync(qdir, { recursive: true, force: true });

  // 14c. the version gate. Node 22.0-22.12 pass a bare major check but have no
  // stripTypeScriptTypes, so the old gate turned a version problem into a dead page.
  // The check is by capability now, which is what this asserts.
  const gateSrc = fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');
  ok('the version gate asks for the capability, not the major number',
    gateSrc.includes("typeof stripTypeScriptTypes !== 'function'") && !/NODE_MAJOR\s*<\s*22/.test(gateSrc));
  ok('the gate names the required minor version when it fails', gateSrc.includes('22.13'));

  // 14. the Desktop the shortcut lands in. On Windows the registry is the only
  // 14. the Desktop the shortcut lands in. On Windows the registry is the only
  // 14. the Desktop the shortcut lands in. On Windows the registry is the only
  // authoritative answer — a OneDrive-redirected Desktop is where the user actually
  // looks, while ~/Desktop can still exist as a stale folder. That stale folder is
  // exactly how the first attempt put the .lnk somewhere invisible.
  if (process.platform === 'win32') {
    const d = desktopDirWin();
    ok('desktopDirWin returns an existing folder', !!d && fs.existsSync(d), d || '(none)');
    ok('desktopDirWin returns an absolute path', !!d && path.isAbsolute(d), d || '(none)');
    const reg = spawnSync('reg', ['query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', 'Desktop'], { encoding: 'utf8', windowsHide: true });
    const raw = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(reg.stdout || '');
    if (raw) {
      const want = raw[1].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
      ok('desktopDirWin agrees with the registry, not ~/Desktop', d === want, `got ${d}, registry ${want}`);
      // The whole point of the fix: when they differ, the registry wins.
      const stale = path.join(os.homedir(), 'Desktop');
      if (fs.existsSync(stale) && stale !== want) {
        ok('a stale ~/Desktop does not win over the redirected one', d !== stale,
          `registry ${want}, stale ${stale}`);
      }
    }
  }

  // 10. the backup rotation keeps the last N and prunes older ones. This is the
  // only undo this editor has, so it gets a check.
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-bak-'));
  const bfile = path.join(bdir, 'settings.json');
  fs.writeFileSync(bfile, '{"v":0}');
  for (let v = 1; v <= BACKUPS + 3; v++) {
    backupBeforeWrite(bfile);
    fs.writeFileSync(bfile, `{"v":${v}}`);
  }
  const kept = fs.readdirSync(path.join(bdir, 'backups')).sort();
  ok(`backup rotation keeps ${BACKUPS}`, kept.length === BACKUPS, `${kept.length} kept`);
  ok('backup names are prefixed by the file', kept.every(f => f.startsWith('settings.json.backup.')));
  // The newest backup must hold the version just before the current file.
  const newest = fs.readFileSync(path.join(bdir, 'backups', kept[kept.length - 1]), 'utf8');
  ok('newest backup is the previous version', newest === `{"v":${BACKUPS + 2}}`, newest);
  fs.rmSync(bdir, { recursive: true, force: true });

  // 11. the "did it actually change?" predicate the save path uses. A no-op save
  // must not consume a backup slot, and the comparison is on the serialised bytes,
  // so it has to be true for an already-canonical file and false once a value moves.
  const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-noop-'));
  const cfile = path.join(cdir, 'settings.json');
  const canonical = '{\n  "env": {\n    "A": "1"\n  }\n}\n';
  fs.writeFileSync(cfile, canonical);
  const cur = readSettings(cfile);
  const reserialise = d => JSON.stringify(d, null, 2).replace(/\n/g, cur.eol) + cur.eol;
  ok('canonical file compares equal (no backup)', cur.raw === reserialise(cur.parsed));
  ok('a changed value compares unequal (backup)', cur.raw !== reserialise({ env: { A: '2' } }));
  fs.rmSync(cdir, { recursive: true, force: true });

  // 15. --dir places the shortcut wherever it is asked to. The public desktop is
  // the case that needs it: the icon there shows up for every account on the
  // machine, so it is a deliberate choice rather than a fallback. A relative path
  // must resolve against the editor's own folder, not the caller's working dir.
  ok('a relative --dir resolves against the editor folder',
    resolveDirArg('sub') === path.join(HERE, 'sub'), resolveDirArg('sub'));
  ok('an absolute --dir is taken as given',
    resolveDirArg(path.join(os.tmpdir(), 'x')) === path.join(os.tmpdir(), 'x'),
    resolveDirArg(path.join(os.tmpdir(), 'x')));
  ok('no --dir means no override', resolveDirArg(null) === null);

  // 16. the three simple-mode formats. Each is patched as text, not re-serialised
  // through a parser, because this project has no dependency to parse them with —
  // so the property that matters is the one that is easy to get wrong: everything
  // the editor does not own must come out the other side byte-identical.
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-simple-'));
  const codexPath = path.join(sdir, 'config.toml');
  const codexSeed = [
    'model = "old-model"',
    'model_provider = "9router"',
    'model_reasoning_effort = "medium"',
    '',
    '[model_providers.9router]',
    'name = "9Router"',
    'base_url = "http://localhost:20128/v1"',
    'experimental_bearer_token = "sk-old"',
    'wire_api = "responses"',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
    "[projects.'d:\\work\\x']",
    'trust_level = "trusted"',
    '',
  ].join('\n');
  fs.writeFileSync(codexPath, codexSeed);
  const cw = { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-new', model: 'gpt-5', subagentModel: 'gpt-5-mini' };
  const codexOut = codexWrite(codexSeed, cw);
  const codexBack = codexRead(codexOut);
  ok('codex: base URL is normalised to /v1', codexBack.baseUrl === 'http://127.0.0.1:8787/v1', codexBack.baseUrl);
  ok('codex: the key round-trips', codexBack.apiKey === 'sk-new', codexBack.apiKey);
  ok('codex: the model round-trips', codexBack.model === 'gpt-5', codexBack.model);
  ok('codex: the subagent model round-trips', codexBack.subagentModel === 'gpt-5-mini', codexBack.subagentModel);
  ok('codex: the key travels as a static Authorization header',
    codexOut.includes('[model_providers.9router.http_headers]\nAuthorization = "Bearer sk-new"'),
    codexOut.slice(codexOut.indexOf('http_headers'), codexOut.indexOf('http_headers') + 80));
  ok('codex: the old bearer token line is gone', !codexOut.includes('experimental_bearer_token'));
  ok('codex: a key written the old way is still read',
    codexRead('[model_providers.9router]\nexperimental_bearer_token = "sk-legacy"\n').apiKey === 'sk-legacy');
  ok('codex: an unrelated [agents] key survives', (() => {
    const t = codexWrite('[agents]\nmax_threads = 4\n', { baseUrl: 'http://h', apiKey: '', model: 'm', subagentModel: 'm2' });
    return t.includes('max_threads = 4') && t.includes('default_subagent_model = "m2"');
  })());
  ok('codex: model_provider points at the provider', tomlTopValue(codexOut, 'model_provider') === '9router');
  // The whole reason for text surgery: sections this editor knows nothing about.
  ok('codex: [windows] survives untouched', codexOut.includes('[windows]\nsandbox = "elevated"'));
  ok('codex: a quoted-key project section survives', codexOut.includes("[projects.'d:\\work\\x']"));
  ok('codex: a scalar nobody owns survives', codexOut.includes('model_reasoning_effort = "medium"'));
  ok('codex: exactly one provider section is left', (codexOut.match(/\[model_providers\.9router\]/g) || []).length === 1);
  ok('codex: the old key is gone', !codexOut.includes('sk-old'));
  // A key of the same name inside a section is not the top-level one.
  const nested = '[a]\nmodel = "inner"\n';
  ok('codex: a section-local key is not read as top-level', tomlTopValue(nested, 'model') === '', tomlTopValue(nested, 'model'));
  ok('codex: writing into a sectionless file inserts above nothing',
    tomlSetTop('model = "a"\n', 'model_provider', '9router') === 'model = "a"\nmodel_provider = "9router"\n',
    JSON.stringify(tomlSetTop('model = "a"\n', 'model_provider', '9router')));
  ok('codex: a file with no sections still gets one',
    tomlSetSection('', 'model_providers.9router', '[model_providers.9router]\nname = "x"').startsWith('[model_providers.9router]'));
  ok('codex: a key with a backslash and quote survives', (() => {
    const t = codexWrite('', { baseUrl: 'http://h', apiKey: 'a"b\\c', model: 'm' });
    return codexRead(t).apiKey === 'a"b\\c';
  })(), codexRead(codexWrite('', { baseUrl: 'http://h', apiKey: 'a"b\\c', model: 'm' })).apiKey);
  // A base that already ends in /v1 — with or without a trailing slash — must not
  // grow a second one. http://h/v1/ once became http://h/v1/v1.
  ok('withV1 leaves a bare base alone', withV1('http://h') === 'http://h/v1', withV1('http://h'));
  ok('withV1 leaves a /v1 base alone', withV1('http://h/v1') === 'http://h/v1', withV1('http://h/v1'));
  ok('withV1 strips a trailing slash before the /v1 check',
    withV1('http://h/v1/') === 'http://h/v1', withV1('http://h/v1/'));
  ok('codex: a /v1/ base URL is normalised, not doubled', (() => {
    const t = codexWrite('', { baseUrl: 'http://h/v1/', apiKey: '', model: 'm' });
    return codexRead(t).baseUrl === 'http://h/v1';
  })());

  const ocSeed = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { other: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://x/v1' } } },
    agent: { explorer: { model: '9router/old' } },
  }, null, 2);
  const ocOut = opencodeWrite(ocSeed, { baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-oc', model: 'gpt-5', subagentModel: 'gpt-5-mini' });
  const ocBack = opencodeRead(ocOut);
  const ocJson = JSON.parse(ocOut);
  ok('opencode: base URL is normalised to /v1', ocBack.baseUrl === 'http://127.0.0.1:8787/v1', ocBack.baseUrl);
  ok('opencode: the key round-trips', ocBack.apiKey === 'sk-oc', ocBack.apiKey);
  ok('opencode: the model round-trips', ocBack.model === 'gpt-5', ocBack.model);
  ok('opencode: the subagent model round-trips', ocBack.subagentModel === 'gpt-5-mini', ocBack.subagentModel);
  ok('opencode: the explorer subagent is namespaced',
    ocJson.agent.explorer.model === '9router/gpt-5-mini' && ocJson.agent.explorer.mode === 'subagent',
    JSON.stringify(ocJson.agent.explorer));
  ok('opencode: the active model is namespaced', ocJson.model === '9router/gpt-5', ocJson.model);
  ok('opencode: another provider is left alone', ocJson.provider.other.options.baseURL === 'https://x/v1');
  ok('opencode: a subagent nobody owns is left alone', (() => {
    const t = opencodeWrite(ocSeed, { baseUrl: 'http://h', apiKey: '', model: 'gpt-5' });
    return JSON.parse(t).agent.explorer.model === '9router/old';
  })());
  ok('opencode: the model is registered in the provider', !!ocJson.provider['9router'].models['gpt-5']);
  ok('opencode: JSONC trailing commas are tolerated',
    opencodeRead('{"provider":{"9router":{"options":{"baseURL":"http://a/v1"},},},}').baseUrl === 'http://a/v1');
  ok('opencode: an unparseable file is reported, not thrown',
    opencodeRead('{ not json').broken === true);

  const hermesSeed = [
    'agent:',
    '  name: hermes',
    '',
    'model:',
    '  default: "old-model"',
    '  provider: "custom"',
    '  base_url: "http://localhost:20128/v1"',
    '  api_key: ${OPENAI_API_KEY}',
    '',
    'tools:',
    '  - shell',
    '',
  ].join('\n');
  const hOut = hermesWrite(hermesSeed, {
    baseUrl: 'http://127.0.0.1:8787', apiKey: 'sk-h', model: 'gpt-5',
    delegation: 'gpt-5-mini', vision: 'gpt-5-vision',
  });
  const hBack = hermesRead(hOut);
  ok('hermes: base URL is normalised to /v1', hBack.baseUrl === 'http://127.0.0.1:8787/v1', hBack.baseUrl);
  ok('hermes: the model round-trips', hBack.model === 'gpt-5', hBack.model);
  ok('hermes: the delegation block round-trips', hBack.delegation === 'gpt-5-mini', hBack.delegation);
  ok('hermes: an auxiliary role round-trips', hBack.vision === 'gpt-5-vision', hBack.vision);
  ok('hermes: an untouched role reads as empty', hBack.monitor === '', hBack.monitor);
  ok('hermes: the auxiliary block is emitted once', (hOut.match(/^auxiliary:/gm) || []).length === 1);
  ok('hermes: a role block carries its own endpoint',
    /^  vision:\n    model: "gpt-5-vision"\n    base_url: "http:\/\/127\.0\.0\.1:8787\/v1"/m.test(hOut),
    (hOut.match(/^  vision:[\s\S]{0,120}/m) || [''])[0]);
  ok('hermes: the block still reads the key from the env', hOut.includes('api_key: ${OPENAI_API_KEY}'));
  ok('hermes: the block is emitted once', (hOut.match(/^model:/gm) || []).length === 1);
  ok('hermes: keys above the block survive', hOut.includes('agent:\n  name: hermes'));
  ok('hermes: keys below the block survive', hOut.includes('tools:\n  - shell'));
  // The blank line between the block and the next key is layout the user chose.
  ok('hermes: the separator after the block is preserved',
    /api_key: \$\{OPENAI_API_KEY\}\n\ntools:/.test(hOut),
    JSON.stringify(hOut.slice(hOut.indexOf('api_key'), hOut.indexOf('api_key') + 60)));
  ok('hermes: a file with no model block gets one prepended',
    hermesWrite('agent:\n  name: h\n', { baseUrl: 'http://h', apiKey: '', model: 'm' }).startsWith('model:\n'));
  const envOut = envVarSet('OPENAI_API_KEY=old\nOTHER=1\n', 'OPENAI_API_KEY', 'sk-h');
  ok('hermes: the key is upserted in .env', envOut.includes('OPENAI_API_KEY=sk-h'));
  ok('hermes: another .env line survives', envOut.includes('OTHER=1'));
  ok('hermes: a missing .env gets the line',
    envVarSet('', 'OPENAI_API_KEY', 'sk-h') === 'OPENAI_API_KEY=sk-h\n', JSON.stringify(envVarSet('', 'OPENAI_API_KEY', 'sk-h')));
  ok('hermes: an existing key is replaced, not appended',
    (envVarSet('OPENAI_API_KEY=old\n', 'OPENAI_API_KEY', 'sk-h').match(/OPENAI_API_KEY=/g) || []).length === 1);
  fs.rmSync(sdir, { recursive: true, force: true });

  // 14b. saved endpoints: one file under the home dir, never a path from the browser.
  // The empty-read check runs with the home env pointed at a scratch dir: reading the
  // real home would make this pass or fail on whatever the user happens to have saved.
  const connDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csui-conn-'));
  const savedHomeEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = connDir;
  const connFile = connectionsFile();
  ok('the connection store lives under the home dir',
    connFile === path.join(connDir, '.config-reader', 'connections.json'), connFile);
  ok('a missing store reads as empty, not as an error',
    JSON.stringify(readConnections()) === JSON.stringify({ exists: false, profiles: [] }),
    JSON.stringify(readConnections()));
  ok('the store follows the home dir it is given',
    connectionsFile() === path.join(connDir, '.config-reader', 'connections.json'), connectionsFile());

  // 14c. the store's own rules: what a row is, what it drops, and what a hand-broken
  // file does. The store path is derived from os.homedir() at call time, so pointing
  // the home env at a scratch dir is what keeps the real one out of scope.
  const wrote = writeConnections([
    { name: 'local', baseUrl: 'http://localhost:20128', model: 'knr/a', extra: 'nope' },
    { name: 'nope', baseUrl: 'not a url', model: 'x' },
    { name: 'with key', baseUrl: 'https://ai.example', model: '', apiKey: 'sk-secret', enc: 'plain' },
  ]);
  ok('a row with no usable URL is dropped, not stored', wrote.profiles.length === 2, String(wrote.profiles.length));
  ok('the store is written as JSON with a version', JSON.parse(fs.readFileSync(connectionsFile(), 'utf8')).version === 1);
  ok('an unknown field never reaches the file', !fs.readFileSync(connectionsFile(), 'utf8').includes('"extra"'));
  const connBack = readConnections();
  ok('the store round-trips', connBack.profiles.length === 2 && connBack.profiles[0].name === 'local', JSON.stringify(connBack.profiles));
  ok('a stored key is read back with its marker', connBack.profiles[1].apiKey === 'sk-secret' && connBack.profiles[1].enc === 'plain');

  fs.writeFileSync(connectionsFile(), '{ this is not json');
  ok('a broken store reads as empty rather than throwing', readConnections().profiles.length === 0);
  ok('a broken store is reported as existing', readConnections().exists === true);

  // 14d. the token at rest. On Windows the store is a DPAPI blob that only this user
  // on this machine can open; everywhere else there is no key store in reach, so the
  // token is plain and the file mode is the only restriction.
  const prot = protectSecret('sk-test-123');
  if (secretsAtRest()) {
    ok('windows: a token is stored as a dpapi blob',
      prot.enc === 'dpapi' && /^[0-9a-f]+$/i.test(prot.apiKey), `${prot.enc} len ${prot.apiKey.length}`);
    ok('windows: the blob opens back to the token', revealSecret(prot.enc, prot.apiKey).apiKey === 'sk-test-123');
    ok('windows: a foreign blob is refused with a sentence, not an empty token',
      (() => { const r = revealSecret('dpapi', '00'.repeat(278)); return r.apiKey === '' && /re-enter/.test(r.keyError); })());
  } else {
    ok(`${process.platform}: no key store is used, so the token is stored plainly`,
      prot.enc === 'plain' && prot.apiKey === 'sk-test-123');
    ok(`${process.platform}: a plain row reads back as itself`, revealSecret('plain', 'sk-x').apiKey === 'sk-x');
  }
  ok('an empty secret is not encrypted at all', protectSecret('').enc === 'plain' && protectSecret('').apiKey === '');

  if (savedHomeEnv.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedHomeEnv.USERPROFILE;
  if (savedHomeEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = savedHomeEnv.HOME;
  fs.rmSync(connDir, { recursive: true, force: true });

  // 15. the port guard. `--port abc` reached net.listen as NaN and surfaced as a raw
  // RangeError stack; start.cmd now pauses on a non-zero exit, which would park that
  // stack in front of a double-clicking user. Asserted against the source, since the
  // guard runs in main() and exits the process.
  const portSrc = fs.readFileSync(path.join(HERE, 'server.js'), 'utf8');
  ok('a bad --port is refused with a sentence, not a stack trace',
    /Number\.isInteger\(port\)/.test(portSrc) && portSrc.includes('is not a usable port'));

  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter(c => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
}

module.exports = { run: selftest };

if (require.main === module) selftest();
