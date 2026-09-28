// The shared mutable state and its setters. Every other module reads these as
// live bindings and writes them through the setters — an ES module can read an
// imported binding but never assign to it.
import { $ } from './ui.js';
import { stripMarker } from './fields.js';
import type { Tool, SimpleValues, ModelCaps, Connection } from './fields.js';

export let doc: Record<string, unknown> = {};   // the whole selected file
export let filePath = '';
export let baseMtimeMs = 0;
export let home = '';                            // for shortening paths to ~
export let dirty = false;
// One layout, two states: the picker alone, or the rail plus the editor.
export let opened = false;

// Claude Code is the default and the only tool whose file is parsed as a document.
export let tool: Tool = { id: 'claude', name: 'Claude Code', mode: 'env' };
export let tools: Tool[] = [tool];

// The field that opened the picker: the dialog writes there and nowhere else.
export let targetKey = '';

// The simple-mode draft, held outside the DOM so a re-render cannot lose it.
export let values: SimpleValues = {};

// `loaded` is the full list from the endpoint; the rest only narrows it in the view.
export let models: string[] = [];
export let caps: Record<string, ModelCaps> = {};   // id -> what the endpoint reported about it
export let loaded = false;
export let filter = '';
export let only1m = false;
export let onlyVision = false;
export let modelError = '';                      // '' | the endpoint's reason | a fetch failure
export let modelsUrl = '';                       // the URL the list came from, for the note
export let loadedFor = '';                       // base URL + token the list was read with

export let conns: Connection[] = [];     // the working copy the dialog edits
export let connsLoaded = false;          // a reply has arrived at least once
export let connsDirty = false;           // the working copy differs from the file
export let connsError = '';              // the server's sentence, when a call failed
export let connsAtRest = false;          // whether the server encrypts the token
export let connsFile = '';               // where the store lives, for the note

// Case folding follows the platform: Linux paths are case-sensitive.
export let platform = '';

// The setters below are the only way the rest of the app reassigns state.
export const setDoc = (v: Record<string, unknown>) => { doc = v; };
export const setFilePath = (v: string) => { filePath = v; };
export const setBaseMtimeMs = (v: number) => { baseMtimeMs = v; };
export const setHome = (v: string) => { home = v; };
export const setPlatform = (v: string) => { platform = v; };
export const setDirty = (v: boolean) => { dirty = v; };
export const setOpened = (v: boolean) => { opened = v; };
export const setTool = (v: Tool) => { tool = v; };
export const setTools = (v: Tool[]) => { tools = v; };
export const setTargetKey = (v: string) => { targetKey = v; };
export const setValues = (v: SimpleValues) => { values = v; };
export const setModels = (v: string[]) => { models = v; };
export const setCaps = (v: Record<string, ModelCaps>) => { caps = v; };
export const setLoaded = (v: boolean) => { loaded = v; };
export const setFilter = (v: string) => { filter = v; };
export const setOnly1m = (v: boolean) => { only1m = v; };
export const setOnlyVision = (v: boolean) => { onlyVision = v; };
export const setModelError = (v: string) => { modelError = v; };
export const setModelsUrl = (v: string) => { modelsUrl = v; };
export const setLoadedFor = (v: string) => { loadedFor = v; };
export const setConns = (v: Connection[]) => { conns = v; };
export const setConnsLoaded = (v: boolean) => { connsLoaded = v; };
export const setConnsDirty = (v: boolean) => { connsDirty = v; };
export const setConnsError = (v: string) => { connsError = v; };
export const setConnsAtRest = (v: boolean) => { connsAtRest = v; };
export const setConnsFile = (v: string) => { connsFile = v; };

// The form keys that hold the endpoint, per mode. Claude Code names them
// ANTHROPIC_*, the other three are patched through baseUrl/apiKey/model.
export const connKeys = (): { base: string; key: string; model: string } => (tool.mode === 'simple'
  ? { base: 'baseUrl', key: 'apiKey', model: 'model' }
  : { base: 'ANTHROPIC_BASE_URL', key: 'ANTHROPIC_AUTH_TOKEN', model: 'ANTHROPIC_MODEL' });

// One seam for both modes: the field cards and the model picker read and write
// through here, so neither has to know which kind of tool it is looking at.
export const env = (): Record<string, string> => {
  if (tool.mode === 'simple') return values;
  const e = doc.env;
  return e && typeof e === 'object' && !Array.isArray(e) ? (e as Record<string, string>) : {};
};

function markDirty(): void {
  dirty = true;
  $('actionbar-dot').classList.add('actionbar__dot--dirty');
  ($('save') as HTMLButtonElement).disabled = false;
}

export function setEnv(key: string, value: string): void {
  if (tool.mode === 'simple') {
    values[key] = value;
    markDirty();
    return;
  }
  if (!doc.env || typeof doc.env !== 'object' || Array.isArray(doc.env)) doc.env = {};
  const e = doc.env as Record<string, string>;
  if (value === '') delete e[key]; else e[key] = value;
  markDirty();
}

// Does this saved endpoint describe what the form holds right now? Derived, never
// stored: a stored flag would go stale the moment the form is edited by hand.
export function connMatches(c: Connection): boolean {
  const k = connKeys();
  const e = env();
  const url = (c.baseUrl || '').trim();
  if (!url || url !== (e[k.base] || '').trim()) return false;
  const m = (c.model || '').trim();
  return !m || stripMarker(m) === stripMarker(e[k.model] || '');
}

const foldCase = (s: string): string =>
  platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;

// ~/.claude/settings.json reads better than the full path; the exact one stays in
// the title. Only a leading home dir is shortened.
export function prettyPath(p: string): string {
  if (!home) return p;
  const strip = (s: string) => s.replace(/[\\/]+$/, '');
  if (foldCase(strip(p)) === foldCase(strip(home))) return '~';
  const sep = p.slice(home.length, home.length + 1);
  if (sep !== '\\' && sep !== '/') return p;
  if (foldCase(p.slice(0, home.length)) !== foldCase(home)) return p;
  return '~' + p.slice(home.length);
}
