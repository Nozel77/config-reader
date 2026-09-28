// Extracted from server.js — a token at rest. On Windows, DPAPI through the
// PowerShell that ships with the OS: no native module, no build step, and a blob
// only this user on this machine can open. Everywhere else there is no OS key
// store this project can reach without a dependency, so the token is stored
// plainly — the same as the config files it is copied into.
'use strict';

const { spawnSync } = require('node:child_process');

// `enc: 'dpapi'` in the file is what says which one a row is.
// ponytail: DPAPI protects a copied file, not a process running as this user.
// macOS Keychain / libsecret are the upgrade path, as one optional dependency.
const DPAPI_PROTECT = '$t = [Console]::In.ReadToEnd();'
  + ' ConvertTo-SecureString -String $t -AsPlainText -Force | ConvertFrom-SecureString | Write-Output';
const DPAPI_UNPROTECT = '$h = [Console]::In.ReadToEnd().Trim();'
  + ' [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR((ConvertTo-SecureString $h))) | Write-Output';

// The secret travels over stdin, never in the command line: argv is readable by any
// process that can list command lines, and a token is not worth that.
function dpapi(script, input) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, input, timeout: 10000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || 'powershell failed').trim().split('\n')[0]);
  return (r.stdout || '').trim();
}

const secretsAtRest = () => process.platform === 'win32';

function protectSecret(plain) {
  if (!plain || !secretsAtRest()) return { apiKey: plain, enc: 'plain' };
  try {
    return { apiKey: dpapi(DPAPI_PROTECT, plain), enc: 'dpapi' };
  } catch {
    // Losing the token the user just typed is worse than storing it plainly.
    return { apiKey: plain, enc: 'plain' };
  }
}

// '' keyError means the value is usable; a message means the blob cannot be opened
// here (another machine, another account) and the UI must say so rather than apply
// an empty token.
function revealSecret(enc, value) {
  if (!value) return { apiKey: '', keyError: '' };
  if (enc !== 'dpapi') return { apiKey: value, keyError: '' };
  try {
    return { apiKey: dpapi(DPAPI_UNPROTECT, value), keyError: '' };
  } catch {
    return { apiKey: '', keyError: 'stored on another machine or user account — re-enter the token' };
  }
}

module.exports = { dpapi, secretsAtRest, protectSecret, revealSecret };
