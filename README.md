# CONFIG READER

Local web editor for pointing AI coding tools at your own endpoint. Pick a tool, scan for its config file, edit the connection values in a form — no hand-editing JSON/TOML/YAML.

Zero npm dependencies. Node stdlib only. No build step.

## Features

- **Tool picker + Scan** — finds the config file server-side, never trusts a path from the browser.
- **Full `env` editor for Claude Code** — 9 known fields (connection, models, runtime) grouped as cards, plus an "Other variables" section so unknown keys stay visible and survive round-trips.
- **Simple mode for 3 more tools** — same 3 fields (Base URL, Auth token, Model) patched into each tool's native format via text surgery; everything else in the file stays byte-identical.
- **Models tab** — fetches `<base>/v1/models` server-side, filterable list (text, 1M-only, Vision-only), one-click assign to any model variable. Cards carry `1M` / `vision` / `no vision` badges from the endpoint's own capability report (absent signal = no badge, never guessed). Handles Claude Code's trailing `[1m]` 1M-context marker automatically.
- **Dark / light theme** — follows OS, toggle persisted in `localStorage`, painted pre-CSS (no light flash).
- **Safe saves** — atomic write (tmp + rename), 5 rotating backups, stale-write guard (409 on `mtime` mismatch), per-file EOL preserved, no-op saves skip backups.
- **Localhost-hardened** — binds `127.0.0.1` only, `Origin` check on every write endpoint, 5 MB body cap, secrets never logged, API token never sent to the browser.

## Supported tools

| Tool | Mode | File edited | What gets written |
|------|------|-------------|-------------------|
| Claude Code | `env` | `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR` wins) | `env` object only; rest of document round-trips untouched |
| Codex | `simple` | `~/.codex/config.toml` | `model`, `model_provider`, `[model_providers.9router]` block |
| OpenCode | `simple` | `~/.config/opencode/opencode.json` | `provider.9router` entry + namespaced `model` |
| Hermes Agent | `simple` | `~/.hermes/config.yaml` + `~/.hermes/.env` | top-level `model:` block; key upserted as `OPENAI_API_KEY` in `.env` |

All non-Claude tools are pointed at the `9router` provider id so an existing 9Router install is edited in place, not duplicated.

## Requirements

- **Node.js 22+** (uses `node:module` `stripTypeScriptTypes`, global `fetch`, `AbortSignal.timeout`).
- No `npm install`. No `package.json`. Clone and run.
- Windows, macOS, or Linux. Desktop shortcut installer covers Windows (`.lnk`) and Linux (`.desktop`); macOS gets the `launch.vbs`-equivalent note (needs an `.app` bundle — not written).

## Quick start

```sh
node server.js --open
# opens http://127.0.0.1:8787, edits ~/.claude/settings.json
```

Windows double-click path:

```cmd
start.cmd            :: open the editor in the browser
start.cmd --shortcut :: put a desktop icon (run once)
```

Then: **Pick a tool → check the path → Scan → edit → Save.**

## CLI

```
node server.js [--port 8787] [--open] [--selftest] [--shortcut] [--name NAME] [--dir DIR]
```

| Flag | Effect |
|------|--------|
| `--port N` | Listen port (default `8787`). |
| `--open` | If already running on that port, just open the browser instead of dying with `EADDRINUSE`. Otherwise start + open. |
| `--selftest` | Run the built-in checks (round-trip, backups, path composition, `/v1/models` URL logic, launcher quoting, simple-mode formats) and exit. |
| `--shortcut` | Write the double-click launcher and exit. `--name` renames the shortcut, `--dir` places it anywhere (relative paths resolve against the editor folder, e.g. the public desktop or a USB stick). |
| `CLAUDE_CONFIG_DIR` env | Overrides `~/.claude` entirely (Claude Code's own rule). Honoured by scan, read, write, and selftest. |

## Usage notes

- **Environment pane (Claude Code):** emptying a field deletes the key from `env`. Unknown keys appear under "Other variables" with add support — nothing is silently dropped.
- **Models pane:** set Base URL on the Connection card first, then **Load models**. The fetch runs server-side (CORS-safe, token stays out of the page). Assign writes into whichever target the dropdown names; a model advertising a ≥1M context window gets the `[1m]` suffix, anything else has it stripped.
- **Simple-mode secrets:** Hermes reads its key from `.env`, so the form hands the field back empty on load — empty means "leave the stored key alone", not "erase it".
- **Broken files:** invalid JSON is a supported state — the UI shows the raw text and the parse error instead of crashing.
- **Backups:** `<config-dir>/backups/settings.json.backup.<timestamp>`, last 5 kept. Same scheme beside each simple-mode file.

## API

All paths are derived server-side; the browser names a **tool**, never a file.

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/` | `index.html` |
| `GET` | `/app.js` | `app.ts` with types stripped on the fly (cached by mtime) |
| `GET` | `/styles.css` | Stylesheet, read per request (edit → reload, no restart) |
| `GET` | `/icon/:id.png` | Per-tool icon, id checked against the registry |
| `GET` | `/api/tools` | Tool registry |
| `POST` | `/api/scan` | `{ tool }` → `{ found, file, … }` |
| `GET` | `/api/settings?tool=` | Full document (`env` mode) or `{ values }` (`simple` mode). Defaults to `claude`. |
| `POST` | `/api/settings` | `env` mode: `{ tool, doc, baseMtimeMs }`. `simple` mode: `{ tool, values }`. Returns `{ ok, bytes, mtimeMs, backup }`. |
| `POST` | `/api/models` | `{ baseUrl, apiKey }` (unsaved draft) → `{ url, models, windows }` or `{ error }`. Token used server-side only. |

Error contract: `400` bad input, `403` bad `Origin`, `409` stale write (file changed since load — reload, don't force), `413` body > 5 MB, `502` model-list fetch failed (with `ECONNREFUSED`/`ENOTFOUND`/status detail).

## Project structure

```
server.js            # HTTP server, all read/write logic, selftest, shortcut installer. Node stdlib only.
app.ts               # Frontend (single source; served as /app.js via type-stripping, no tsc).
index.html           # Landing (tool picker + Scan) + editor (action bar, env pane, models pane).
styles.css           # All styling, light/dark via CSS vars + data-theme.
icons/               # One PNG per tool id (claude, codex, opencode, hermes).
start.cmd            # Windows entry point: open, or --shortcut to install the desktop icon.
launch.vbs           # Generated launcher: starts node hidden, opens the browser (ASCII-only for wscript).
catalog.json         # Generated settings-key catalog (dev artifact, not used at runtime).
tools/
  build-catalog.mjs  # Regenerates catalog.json from docs settings-reference + schemastore.
  check-save.mjs     # End-to-end save-path exercise against a scratch config dir.
  check-ui.mjs       # DOM-shim contract test for both screens.
  shot.mjs           # Screenshots via Chrome DevTools Protocol (zero deps, needs any Chromium).
  shots/             # Reference screenshots used above.
```

## Development

```sh
node server.js --selftest   # fast logic checks, no browser needed
node tools/check-save.mjs   # boots a scratch server, never touches ~/.claude
node tools/check-ui.mjs     # landing → form contract via DOM shim
node tools/build-catalog.mjs # regenerates catalog.json (needs network: docs + schemastore)
OUT=./tools/shots node tools/shot.mjs [http://127.0.0.1:8787]  # screenshots (needs CHROME or Playwright Chromium)
```

Known trade-off (`ponytail:` simple-mode parsers are narrow text surgery, not full TOML/YAML/JSONC parsers — exotic hand-written configs may read a value as empty but are never clobbered; empty fields are not written. Upgrade path: add a real parser per format when the first miss is reported).

## Security model

- Binds `127.0.0.1`; write endpoints require a matching `Origin`.
- No file path ever arrives from the client — `toolPaths()` is server-side, unknown tool ids are refused.
- `http(s)` only for Base URL and model-list fetch; `file://`/`ftp://` rejected.
- File contents and tokens never logged; console lines name the file and byte count only.

## Contributing

Issues and PRs welcome. Keep it dependency-free: stdlib only, no build step, smallest diff that holds. Run `--selftest` + `check-save` + `check-ui` before opening a PR.

## License

MIT — see `LICENSE`.
