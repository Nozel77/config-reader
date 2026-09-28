// Extracted from server.js — every path this project derives server-side.
// The browser names a tool, never a file; these functions are the only place
// a filesystem path is composed.
'use strict';

const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'index.html');
const APP_TS = path.join(ROOT, 'app.ts');
const ICONS = path.join(ROOT, 'icons');

// CLAUDE_CONFIG_DIR overrides ~/.claude entirely. Check it before homedir().
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Hermes follows the same rule with its own variable. The Hermes installer sets
// HERMES_HOME (AppData\Local\hermes on Windows) and the agent reads that directory,
// so ~/.hermes can be an empty leftover — editing it would write a config nothing
// opens. ponytail: the default profile only; a named profile lives under
// <HERMES_HOME>/profiles/<name> and is not guessed at.
const hermesHome = () => process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');

// Codex: CODEX_HOME or ~/.codex. It has no XDG fallback, so there is no second
// candidate to guess at. Checked because a CODEX_HOME install otherwise gets its
// config written to a ~/.codex the CLI never reads.
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// OpenCode follows the XDG base-directory spec on Linux and macOS, but on Windows
// it uses %USERPROFILE%\.config — XDG_CONFIG_HOME is not honoured there. Both
// rules are opencode's own; this only mirrors them.
const opencodeDir = () => {
  const xdg = process.platform === 'win32' ? '' : process.env.XDG_CONFIG_HOME;
  return path.join(xdg || path.join(os.homedir(), '.config'), 'opencode');
};

// The one file this editor works on. Fixed server-side on purpose: no path ever
// arrives from the browser, so there is no path to validate and nothing to
// traverse out of. CLAUDE_CONFIG_DIR still moves it, which is Claude Code's own
// rule for where user settings live.
const settingsFile = () => path.join(configDir(), 'settings.json');

// Saved endpoints: one file, under the home dir so a re-clone does not take the
// tokens with it. The path is derived here; the browser never sends one.
const connectionsFile = () => path.join(os.homedir(), '.config-reader', 'connections.json');

module.exports = {
  ROOT,
  INDEX,
  APP_TS,
  ICONS,
  configDir,
  hermesHome,
  codexHome,
  opencodeDir,
  settingsFile,
  connectionsFile,
};
