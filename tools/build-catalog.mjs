// Dev-only. Regenerates catalog.json. Not part of runtime.
//   node tools/build-catalog.mjs
// Sources: docs settings-reference (231 keys + scope + category) merged with
// schemastore (type/enum/default for the 142 it knows). Docs win on description.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DOCS = 'https://code.claude.com/docs/en/settings-reference.md';
const SCHEMA = 'https://json.schemastore.org/claude-code-settings.json';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.json');

const SCOPE = {
  'Any file': 'any',
  'User, local, or managed': 'ulm',
  'User or managed': 'um',
  'Managed': 'managed',
  'Global config': 'gc',
};

// [text](url) -> text, [`x`](#y) -> x, `x` -> x
const clean = s => s
  .replace(/\[`([^`]+)`\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/`/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const [docsText, schema] = await Promise.all([
  fetch(DOCS).then(r => r.text()),
  fetch(SCHEMA).then(r => r.json()),
]);

// --- docs: 231 rows of | [`key`](#anchor) | description | category | scope |
const cat = {};
let rowCount = 0;
for (const line of docsText.split('\n')) {
  const m = line.match(/^\|\s*\[`([^`]+)`\]\(#[^)]*\)\s*\|(.+?)\|(.+?)\|(.+?)\|\s*$/);
  if (!m) continue;
  const [, key, desc, category, scope] = m;
  const sc = SCOPE[clean(scope)];
  if (!sc) continue; // unrecognised scope wording -> skip rather than guess
  cat[key] = { x: clean(desc), c: clean(category), s: sc };
  rowCount++;
}

// --- schemastore: type / enum / default / boolean descriptions
const defs = schema.$defs || {};
const resolve = s => { while (s && s.$ref) s = defs[s.$ref.split('/').pop()]; return s; };

const inferType = v => {
  if (v.enum) return 'enum';
  if (v.type) return v.type;
  const branches = (v.anyOf || v.oneOf || []).map(resolve).filter(Boolean);
  if (branches.some(b => b.enum)) return 'enum';
  if (branches.some(b => b.type === 'object' && b.properties)) return 'object';
  if (branches.some(b => b.type === 'array')) return 'array';
  const first = branches.find(b => b.type);
  return first ? first.type : 'json';
};

let enriched = 0;
for (const [key, v0] of Object.entries(schema.properties || {})) {
  const v = resolve(v0) || {};
  const e = v.enum || ((v.anyOf || v.oneOf || []).map(resolve).find(b => b && b.enum) || {}).enum;
  const entry = cat[key] || (cat[key] = { x: '', c: '', s: 'any' });
  entry.t = e ? 'enum' : inferType(v);
  if (e) entry.e = e;
  if (v.default !== undefined && typeof v.default !== 'object') entry.d = v.default;
  if (entry.x === '' && v.description) entry.x = clean(String(v.description).split('\n')[0]);
  enriched++;
}

writeFileSync(OUT, JSON.stringify(cat));

const types = {};
for (const v of Object.values(cat)) types[v.t || '(none)'] = (types[v.t || '(none)'] || 0) + 1;
const scopes = {};
for (const v of Object.values(cat)) scopes[v.s] = (scopes[v.s] || 0) + 1;

console.log(`docs rows parsed : ${rowCount}`);
console.log(`schema enriched  : ${enriched}`);
console.log(`catalog keys     : ${Object.keys(cat).length}`);
console.log(`catalog bytes    : ${JSON.stringify(cat).length}`);
console.log(`types            : ${JSON.stringify(types)}`);
console.log(`scopes           : ${JSON.stringify(scopes)}`);
