// DOM helpers and the toast. No imports from other app modules: every module
// may use these without creating a cycle.

// Elements are found by their data-js hook, never by a CSS class, so renaming a
// class for styling can never break behaviour.
export const $ = (name: string): HTMLElement =>
  document.querySelector(`[data-js="${name}"]`) as HTMLElement;

// The two places that write into one card in place look it up by key, not by class.
export const fieldInput = (key: string): HTMLInputElement | null =>
  document.querySelector(`[data-field="${key}"]`) as HTMLInputElement | null;
export const cardOf = (key: string): HTMLElement | null =>
  document.querySelector(`[data-card="${key}"]`) as HTMLElement | null;

// Inline SVG glyphs (currentColor): no icon font and no CDN, so this works offline.
export const ICONS: Record<string, string> = {
  eye: '<path d="M1.5 8S3.7 3.8 8 3.8 14.5 8 14.5 8 12.3 12.2 8 12.2 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  eyeSlash: '<path d="M1.5 8S3.7 3.8 8 3.8c1.4 0 2.7.5 3.8 1.2M14.5 8S12.3 12.2 8 12.2c-1.4 0-2.7-.5-3.8-1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  trash: '<path d="M6 2h4v1.5h3V5H3V3.5h3V2zm-3.2 4h10.4l-.9 8.2a1 1 0 0 1-1 .8H4.7a1 1 0 0 1-1-.8L2.8 6z" fill="currentColor"/>',
  xmark: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  arrowUp: '<path d="M8 13V3.6M3.6 8L8 3.6 12.4 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13.6 2.4v2.9h-2.9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  moon: '<path d="M14 9.5A5.5 5.5 0 0 1 6.5 2 5.5 5.5 0 1 0 14 9.5z" fill="currentColor"/>',
  sun: '<circle cx="8" cy="8" r="3" fill="currentColor"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  power: '<path d="M8 2.5v5.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M11.7 4.4a5 5 0 1 1-7.4 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  // A test is one tiny request: a bolt, not a magnifier.
  bolt: '<path d="M9.5 1L3 9h3.5L6 15l7-8H9.5z" fill="currentColor"/>',
  // The model picker opens a list to choose from.
  list: '<path d="M6 4h7M6 8h7M6 12h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="3" cy="4" r="1" fill="currentColor"/><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="3" cy="12" r="1" fill="currentColor"/>',
  // Capability glyphs. Anything the endpoint reports that has no glyph here still
  // renders, with a dot and its own key as the label.
  doc: '<path d="M4 1.5h5l3 3v10H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  wave: '<path d="M2 8h1.5M5 4.5v7M8 2.5v11M11 5.5v5M14 7.5h-1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>',
  speaker: '<path d="M3 6h2.5L9 3v10L5.5 10H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M11.5 6a3 3 0 0 1 0 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  film: '<rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 3.5v9M10 3.5v9" stroke="currentColor" stroke-width="1.4"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.8" cy="6.4" r="1.2" fill="currentColor"/><path d="M3 11.5l3.5-3 2.5 2.2L11 8.5l2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  globe: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.4 8h11.2M8 2.4c1.6 1.7 2.4 3.6 2.4 5.6S9.6 12.9 8 13.6C6.4 12.9 5.6 11 5.6 8s.8-3.9 2.4-5.6z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  wrench: '<path d="M10.6 2.4a3.6 3.6 0 0 1-4.4 4.6l-3.2 3.2a1.6 1.6 0 1 0 2.2 2.2l3.2-3.2a3.6 3.6 0 0 1 4.6-4.4L11 6.4l1.4 1.4 1.6-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  brain: '<path d="M6.5 2.5a2.5 2.5 0 0 0-2.5 2.5 2.2 2.2 0 0 0-1 4 2.4 2.4 0 0 0 1.6 3.6 2.4 2.4 0 0 0 4.4-1V4a1.5 1.5 0 0 0-2.5-1.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 4.6a2 2 0 0 1 2.4 1.9 2.2 2.2 0 0 1 .7 4.2 2.2 2.2 0 0 1-3.1 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  dot: '<circle cx="8" cy="8" r="2.6" fill="currentColor"/>',
  // Thinking, as the three facts a gateway reports separately. A toggle switch for
  // "this can be turned off", level sliders for "the effort is settable".
  toggle: '<rect x="1.6" y="5" width="12.8" height="6" rx="3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.2" cy="8" r="1.9" fill="currentColor"/>',
  sliders: '<path d="M2.5 5h11M2.5 11h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="5" r="1.7" fill="currentColor"/><circle cx="10.5" cy="11" r="1.7" fill="currentColor"/>',
};

// Capability keys whose auto-humanized name reads badly. Everything else falls back to
// humanize(), so a key nobody anticipated still gets a label.
export const CAP_LABELS: Record<string, string> = {
  thinkingCanDisable: 'Thinking can be turned off',
  thinkingEffortSupported: 'Reasoning effort is settable',
};

// Capability key -> glyph. The key list belongs to the endpoint, so this only names
// the ones worth a picture; everything else falls back to a dot and its own label.
export const CAP_ICONS: Record<string, string> = {
  vision: 'eye', pdf: 'doc', audioInput: 'wave', audioOutput: 'speaker',
  videoInput: 'film', imageOutput: 'image', search: 'globe', tools: 'wrench',
  reasoning: 'brain',
  // Thinking is reported as three separate facts by some gateways: that it exists
  // (reasoning), that it can be turned off, and that the effort level is settable.
  thinkingCanDisable: 'toggle',
  thinkingEffortSupported: 'sliders',
};

// "audioInput" -> "Audio input", "pdf" -> "Pdf".
export const humanize = (k: string): string => {
  const s = k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function icon(name: string): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const doc = document as unknown as Document & { createElementNS?: (ns: string, tag: string) => Element };
  const s = (typeof doc.createElementNS === 'function' ? doc.createElementNS(NS, 'svg') : document.createElement('svg')) as unknown as HTMLElement;
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'icon');
  (s as unknown as { innerHTML: string }).innerHTML = ICONS[name];
  return s;
}

export function el(tag: string, props: Record<string, unknown> = {}, ...kids: unknown[]): HTMLElement {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v as string;
    else if (k === 'text') n.textContent = v as string;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v as EventListener);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid as Node);
  return n;
}

// A click that lands outside the panel closes it. Anything inside the panel is not a
// dismissal, and a keyboard or synthetic click carries no coordinates at all — so the
// target is what decides, and the box only separates the dialog's own padding from the
// backdrop behind it. One handler, both dialogs.
export function outsideClick(hookName: string, close: () => void): (e: MouseEvent) => void {
  return (e: MouseEvent) => {
    const dlg = $(hookName);
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right
      && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) close();
  };
}

// A popover, not a z-index: a modal <dialog> lives in the top layer, where no z-index
// reaches. A popover lives there too — but showing it once is not enough. The dialog
// that opens later is inserted after it in the top layer and paints over it, so every
// toast re-promotes itself. hidePopover() on an open popover is a no-op, not an error,
// which is why the pair can run unconditionally.
type Popover = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
const toastEl = (): Popover => $('toast') as Popover;

let toastTimer = 0;

// The result is the colour: green when it worked, red when it did not.
export function toast(msg: string, kind: 'ok' | 'error' = 'ok'): void {
  const t = toastEl();
  t.textContent = msg;
  t.classList.remove('toast--ok', 'toast--error');
  t.classList.add(`toast--${kind}`);
  // Re-promote: without this the second toast of a session paints behind the picker.
  try { t.hidePopover?.(); } catch { /* not open */ }
  try { t.showPopover?.(); } catch { /* unsupported */ }
  t.classList.add('toast--shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('toast--shown'), 2600);
}

export function hideToast(): void {
  clearTimeout(toastTimer);
  const t = toastEl();
  t.classList.remove('toast--shown');
  t.textContent = '';
  try { t.hidePopover?.(); } catch { /* already closed */ }
}

// A shared confirmation dialog for the actions that lose something: unsaved edits,
// a running server, a form about to be replaced. Resolves true only when the
// confirm button is clicked — Escape and a backdrop click resolve false, the safe
// answer. The close listener is attached before showModal(), so an answer that
// arrives synchronously (the check-ui shim, an auto-answering test) is caught too.
let confirmWired = false;

export function confirmDialog(o: { title: string; message: string; confirmLabel: string; cancelLabel?: string }): Promise<boolean> {
  const dlg = $('confirm') as unknown as HTMLDialogElement;
  if (!confirmWired) {
    confirmWired = true;
    ($('confirm-cancel') as HTMLButtonElement).addEventListener('click', () => dlg.close('cancel'));
    ($('confirm-ok') as HTMLButtonElement).addEventListener('click', () => dlg.close('confirm'));
    // A click on the backdrop cancels, like the picker and the connections dialog.
    dlg.addEventListener('click', (e: MouseEvent) => {
      if (e.target === (dlg as unknown as EventTarget)) dlg.close('cancel');
    });
  }
  ($('confirm-title') as HTMLElement).textContent = o.title;
  ($('confirm-message') as HTMLElement).textContent = o.message;
  ($('confirm-cancel') as HTMLElement).textContent = o.cancelLabel || 'Cancel';
  const ok = $('confirm-ok') as HTMLButtonElement;
  ok.textContent = o.confirmLabel;
  dlg.returnValue = '';
  const answer = new Promise<boolean>(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true });
  });
  dlg.showModal();
  ok.focus();
  return answer;
}
