// Extracted from server.js — base-URL normalisation shared by the model list,
// the health check, and every simple-mode writer.
'use strict';

// These tools all want a base URL that ends in /v1, and adding a second one is the
// classic failure. Same rule as the model-list URL: normalise, never append blindly.
// ponytail: trailing slash is stripped before the /v1 check, so 'http://h/v1/' stays
// 'http://h/v1' instead of growing into 'http://h/v1/v1'.
const withV1 = base => {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/v1') ? b : `${b}/v1`;
};

// Where the model list lives, given a configured base URL. A base that already
// ends in /v1 must not become /v1/v1/models. One rule covers every tool here:
// Anthropic and the OpenAI-compatible ones all serve the list at <base>/v1/models.
// Throws on a URL that will not parse.
function modelsUrl(base) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const u = new URL(root);
  return new URL(/\/v1\/?$/.test(u.pathname) ? 'models' : 'v1/models', root);
}

// Same rule as modelsUrl, for the one-line completion a health check sends.
function chatUrl(base) {
  const root = base.endsWith('/') ? base : `${base}/`;
  const u = new URL(root);
  return new URL(/\/v1\/?$/.test(u.pathname) ? 'chat/completions' : 'v1/chat/completions', root);
}

module.exports = { withV1, modelsUrl, chatUrl };
