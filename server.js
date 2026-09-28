// CONFIG READER — local web editor. Zero npm deps, Node stdlib only.
//   node server.js [--port 8787] [--open] [--selftest]
'use strict';

// Needs Node 22.13+ — the release stripTypeScriptTypes actually landed in (v22.13.0,
// and v23.2.0 on the odd line). A bare major check waves 22.0-22.12 through, and the
// failure then surfaces as a dead page rather than a sentence, so the check asks for
// the functions themselves instead of parsing a version number.
const { stripTypeScriptTypes } = require('node:module');
const missing = typeof stripTypeScriptTypes !== 'function' ? 'stripTypeScriptTypes'
  : typeof fetch !== 'function' ? 'fetch'
  : typeof globalThis.AbortSignal?.timeout !== 'function' ? 'AbortSignal.timeout'
  : null;
if (missing) {
  console.error(`CONFIG READER needs Node.js 22.13 or newer — no ${missing} here (running ${process.versions.node}).`);
  process.exit(1);
}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const HERE = __dirname;
const { configDir, hermesHome, codexHome, opencodeDir, settingsFile, connectionsFile, INDEX, APP_TS, ICONS } = require('./lib/paths.js');
const { detectEol, readText, atomicWrite, backupBeforeWrite, sleep, BACKUPS } = require('./lib/fs-safe.js');
const { MAX_BODY, appJs, send, isUp, openBrowser, originOk, readBody, jsonBody } = require('./lib/http.js');
const { withV1, modelsUrl, chatUrl } = require('./lib/upstream.js');
const { num } = require('./lib/util.js');
const { modelWindows, VISION_TRUE_TOKENS, visionFromModalities, VISION_BOOL_KEYS, VISION_MOD_KEYS, rowVision, modelVision, modelCaps } = require('./lib/model-caps.js');
const { PROVIDER, PROVIDER_LABEL } = require('./lib/tools/provider.js');
const { readSettings, parseHint } = require('./lib/tools/claude.js');
const { tomlString, tomlUnquote, tomlTopValue, tomlSectionValues, tomlSetTop, tomlSetSection, tomlSetInSection, codexKey, codexRead, codexWrite } = require('./lib/tools/codex.js');
const { jsoncParse, opencodeRead, opencodeWrite } = require('./lib/tools/opencode.js');
const { HERMES_MODEL_RE, HERMES_DELEGATION_RE, HERMES_AUX_RE, HERMES_ROLES, hermesRoleRe, hermesBlockValue, hermesRead, hermesPatchBlock, hermesBuildBlock, hermesSetTopBlock, hermesSetRole, hermesWrite, envVarSet } = require('./lib/tools/hermes.js');
const { TOOLS, toolById, hasBin, toolList, toolPaths, scanInfo, readSimple, writeSimple } = require('./lib/tools/index.js');
const { CONNECTIONS_MAX, cleanConnection, cleanConnectionRow, readConnections, writeConnections } = require('./lib/connections.js');
const { dpapi, secretsAtRest, protectSecret, revealSecret } = require('./lib/secrets.js');
const { psQuote, vbsLauncher, installShortcutWindows, execQuote, shQuote, nodeBin, installShortcutLinux, installShortcutMac, resolveDirArg, desktopDirWin, installShortcut } = require('./lib/shortcut.js');
const { handler } = require('./lib/router.js');

// ------------------------------------------------------------------------ main

async function main() {
  const argv = process.argv.slice(2);
  // The selftest moved to scripts/selftest.js (it needs the whole module, so keeping it
  // inline meant the server carried 600 lines of assertions). This flag stays because
  // it is in the README, the launcher and muscle memory — it just forwards.
  if (argv.includes('--selftest')) return require('./scripts/selftest.js').run();

  const portArg = argv.indexOf('--port');
  const port = portArg > -1 ? Number(argv[portArg + 1]) : 8787;
  const open = argv.includes('--open');

  // `--port abc` used to reach net.listen as NaN and surface as a raw RangeError
  // stack. start.cmd now pauses on any non-zero exit, so a bad flag would park a
  // stack trace in front of a double-clicking user. One sentence instead.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`\n  "${argv[portArg + 1]}" is not a usable port. Try: node server.js --port 8787\n`);
    process.exit(1);
  }

  // Write the double-click launcher and stop. `start.cmd --shortcut` is the one
  // command a user needs to run once; after that the desktop icon is the entry point.
  if (argv.includes('--shortcut')) {
    const nameArg = argv.indexOf('--name');
    const name = nameArg > -1 && argv[nameArg + 1] ? argv[nameArg + 1] : 'CONFIG READER';
    // --dir wins, so the shortcut can go anywhere: the public desktop, a USB stick,
    // a Start Menu folder. Relative paths resolve against the editor's own folder.
    const dirArg = argv.indexOf('--dir');
    const dirOverride = resolveDirArg(dirArg > -1 && argv[dirArg + 1] ? argv[dirArg + 1] : null);
    let made;
    try { made = installShortcut(port, name, dirOverride); }
    catch (e) { console.error(`\nCould not create the shortcut: ${e.message}\n`); process.exit(1); }
    console.log(`\n  Shortcut ready — double-click it to open the editor.\n`);
    if (made.file && made.dir) console.log(`  ${made.file}`);
    else console.log(`  launcher: ${made.vbs}`);
    if (made.note) console.log(`  ${made.note}`);
    // "hidden" is a Windows-only property: the .vbs starts node with a hidden window.
    // Linux and macOS launch it like any other app, so the line must not claim it.
    console.log(process.platform === 'win32'
      ? `\n  It starts the server on port ${port} hidden and opens http://127.0.0.1:${port}\n`
      : `\n  It starts the server on port ${port} and opens http://127.0.0.1:${port}\n`);
    return;
  }

  // Double-clicking the shortcut while the editor is already open must not die on
  // EADDRINUSE — it means "show me the window", so hand the URL to the browser.
  if (open && await isUp(port)) {
    console.log(`\n  Already running — opening http://127.0.0.1:${port}\n`);
    openBrowser(`http://127.0.0.1:${port}`);
    return;
  }

  const server = http.createServer((req, res) => {
    handler(req, res, port).catch(e => {
      if (res.headersSent) return;
      send(res, e.status || 500, JSON.stringify({ error: e.message }));
    });
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nPort ${port} is busy. Another copy may already be running.`);
      console.error(`Open http://127.0.0.1:${port} — or start with: node server.js --port ${port + 1}\n`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`\n  CONFIG READER\n  ${url}\n  will edit ${settingsFile()}\n\n  Ctrl+C to stop\n`);
    if (open) openBrowser(url);
  });
}

// Run directly it is a server; required, it is the module its own tests and tools read.
module.exports = {
  spawnSync,
  spawn,
  stripTypeScriptTypes,
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
  parseHint,
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
  nodeBin,
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
  CONNECTIONS_MAX,
  connectionsFile,
  dpapi,
  secretsAtRest,
  protectSecret,
  revealSecret,
  cleanConnection,
  cleanConnectionRow,
  readConnections,
  writeConnections,
  handler,
  main,
};

if (require.main === module) main();
