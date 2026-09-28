// Extracted from server.js — the two scalar coercion helpers shared by the
// model-capability reader and the connection store.
'use strict';

// A positive number from whatever the endpoint sent, or undefined. One reader for
// every numeric field: they arrive as numbers or numeric strings, and a missing or
// zero limit is not a limit worth showing.
const num = v => {
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// A string, or '' — every optional string on a model row is read the same way.
const str = v => (typeof v === 'string' ? v : '');

module.exports = { num, str };
