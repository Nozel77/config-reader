// The theme: a stored choice wins, with none the CSS follows the OS.
import { $, icon } from './ui.js';

// Guarded for the check-ui shim, where localStorage and matchMedia do not exist.
function storedTheme(): 'light' | 'dark' | null {
  try {
    const t = typeof localStorage !== 'undefined' ? localStorage.getItem('theme') : null;
    return t === 'light' || t === 'dark' ? t : null;
  } catch { return null; }
}

function osTheme(): 'light' | 'dark' {
  try {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch { /* no media query here */ }
  return 'light';
}

function currentTheme(): 'light' | 'dark' {
  const root = (document as unknown as { documentElement?: HTMLElement }).documentElement;
  try {
    const attr = root ? root.getAttribute('data-theme') : null;
    if (attr === 'light' || attr === 'dark') return attr;
  } catch { /* shim without attributes */ }
  return storedTheme() || osTheme();
}

function syncThemeButton(t: 'light' | 'dark'): void {
  const btn = document.querySelector('[data-js="theme-toggle"]') as HTMLElement | null;
  if (!btn) return;
  const dark = t === 'dark';
  // Swap the glyph only: the button also carries its label span.
  const glyph = btn.querySelector('.icon');
  const next = icon(dark ? 'sun' : 'moon');
  if (glyph) glyph.replaceWith(next); else btn.prepend(next);
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function paintTheme(t: 'light' | 'dark'): void {
  const root = (document as unknown as { documentElement?: HTMLElement }).documentElement;
  if (root) {
    try { root.setAttribute('data-theme', t); } catch { /* shim */ }
  }
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem('theme', t);
  } catch { /* private mode */ }
  syncThemeButton(t);
}

export function initTheme(): void {
  syncThemeButton(currentTheme());
  $('theme-toggle').addEventListener('click', () => {
    paintTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  // With no manual choice, keep the icon in step when the OS flips.
  try {
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', () => {
      if (!storedTheme()) syncThemeButton(osTheme());
    });
  } catch { /* older browsers */ }
}
