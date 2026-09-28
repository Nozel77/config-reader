// Extracted from server.js — reading the capability fields out of a /v1/models
// reply. Every shape a gateway may use is tried in turn; nothing is guessed.
'use strict';

const { num, str } = require('./util.js');

// The context window each model advertises, by id. Claude Code assumes 200K unless
// the model name carries a trailing [1m], so the editor needs this to decide whether
// to add that marker on assign. Four shapes are in the wild — a flat context_length,
// a nested capabilities.contextWindow, Anthropic's max_input_tokens, and
// models.dev/OpenRouter's limit.context / top_provider.context_length — and some
// entries carry none, which is why a missing window is left out rather than guessed at.
function modelWindows(rows) {
  const out = {};
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name || m.model;
    const w = num(m.context_length) ?? num(m.max_input_tokens)
      ?? num(m.capabilities && m.capabilities.contextWindow)
      ?? num(m.limit && m.limit.context) ?? num(m.top_provider && m.top_provider.context_length);
    if (typeof id === 'string' && id && w) out[id] = w;
  }
  return out;
}

// Whether each model takes image input, by id. Same honesty rule as windows:
// only explicit capability fields count — a missing signal is left out rather
// than guessed from the model name, so the card shows no vision badge for it.
// Three shapes are in the wild (OpenRouter-style gateways send the latter two):
//   a boolean flag (vision / supports_vision / capabilities.vision / ...),
//   a modality list (modalities / input_modalities / architecture.input_modalities),
//   a modality string ("text+image->text" in architecture.modality).
const VISION_TRUE_TOKENS = new Set(['image', 'images', 'vision', 'visual']);

// A modality value as true/false/undefined. Accepts the three shapes gateways use:
// an array (["text","image"]), a "+"-joined string ("text+image->text" in
// OpenRouter's architecture.modality), and an object naming its input side
// ({"input":["text","image"]} — kenari, HF router, models.dev). Names an image
// modality -> vision; a non-empty value naming none -> text-only. Anything else
// (absent, empty, non-strings) is unknown, not a no.
function visionFromModalities(v) {
  // Only the input side counts: an output image modality is image generation, not
  // the ability to read a picture.
  const side = v && typeof v === 'object' && !Array.isArray(v)
    ? (v.input ?? v.input_modalities)
    : v;
  const toks = Array.isArray(side)
    ? side.filter(x => typeof x === 'string').map(x => x.toLowerCase())
    : typeof side === 'string' && side
      ? side.toLowerCase().split(/[^a-z]+/).filter(Boolean)
      : [];
  if (!toks.length) return undefined;
  return toks.some(t => VISION_TRUE_TOKENS.has(t));
}

const VISION_BOOL_KEYS = ['vision', 'supports_vision', 'supportsVision', 'supports_image',
  'supportsImage', 'image_input', 'supports_image_input', 'multimodal', 'has_vision', 'is_vision'];
const VISION_MOD_KEYS = ['modalities', 'modality', 'input_modalities', 'inputModalities',
  'supported_modalities', 'supportedModalities'];

function rowVision(m) {
  if (!m || typeof m !== 'object') return undefined;
  const scopes = [m, m.capabilities, m.architecture, m.info].filter(s => s && typeof s === 'object');
  for (const s of scopes) {
    for (const k of VISION_BOOL_KEYS) {
      const v = s[k];
      if (typeof v === 'boolean') return v;
      // Anthropic reports these as { supported: true } rather than a bare flag.
      if (v && typeof v === 'object' && typeof v.supported === 'boolean') return v.supported;
    }
  }
  for (const s of scopes) {
    for (const k of VISION_MOD_KEYS) {
      if (k in s) {
        const r = visionFromModalities(s[k]);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

function modelVision(rows) {
  const out = {};
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name || m.model;
    const v = rowVision(m);
    if (typeof id === 'string' && id && typeof v === 'boolean') out[id] = v;
  }
  return out;
}

// Everything the endpoint said about each model, by id. `caps` is the endpoint's own
// capabilities object passed through untouched — its keys are that gateway's
// vocabulary, not ours, so a gateway reporting something new needs no change here.
// The rest is derived, and each field has more than one shape in the wild: numbers
// arrive flat (context_length), nested (capabilities.contextWindow) or per-upstream
// (top_provider.max_completion_tokens), so every spelling is tried in turn and a
// field nobody reported stays out rather than being guessed at. `meta` is the display
// layer: a human name, whether the model is free, whether it is on its way out.
function modelCaps(rows) {
  const out = {};
  for (const m of rows) {
    if (!m || typeof m !== 'object') continue;
    const id = m.id || m.name || m.model;
    if (typeof id !== 'string' || !id) continue;
    const src = m.capabilities;
    const caps = src && typeof src === 'object' && !Array.isArray(src) ? { ...src } : {};
    if (typeof caps.vision !== 'boolean') {
      const v = rowVision(m);
      if (typeof v === 'boolean') caps.vision = v;
    }
    // OpenRouter reports tool support as a parameter list, not a flag.
    if (Array.isArray(m.supported_parameters) && typeof caps.tools !== 'boolean') {
      caps.tools = m.supported_parameters.includes('tools');
    }
    // kenari and models.dev report the same facts as flat booleans. Only exact names
    // are aliased — a field whose meaning has to be interpreted is left alone.
    if (typeof m.tool_call === 'boolean' && typeof caps.tools !== 'boolean') caps.tools = m.tool_call;
    if (typeof m.reasoning === 'boolean' && typeof caps.reasoning !== 'boolean') caps.reasoning = m.reasoning;
    // Reasoning levels, from either spelling: a flat list (kenari's reasoning_options)
    // or OpenRouter's nested reasoning.supported_efforts.
    const efforts = [
      ...(Array.isArray(m.reasoning_options) ? m.reasoning_options : []),
      ...(m.reasoning && Array.isArray(m.reasoning.supported_efforts) ? m.reasoning.supported_efforts : []),
    ].filter(x => typeof x === 'string');
    const p = m.pricing && typeof m.pricing === 'object' ? m.pricing : {};
    // Free is explicit on some gateways (kenari) and a zero price on others.
    const free = typeof p.free === 'boolean' ? p.free
      : (p.prompt !== undefined || p.completion !== undefined) && !num(p.prompt) && !num(p.completion);
    out[id] = {
      provider: str(m.owned_by),
      ctx: num(m.context_length) ?? num(m.max_input_tokens) ?? num(caps.contextWindow)
        ?? num(m.limit && m.limit.context) ?? num(m.top_provider && m.top_provider.context_length) ?? 0,
      maxOut: num(m.max_completion_tokens) ?? num(m.max_tokens) ?? num(caps.maxOutput)
        ?? num(m.limit && m.limit.output) ?? num(m.top_provider && m.top_provider.max_completion_tokens) ?? 0,
      caps,
      meta: {
        name: str(m.display_name) || str(m.name),
        description: str(m.description),
        free,
        sunset: str(m.sunset_at) || str(m.expiration_date),
        efforts: [...new Set(efforts)],
        endpoints: (Array.isArray(m.endpoints) ? m.endpoints : []).filter(x => typeof x === 'string'),
      },
    };
  }
  return out;
}

module.exports = {
  modelWindows,
  VISION_TRUE_TOKENS,
  visionFromModalities,
  VISION_BOOL_KEYS,
  VISION_MOD_KEYS,
  rowVision,
  modelVision,
  modelCaps,
};
