// Extracted from server.js — Codex CLI: ~/.codex/config.toml. The key travels in
// the provider block, because a custom provider ignores auth.json — and as a static
// Authorization header, which is the form Codex documents; experimental_bearer_token
// is only read for configs another tool wrote that way.
'use strict';

const { withV1 } = require('../upstream.js');
const { PROVIDER, PROVIDER_LABEL } = require('./provider.js');

const tomlString = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const tomlUnquote = v => v.replace(/\\(["\\])/g, '$1');

// A top-level `key = "value"` in a TOML file, ignoring anything inside a [section].
function tomlTopValue(text, key) {
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) { section = head[1]; continue; }
    if (section) continue;
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"\\s*$`).exec(line);
    if (m) return tomlUnquote(m[1]);
  }
  return '';
}

// Every `key = "value"` inside one [section], stopping at the next section header.
function tomlSectionValues(text, section) {
  const out = {};
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) { inside = head[1] === section; continue; }
    if (!inside) continue;
    const m = /^\s*([A-Za-z0-9_-]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m) out[m[1]] = tomlUnquote(m[2]);
  }
  return out;
}

// Replace a top-level `key = "value"` in place, or insert it above the first
// section. Returns the text unchanged when the value is empty — clearing a key
// this editor owns is not worth a special case, and a blank line is worse than a
// stale one.
function tomlSetTop(text, key, value) {
  const line = `${key} = ${tomlString(value)}`;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*".*"\\s*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const firstSection = text.search(/^\s*\[/m);
  if (firstSection === -1) return `${text.replace(/\s*$/, '')}\n${line}\n`;
  const at = text.lastIndexOf('\n', firstSection) + 1;
  return `${text.slice(0, at)}${line}\n${text.slice(at)}`;
}

// Replace one whole [section] with `body` (which must start with its own header),
// or append it when the file has none. Everything outside the section is kept.
function tomlSetSection(text, section, body) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${section.replace(/\./g, '\\.')}\\]`).test(l));
  if (start === -1) {
    const head = text.replace(/\s*$/, '');
    return `${head ? `${head}\n\n` : ''}${body.replace(/\s*$/, '')}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { end = i; break; }
  }
  // Swallow the blank line that separated the old section from the next one.
  while (end < lines.length && lines[end].trim() === '') end++;
  const head = lines.slice(0, start).join('\n').replace(/\s*$/, '');
  const tail = lines.slice(end).join('\n').replace(/^\s*/, '');
  return `${head ? `${head}\n\n` : ''}${body.replace(/\s*$/, '')}\n${tail ? `\n${tail}` : ''}`;
}

// Set one key inside a section, creating the section when the file has none. Unlike
// tomlSetSection this keeps the section's other keys: [agents] holds settings this
// editor has no field for.
function tomlSetInSection(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^\\s*\\[${section}\\]`).test(l));
  if (start === -1) return tomlSetSection(text, section, `[${section}]\n${key} = ${tomlString(value)}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^\s*\[/.test(lines[i])) { end = i; break; }
  const re = new RegExp(`^\\s*${key}\\s*=`);
  const at = lines.findIndex((l, i) => i > start && i < end && re.test(l));
  if (at === -1) lines.splice(end, 0, `${key} = ${tomlString(value)}`);
  else lines[at] = `${key} = ${tomlString(value)}`;
  return lines.join('\n');
}

function codexKey(src) {
  const hdr = tomlSectionValues(src, `model_providers.${PROVIDER}.http_headers`);
  const auth = hdr.Authorization || hdr.authorization || '';
  if (auth) return auth.replace(/^Bearer\s+/i, '');
  const prov = tomlSectionValues(src, `model_providers.${PROVIDER}`);
  return prov.experimental_bearer_token || prov.api_key || '';
}

function codexRead(text) {
  const src = text || '';
  const prov = tomlSectionValues(src, `model_providers.${PROVIDER}`);
  return {
    baseUrl: prov.base_url || '',
    apiKey: codexKey(src),
    model: tomlTopValue(src, 'model'),
    subagentModel: tomlSectionValues(src, 'agents').default_subagent_model || '',
  };
}

function codexWrite(text, v) {
  let out = text || '';
  out = tomlSetTop(out, 'model_provider', PROVIDER);
  if (v.model) out = tomlSetTop(out, 'model', v.model);
  if (v.subagentModel) out = tomlSetInSection(out, 'agents', 'default_subagent_model', v.subagentModel);
  const lines = [
    `[model_providers.${PROVIDER}]`,
    `name = ${tomlString(PROVIDER_LABEL)}`,
    `base_url = ${tomlString(withV1(v.baseUrl))}`,
    'wire_api = "responses"',
  ];
  out = tomlSetSection(out, `model_providers.${PROVIDER}`, lines.join('\n'));
  if (v.apiKey) {
    out = tomlSetSection(out, `model_providers.${PROVIDER}.http_headers`,
      `[model_providers.${PROVIDER}.http_headers]\nAuthorization = ${tomlString(`Bearer ${v.apiKey}`)}`);
  }
  return out;
}

module.exports = {
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
};
