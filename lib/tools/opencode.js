// Extracted from server.js — OpenCode: ~/.config/opencode/opencode.json. JSONC in
// the wild, so trailing commas are stripped before parsing.
'use strict';

const { withV1 } = require('../upstream.js');
const { PROVIDER, PROVIDER_LABEL } = require('./provider.js');

// JSONC in the wild, so trailing commas are stripped before parsing — the same
// tolerance 9router has.
function jsoncParse(text) {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
}

function opencodeRead(text) {
  let cfg;
  try { cfg = jsoncParse(text || '{}'); } catch { return { baseUrl: '', apiKey: '', model: '', subagentModel: '', broken: true }; }
  const p = cfg?.provider?.[PROVIDER];
  const model = typeof cfg?.model === 'string' && cfg.model.startsWith(`${PROVIDER}/`)
    ? cfg.model.slice(PROVIDER.length + 1) : '';
  const sub = cfg?.agent?.explorer?.model;
  return {
    baseUrl: p?.options?.baseURL || '',
    apiKey: p?.options?.apiKey || '',
    model,
    subagentModel: typeof sub === 'string' && sub.startsWith(`${PROVIDER}/`)
      ? sub.slice(PROVIDER.length + 1) : '',
  };
}

function opencodeWrite(text, v) {
  const cfg = jsoncParse(text || '{}');
  if (!cfg.provider || typeof cfg.provider !== 'object') cfg.provider = {};
  // An existing entry keeps its model list; this editor only owns the three values.
  const p = cfg.provider[PROVIDER] || { npm: '@ai-sdk/openai-compatible', name: PROVIDER_LABEL, models: {} };
  p.options = { ...(p.options || {}), baseURL: withV1(v.baseUrl) };
  if (v.apiKey) p.options.apiKey = v.apiKey;
  if (!p.models || typeof p.models !== 'object') p.models = {};
  if (v.model) p.models[v.model] = { name: v.model };
  cfg.provider[PROVIDER] = p;
  if (v.model) cfg.model = `${PROVIDER}/${v.model}`;
  if (v.subagentModel) {
    if (!cfg.agent || typeof cfg.agent !== 'object') cfg.agent = {};
    cfg.agent.explorer = {
      description: 'Fast explorer subagent for codebase exploration',
      mode: 'subagent',
      model: `${PROVIDER}/${v.subagentModel}`,
    };
  }
  return `${JSON.stringify(cfg, null, 2)}\n`;
}

module.exports = { jsoncParse, opencodeRead, opencodeWrite };
