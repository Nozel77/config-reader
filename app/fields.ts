// Types and field definitions. No imports: everything here is data and pure
// helpers, so every other module can depend on it without a cycle.
// Imports name the served URL (/app/x.js); the source is app/x.ts.

export interface Field {
  key: string;
  label: string;
  hint: string;
  kind: 'text' | 'number' | 'secret';
  group: 'connection' | 'models' | 'runtime' | 'roles';
  placeholder?: string;
}

export interface ModelsResponse {
  url?: string;
  models?: string[] | null;
  caps?: Record<string, ModelCaps>;
  error?: string;
}

// What one endpoint said about one model. `caps` is passed through from the endpoint,
// so its keys are that gateway's vocabulary and not a list this page keeps. `meta` is
// what this page derived for the display: a human name, free, sunset, and the two
// list-valued facts that go in the tooltip.
export interface ModelMeta {
  name?: string;
  description?: string;
  free?: boolean;
  sunset?: string;
  efforts?: string[];
  endpoints?: string[];
}

export interface ModelCaps {
  provider?: string;
  ctx?: number;
  maxOut?: number;
  caps?: Record<string, unknown>;
  meta?: ModelMeta;
}

export interface Tool {
  id: string;
  name: string;
  mode: 'env' | 'simple';
  bin?: string;                             // the CLI name, for the installed badge's tooltip
  // Whether the CLI is on PATH. Undefined on the local fallback, which is a guess.
  installed?: boolean;
}

export interface ScanResponse {
  tool: string;
  found: boolean;
  file: string;
  configDir: string;
  home: string;
  platform: string;
  tools?: Tool[];
}

export interface SettingsResponse {
  selected: string | null;
  tool?: string;
  file?: string;
  exists?: boolean;
  raw?: string;
  parsed?: Record<string, unknown> | null;
  eol?: string;
  mtimeMs?: number;
  normalized?: boolean;
  parseError?: string | null;
  parseHint?: string | null;
  values?: SimpleValues;
}

// The values every non-Claude tool is edited through. The server patches them into
// that tool's own config format; which keys exist depends on the tool (see SIMPLE_FIELDS).
export type SimpleValues = Record<string, string>;

// A saved endpoint: the three values every tool asks for, typed once. `hasKey` is
// what the server said — the token itself is fetched per row, on Apply, and never
// rides the list reply. `apiKey` only exists on a row while it is being typed.
export interface Connection { name: string; baseUrl: string; model: string; hasKey?: boolean; apiKey?: string }
export interface ConnectionsResponse {
  file?: string; exists?: boolean; atRest?: boolean;
  profiles?: Connection[]; error?: string;
}

// Grouped in setup order: where requests go, which model answers, then the knobs.
export const GROUPS: Record<Field['group'], string> = {
  connection: 'Connection',
  models: 'Models',
  runtime: 'Runtime',
  roles: 'Model roles (optional)',
};
export const GROUP_ORDER: Field['group'][] = ['connection', 'models', 'runtime', 'roles'];

export const FIELDS: Field[] = [
  { key: 'ANTHROPIC_BASE_URL', label: 'Base URL', kind: 'text', group: 'connection',
    placeholder: 'http://localhost:20128/v1',
    hint: 'Where Claude Code sends its requests. Leave empty for the default Anthropic API.' },
  { key: 'ANTHROPIC_AUTH_TOKEN', label: 'Auth token', kind: 'secret', group: 'connection',
    placeholder: 'paste the token',
    hint: 'Bearer token for that endpoint. Stored as plain text in settings.json.' },
  { key: 'ANTHROPIC_MODEL', label: 'Model', kind: 'text', group: 'models',
    placeholder: 'provider/model-id',
    hint: 'The model every request uses, unless a more specific one below applies.' },
  { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', label: 'Opus model', kind: 'text', group: 'models',
    placeholder: 'provider/model-id',
    hint: 'Answers requests that ask for Opus.' },
  { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', label: 'Sonnet model', kind: 'text', group: 'models',
    placeholder: 'provider/model-id',
    hint: 'Answers requests that ask for Sonnet.' },
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', label: 'Haiku model', kind: 'text', group: 'models',
    placeholder: 'provider/model-id',
    hint: 'Handles the small background calls: titles, summaries, quick checks.' },
  { key: 'ANTHROPIC_DEFAULT_FABLE_MODEL', label: 'Fable model', kind: 'text', group: 'models',
    placeholder: 'provider/model-id',
    hint: 'Answers requests that ask for Fable.' },
  { key: 'API_TIMEOUT_MS', label: 'API timeout', kind: 'number', group: 'runtime',
    placeholder: '3000000', hint: 'How long one request may take, in milliseconds. 3000000 is 50 minutes.' },
  { key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', label: 'Auto-compact window', kind: 'number', group: 'runtime',
    placeholder: '498000',
    hint: 'The token count that triggers auto-compact. 198000 is a 200K window, 498000 is 500K; empty lets Claude Code derive it from the model.' },
  { key: 'CLAUDE_CODE_AUTO_MODE_SERVER', label: 'Auto mode server', kind: 'text', group: 'runtime',
    placeholder: '0', hint: 'Set to 0 to turn the auto-mode server off.' },
];

export const KNOWN: Set<string> = new Set(FIELDS.map(f => f.key));

// One field set per tool: the three shared values, plus the model slots that tool has
// grown — Codex and OpenCode each spawn a subagent, Hermes reads a model per role.
const CONNECTION_FIELDS: Field[] = [
  { key: 'baseUrl', label: 'Base URL', kind: 'text', group: 'connection',
    placeholder: 'http://localhost:20128/v1',
    hint: 'Where this tool sends its requests. The /v1 suffix is added for you.' },
  { key: 'apiKey', label: 'Auth token', kind: 'secret', group: 'connection',
    placeholder: 'paste the token',
    hint: 'Bearer token for that endpoint. Stored as plain text in the tool\'s own config.' },
];
const SUBAGENT_FIELD: Field = {
  key: 'subagentModel', label: 'Subagent model', kind: 'text', group: 'models',
  placeholder: 'provider/model-id',
  hint: 'The model spawned agents use. Empty leaves the subagent setting as it is.',
};

// The model slots Hermes reads besides its default: `delegation` is its own top-level
// block, the rest are keys under `auxiliary:`. The list is 9router's.
const HERMES_ROLES: { id: string; label: string }[] = [
  { id: 'delegation', label: 'Delegation (subagents)' },
  { id: 'vision', label: 'Vision' },
  { id: 'web_extract', label: 'Web Extract' },
  { id: 'compression', label: 'Compression' },
  { id: 'title_generation', label: 'Title Generation' },
  { id: 'approval', label: 'Approval' },
  { id: 'skills_hub', label: 'Skills Hub' },
  { id: 'mcp', label: 'MCP' },
  { id: 'memory_query_rewrite', label: 'Memory Query Rewrite' },
  { id: 'background_review', label: 'Background Review' },
  { id: 'curator', label: 'Curator' },
  { id: 'monitor', label: 'Monitor' },
];

const SIMPLE_FIELDS: Record<string, Field[]> = {
  codex: [
    ...CONNECTION_FIELDS,
    { key: 'model', label: 'Model', kind: 'text', group: 'models',
      hint: 'The model this tool asks for by default.' },
    SUBAGENT_FIELD,
  ],
  opencode: [
    ...CONNECTION_FIELDS,
    { key: 'model', label: 'Model', kind: 'text', group: 'models',
      hint: 'The model this tool asks for by default. Every model saved here stays in the provider\'s list.' },
    SUBAGENT_FIELD,
  ],
  hermes: [
    ...CONNECTION_FIELDS,
    { key: 'model', label: 'Default model', kind: 'text', group: 'models',
      hint: 'The model Hermes asks for by default.' },
    ...HERMES_ROLES.map((r): Field => ({
      key: r.id, label: r.label, kind: 'text', group: 'roles',
      placeholder: 'inherit default',
      hint: 'The model this role uses. Empty leaves the role as it is in the file.',
    })),
  ],
};

// Claude Code reads a trailing [1m] as "this model has a 1M window"; without it it
// assumes 200K. The suffix must be last, so an existing marker is stripped first.
export const CONTEXT_MARKER = /\[1m\]$/i;
export const WINDOW_1M = 1_000_000;

export const stripMarker = (id: string): string => id.replace(CONTEXT_MARKER, '').trim();

// Fields that name a model get the picker button, derived rather than listed twice.
const ALL_FIELDS: Field[] = [...FIELDS, ...Object.values(SIMPLE_FIELDS).flat()];
export const MODEL_KEYS: Set<string> = new Set(
  ALL_FIELDS.filter(f => f.group === 'models' || f.group === 'roles').map(f => f.key));

export const fieldOf = (key: string): Field | undefined => ALL_FIELDS.find(f => f.key === key);

// The field set for one tool: Claude Code owns its whole settings file, the other
// three are patched into their own formats.
export const fieldsFor = (t: Tool): Field[] => (t.mode === 'simple' ? SIMPLE_FIELDS[t.id] || [] : FIELDS);
