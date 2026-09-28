// Extracted from server.js — the double-click launcher installer for all three
// platforms. Windows gets a desktop .lnk plus a .vbs, Linux a .desktop file,
// macOS a .command in ~/Applications.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./paths.js');

// Quote a value as a PowerShell single-quoted string. Single quotes are literal
// in PowerShell, so doubling any embedded quote is the whole escaping rule — a
// path with an apostrophe (C:\Users\O'Brien) would otherwise break the command.
const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;

// A .lnk to `node server.js` would flash a console window for as long as the
// editor is open, because node is a console program. A .vbs run by wscript.exe is
// a GUI program, so nothing flashes — it starts node hidden and opens the browser.
// VBScript is deprecated but wscript.exe ships on every Windows and this is the
// one launcher that needs no shortcut binary and no extra dependency.
//
// ASCII only, on purpose: wscript.exe reads a .vbs as ANSI, so a UTF-8 em-dash
// would arrive as three garbage bytes. Comments are still parsed text.
function vbsLauncher(port) {
  return [
    'Option Explicit',
    "' CONFIG READER - starts the server hidden, then opens the browser.",
    "' Run it again while the editor is open and it just opens the tab.",
    'Dim sh, fso, here, node, msg',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'here = fso.GetParentFolderName(WScript.ScriptFullName)',
    'node = "node.exe"',
    'If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe") Then',
    '  node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\\nodejs\\node.exe"',
    'End If',
    // A shortcut that dies silently is the worst version of this: say what is wrong.
    'If node = "node.exe" Then',
    '  If sh.Run("cmd /c where node", 0, True) <> 0 Then',
    '    msg = "CONFIG READER needs Node.js 22.13 or newer, and node was not found." & vbCrLf & vbCrLf',
    '    msg = msg & "Install it from https://nodejs.org/ (the LTS installer is fine), " & vbCrLf',
    '    msg = msg & "then double-click this shortcut again."',
    '    MsgBox msg, 16, "CONFIG READER"',
    '    WScript.Quit 1',
    '  End If',
    'End If',
    `sh.CurrentDirectory = here`,
    // One wrapping pair of quotes around each path, and no quotes stored in the
    // variables — the Run line below adds exactly one pair to each.
    `sh.Run """" & node & """ """ & here & "\\server.js"" --port ${port} --open", 0, False`,
    '',
  ].join('\r\n');
}

// The .lnk itself. The WScript.Shell COM object that writes it is a Windows
// feature, so this whole function is Windows-only by construction — and the
// PowerShell that calls it is left as text so nothing here needs to escape it.
function installShortcutWindows(dir, port, name, vbs) {
  const lnk = path.join(dir, `${name}.lnk`);
  const ps = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut(${psQuote(lnk)})`,
    `$s.TargetPath = ${psQuote(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'))}`,
    `$s.Arguments = ${psQuote(`"${vbs}"`)}`,
    `$s.WorkingDirectory = ${psQuote(ROOT)}`,
    `$s.Description = ${psQuote('CONFIG READER')}`,
    '$s.Save()',
  ].join('; ');
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8', windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `powershell exited ${r.status}`);
  if (!fs.existsSync(lnk)) throw new Error('the shortcut was not created');
  return lnk;
}

// The Exec key is not a shell line. The desktop spec quotes an argument with " and
// escapes \ " ` and $ with a backslash, so a path with a space or a $ in it is
// otherwise split into separate arguments and the launcher quietly does nothing.
const execQuote = s => '"' + String(s).replace(/([\\"`$])/g, '\\$1') + '"';
const shQuote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

// A .desktop file is the Linux equivalent and needs no COM. `chmod +x` plus
// gio's trusted flag is what stops the desktop from opening it in a text editor.
function installShortcutLinux(dir, port, name) {
  const file = path.join(dir, `${name}.desktop`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=CONFIG READER',
    'Comment=Edit the env block of ~/.claude/settings.json',
    `Exec=node ${execQuote(path.join(ROOT, 'server.js'))} --port ${port} --open`,
    `Path=${ROOT}`,
    'Terminal=false',
    'Icon=utilities-terminal',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
  try {
    spawnSync('gio', ['set', file, 'metadata::trusted', 'true'], { windowsHide: true });
  } catch { /* gio is optional; the file still works when launched from a file manager */ }
  return file;
}

// macOS has neither .lnk nor .desktop, but a .command file is the native equivalent:
// Finder opens it in Terminal and runs it, so a double-click is all it takes. An .app
// bundle would buy an icon and nothing else this tool needs.
function installShortcutMac(dir, port, name) {
  const file = path.join(dir, `${name}.command`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ncd ${shQuote(ROOT)}\nexec node ./server.js --port ${port} --open\n`);
  fs.chmodSync(file, 0o755);
  return file;
}
// --dir, or null for "use the platform default". A relative path is relative to
// the editor's folder, so `--dir .` and a USB path both behave predictably.
const resolveDirArg = raw => (raw ? path.resolve(ROOT, raw) : null);

// Where the Desktop really is. The registry is the only authoritative answer:
// OneDrive and corporate folder redirection both move it, and ~/Desktop may still
// exist as a stale leftover — so probing that first is how a shortcut ends up in a
// folder the user never sees. Falls back only if the registry says nothing useful.
function desktopDirWin() {
  const r = spawnSync('reg', ['query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '/v', 'Desktop'], { encoding: 'utf8', windowsHide: true });
  const m = /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(r.stdout || '');
  if (m) {
    // The value is usually REG_EXPAND_SZ: %USERPROFILE%\Desktop or %OneDrive%\Desktop.
    const p = m[1].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
    if (fs.existsSync(p)) return p;
  }
  for (const d of [path.join(process.env.OneDrive || '', 'Desktop'), path.join(os.homedir(), 'Desktop')]) {
    if (d && fs.existsSync(d)) return d;
  }
  return null;
}

// Where the shortcut goes. Windows gets a desktop .lnk; Linux gets the .desktop
// file in the applications dir; macOS gets a double-clickable .command in
// ~/Applications. A platform with none of those still gets the launcher file, and
// the caller is told where it landed rather than being handed a broken shortcut.
function installShortcut(port, name = 'CONFIG READER', dirOverride = null) {
  const vbs = path.join(ROOT, 'launch.vbs');
  let dir = null, file = null, note = '';
  if (process.platform === 'win32') {
    fs.writeFileSync(vbs, vbsLauncher(port));
    dir = dirOverride || desktopDirWin();
    if (!dir) note = 'no Desktop folder found — launcher written instead';
    else {
      fs.mkdirSync(dir, { recursive: true });
      file = installShortcutWindows(dir, port, name, vbs);
    }
  } else if (process.platform === 'linux') {
    dir = dirOverride || path.join(os.homedir(), '.local', 'share', 'applications');
    file = installShortcutLinux(dir, port, name);
    note = 'also available from the application menu';
  } else if (process.platform === 'darwin') {
    // ~/Applications needs no admin rights and Spotlight indexes it. A bare home
    // directory (some CI images) still gets the file, just with no note to explain it.
    dir = dirOverride || path.join(os.homedir(), 'Applications');
    file = installShortcutMac(dir, port, name);
    note = 'double-click it in Finder; if macOS blocks it, right-click → Open once';
  } else {
    note = `no shortcut installer for ${process.platform} — the launcher is at ${vbs}`;
  }
  return { file: file || vbs, dir, vbs, note };
}

module.exports = {
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
};
