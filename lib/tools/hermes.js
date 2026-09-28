// Extracted from server.js — Hermes: <HERMES_HOME>/config.yaml holds a top-level
// `model:` block, and the key lives in the .env beside it, referenced from the
// block as ${OPENAI_API_KEY}. Besides that block Hermes reads a `delegation:`
// block and one block per role under `auxiliary:` — all four keys of the same
// shape, so one patcher serves all three.
'use strict';

const { withV1 } = require('../upstream.js');

const HERMES_MODEL_RE = /^model:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;
const HERMES_DELEGATION_RE = /^delegation:[ \t]*\r?\n((?:[ \t]+.*\r?\n?|[ \t]*\r?\n)*)/m;
const HERMES_AUX_RE = /^auxiliary:[ \t]*\r?\n((?:(?:[ \t]+.*\r?\n?)|(?:[ \t]*\r?\n))*)/m;
// Role ids are 9router's list; `delegation` is a top-level block, the rest live under
// `auxiliary:`. The editor offers a field per role and writes only the filled ones.
const HERMES_ROLES = ['delegation', 'vision', 'web_extract', 'compression', 'title_generation',
  'approval', 'skills_hub', 'mcp', 'memory_query_rewrite', 'background_review', 'curator', 'monitor'];
const hermesRoleRe = role =>
  new RegExp(`^  ${role}:[ \\t]*\\r?\\n(?:(?:[ \\t]{4,}.*\\r?\\n?)|(?:[ \\t]*\\r?\\n))*`, 'm');

function hermesBlockValue(body, key) {
  const m = new RegExp(`^[ \\t]+${key}:[ \\t]*["']?([^"'\\r\\n]+)["']?`, 'm').exec(body || '');
  return m ? m[1].trim() : '';
}

function hermesRead(text) {
  const src = text || '';
  const out = { baseUrl: '', apiKey: '', model: '' };
  const m = HERMES_MODEL_RE.exec(src);
  if (m) {
    out.baseUrl = hermesBlockValue(m[1], 'base_url');
    out.model = hermesBlockValue(m[1], 'default');
  }
  const d = HERMES_DELEGATION_RE.exec(src);
  out.delegation = d ? hermesBlockValue(d[1], 'model') : '';
  const aux = HERMES_AUX_RE.exec(src);
  for (const role of HERMES_ROLES) {
    if (role === 'delegation') continue;
    const r = aux ? new RegExp(`^  ${role}:[ \\t]*\\r?\\n((?:(?:[ \\t]{4,}.*\\r?\\n?)|(?:[ \\t]*\\r?\\n))*)`, 'm').exec(aux[1]) : null;
    out[role] = r ? hermesBlockValue(r[1], 'model') : '';
  }
  return out;
}

// Patch a Hermes block key by key, never rebuild it: a block in the wild carries keys
// this editor has no field for — context_length, max_tokens, an api_key line naming the
// user's own env var — and rebuilding would drop every one of them. Only the model key,
// base_url, provider and api_key are ours; the last two are only filled in when absent.
function hermesPatchBlock(body, indent, modelKey, v) {
  const lines = body.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const at = key => lines.findIndex(l => new RegExp(`^\\s+${key}\\s*:`).test(l));
  const put = (key, line) => {
    const i = at(key);
    if (i === -1) lines.push(line); else lines[i] = line;
  };
  put(modelKey, `${indent}${modelKey}: ${JSON.stringify(v.model)}`);
  put('base_url', `${indent}base_url: ${JSON.stringify(withV1(v.baseUrl))}`);
  // A provider of the user's own (a hand-written `provider: anthropic`) is left alone.
  if (at('provider') === -1) put('provider', `${indent}provider: "custom"`);
  if (at('api_key') === -1) put('api_key', `${indent}api_key: \${OPENAI_API_KEY}`);
  return lines.join('\n');
}

const hermesBuildBlock = (name, indent, modelKey, v) =>
  `${name}:\n` + hermesPatchBlock('', indent, modelKey, v) + '\n';

// The model block goes first when the file has none (9router does the same); the other
// blocks append, which is also what 9router's own writers do.
function hermesSetTopBlock(text, name, modelKey, v, prepend = false) {
  const re = name === 'model' ? HERMES_MODEL_RE : HERMES_DELEGATION_RE;
  const m = re.exec(text);
  if (!m) return prepend ? `${hermesBuildBlock(name, '  ', modelKey, v)}${text}` : `${text}${hermesBuildBlock(name, '  ', modelKey, v)}`;
  const block = `${name}:\n${hermesPatchBlock(m[1], '  ', modelKey, v)}\n`;
  const head = text.slice(0, m.index);
  const rest = text.slice(m.index + m[0].length);
  return `${head}${block}${rest ? `\n${rest}` : ''}`;
}

function hermesSetRole(text, role, v) {
  const aux = HERMES_AUX_RE.exec(text);
  const block = `  ${role}:\n`
    + hermesPatchBlock('', '  ', 'model', v).split('\n').map(l => `  ${l}`).join('\n') + '\n';
  if (!aux) return `${text}${text.length > 0 && !text.endsWith('\n') ? '\n' : ''}auxiliary:\n${block}`;
  const body = aux[1] || '';
  const re = hermesRoleRe(role);
  const next = re.test(body) ? body.replace(re, block) : `${body}${block}`;
  return text.replace(HERMES_AUX_RE, `auxiliary:\n${next}`);
}

function hermesWrite(text, v) {
  const out = text || '';
  const eol = out.includes('\r\n') ? '\r\n' : '\n';
  let next = hermesSetTopBlock(out, 'model', 'default', v, true);
  if (v.delegation) next = hermesSetTopBlock(next, 'delegation', 'model', { model: v.delegation, baseUrl: v.baseUrl });
  for (const role of HERMES_ROLES) {
    if (role === 'delegation' || !v[role]) continue;
    next = hermesSetRole(next, role, { model: v[role], baseUrl: v.baseUrl });
  }
  return next;
}

// Upsert/remove a single KEY=VALUE line in a .env file.
function envVarSet(text, key, value) {
  const src = text || '';
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(src)) return src.replace(re, line);
  return src.length > 0 && !src.endsWith('\n') ? `${src}\n${line}\n` : `${src}${line}\n`;
}

module.exports = {
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
};
