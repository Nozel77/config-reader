// Dev-only. Reads the colour tokens out of styles.css and checks every foreground /
// background pair the stylesheet actually paints, plus that the three theme blocks
// stay in step. Editing a hex is what this catches.
//   node scripts/check-contrast.mjs [path/to/styles.css]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || join(HERE, '..', 'styles.css');
const css = readFileSync(FILE, 'utf8');

// --- pull the three theme blocks -------------------------------------------------
// Each entry: a selector to find, and the name the report uses for it.
const BLOCKS = [
  { sel: ':root, [data-theme="light"]', name: 'light' },
  { sel: '[data-theme="dark"]', name: 'dark' },
  { sel: ':root:not([data-theme])', name: 'os-dark' },
];

function blockBody(selector) {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`selector not found in styles.css: ${selector}`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced braces after ${selector}`);
}

function tokens(selector) {
  const body = blockBody(selector).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

// --- colour maths ----------------------------------------------------------------
function parse(value) {
  const v = value.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    return [+('0x' + h.slice(0, 2)), +('0x' + h.slice(2, 4)), +('0x' + h.slice(4, 6))];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (m) return [+m[1], +m[2], +m[3]];
  return null; // a var(), a gradient, a colour function we do not need to measure
}

const lum = ([r, g, b]) => {
  const [R, G, B] = [r, g, b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};

function ratio(fg, bg) {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// --- the pairs the stylesheet actually paints ------------------------------------
// 4.5 = body text (WCAG 1.4.3 AA). 3.0 = controls and boundaries (1.4.11).
// The last entry of each row is the floor. A surface pair is there to prove the two
// planes are still distinguishable: at 1.10:1 a card on a page is a rectangle nobody
// sees, which is a theme that only looks right in a screenshot.
const PAIRS = [
  ['text', 'bg', 4.5], ['text', 'surface', 4.5], ['text', 'surface-2', 4.5],
  ['text-2', 'bg', 4.5], ['text-2', 'surface', 4.5], ['text-2', 'surface-2', 4.5], ['text-2', 'accent-soft', 4.5],
  ['text-3', 'bg', 4.5], ['text-3', 'surface', 4.5], ['text-3', 'surface-2', 4.5], ['text-3', 'accent-soft', 4.5],
  ['placeholder', 'bg', 4.5], ['placeholder', 'surface', 4.5],
  ['accent-btn-text', 'accent-btn', 4.5],
  ['err-btn-text', 'err-btn', 4.5], ['err-btn-text', 'err-btn-hover', 4.5],
  ['accent-text', 'accent-soft', 4.5],
  ['ok-text', 'ok-soft', 4.5], ['warn-text', 'warn-soft', 4.5], ['err-text', 'err-soft', 4.5],
  ['err-text', 'surface', 4.5],
  // The raw view's tokenizer paints a key in the accent and a number in the ok colour,
  // both on the code body's --surface. A syntax colour is text like any other, so it
  // is held to the body floor rather than to the 3.0 a control gets.
  ['accent-text', 'surface', 4.5], ['ok-text', 'surface', 4.5],
  ['accent', 'surface', 3.0], ['accent', 'bg', 3.0],
  ['border-strong', 'surface', 3.0], ['border-strong', 'bg', 3.0],
  ['scroll-thumb', 'bg', 3.0], ['scroll-thumb', 'surface-2', 3.0],
  // Planes, not text: the card must sit on the page, and the rail on the card.
  ['surface', 'bg', 1.10], ['surface-2', 'surface', 1.10], ['surface-2', 'bg', 1.10],
];

// Geometry, type and motion are declared once on :root and inherited; only the three
// colour blocks are meant to be copies of each other. Comparing every key flagged
// those as drift, which is how a checker earns being ignored.
const NOT_COLOUR = new Set(['--radius', '--ctl', '--ctl-r', '--icon', '--transition', '--ease', '--spring']);

let failed = 0;
const report = [];
for (const { sel, name } of BLOCKS) {
  const t = tokens(sel);
  const resolve = v => {
    const seen = new Set();
    let out = v;
    while (/^var\(/.test(out)) {
      const key = out.slice(4).replace(/\).*$/, '').trim();
      if (seen.has(key)) throw new Error(`circular var ${key}`);
      seen.add(key);
      out = t[key] ?? '';
    }
    return out;
  };
  for (const [fg, bg, min] of PAIRS) {
    const f = parse(resolve(t['--' + fg] ?? ''));
    const b = parse(resolve(t['--' + bg] ?? ''));
    if (!f || !b) { report.push(`  ??   ${name}: ${fg} on ${bg} — token missing or not a colour`); failed++; continue; }
    const r = ratio(f, b);
    const ok = r >= min;
    if (!ok) failed++;
    report.push(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(7)} ${fg.padEnd(16)} on ${bg.padEnd(10)} ${r.toFixed(2)}  (needs ${min})`);
  }
}

// --- the three blocks must stay in step ------------------------------------------
// The OS-dark block is a copy of the dark one; a token added to only one of them is a
// half-themed app for whoever never picked a theme.
const colourKeys = sel => new Set(Object.keys(tokens(sel)).filter(k => !NOT_COLOUR.has(k)));
const keys = BLOCKS.map(b => ({ name: b.name, set: colourKeys(b.sel) }));
for (let i = 1; i < keys.length; i++) {
  const [a, b] = [keys[0], keys[i]];
  const missing = [...b.set].filter(k => !a.set.has(k));
  const extra = [...a.set].filter(k => !b.set.has(k));
  if (missing.length || extra.length) {
    failed++;
    report.push(`  FAIL  ${a.name} vs ${b.name}: only in ${b.name} → ${missing.join(', ') || '-'}; only in ${a.name} → ${extra.join(', ') || '-'}`);
  }
}

// --- every declared token must be referenced --------------------------------------
// A theme edit that leaves an orphan behind is a token nobody can trust: it reads as a
// knob, and turning it does nothing.
const usage = css.replace(/^\s*--[a-z0-9-]+:.*$/gm, '')
  + ['app.ts', 'index.html'].map(f => readFileSync(join(HERE, '..', f), 'utf8')).join('\n');
const declared = [...blockBody(BLOCKS[0].sel).matchAll(/^\s*(--[a-z0-9-]+):/gm)].map(m => m[1]);
const dead = declared.filter(t => !usage.includes(`var(${t})`));
if (dead.length) {
  failed++;
  report.push(`  FAIL  declared but never used: ${dead.join(', ')}`);
}

console.log(report.join('\n'));
console.log(failed ? `\n${failed} failed` : `\nall ${BLOCKS.length * PAIRS.length} contrast pairs pass, ${declared.length} tokens all referenced`);
process.exit(failed ? 1 : 0);
