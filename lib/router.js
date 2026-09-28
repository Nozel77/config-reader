// Extracted from server.js — every HTTP route. The browser names a tool, never a
// path; all filesystem paths are derived here or in lib/paths.js.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, INDEX, ICONS, connectionsFile } = require('./paths.js');
const { send, originOk, jsonBody, appJs, appModule } = require('./http.js');
const { modelsUrl, chatUrl } = require('./upstream.js');
const { modelCaps } = require('./model-caps.js');
const { str } = require('./util.js');
const { readText, backupBeforeWrite, atomicWrite } = require('./fs-safe.js');
const { toolById, toolList, toolPaths, scanInfo, readSimple, writeSimple } = require('./tools/index.js');
const { readSettings } = require('./tools/claude.js');
const { CONNECTIONS_MAX, cleanConnection, readConnections, writeConnections } = require('./connections.js');
const { protectSecret, revealSecret, secretsAtRest } = require('./secrets.js');

async function handler(req, res, port) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && p === '/app.js') {
    return send(res, 200, appJs(), 'text/javascript; charset=utf-8');
  }
  // One frontend module: /app/x.js is app/x.ts with types stripped. The name is
  // flat and pattern-checked inside appModule(), so no path can traverse out.
  if (req.method === 'GET' && p.startsWith('/app/') && p.endsWith('.js')) {
    const js = appModule(p.slice('/app/'.length, -3));
    if (js === null) return send(res, 404, JSON.stringify({ error: 'no such module' }));
    return send(res, 200, js, 'text/javascript; charset=utf-8');
  }
  // One stylesheet, read per request so an edit shows on reload without a restart.
  if (req.method === 'GET' && p === '/styles.css') {
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'styles.css')), 'text/css; charset=utf-8');
  }
  // One icon per tool, named after the tool id. The set is fixed, so the id is
  // checked against the registry before it reaches the filesystem.
  if (req.method === 'GET' && p.startsWith('/icon/')) {
    const id = p.slice('/icon/'.length).replace(/\.png$/, '');
    const file = path.join(ICONS, `${id}.png`);
    if (!toolById(id) || !fs.existsSync(file)) return send(res, 404, JSON.stringify({ error: 'no icon' }));
    return send(res, 200, fs.readFileSync(file), 'image/png');
  }

  // What the Scan button calls. The browser names a tool, never a path — the file
  // is picked server-side, so there is nothing here to validate or traverse.
  if (req.method === 'POST' && p === '/api/scan') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const tool = toolById(typeof payload.tool === 'string' ? payload.tool : 'claude');
    if (!tool) return send(res, 400, JSON.stringify({ error: `unknown tool: ${payload.tool}` }));
    const info = { ...scanInfo(tool), tools: toolList() };
    console.log(info.found ? `scan found ${info.file}` : `scan found nothing at ${info.file}`);
    return send(res, 200, JSON.stringify(info));
  }

  // The tool list, for a page that wants to draw the picker before any scan. Gated
  // with the rest: it is the same shape of request, and one rule beats a per-route guess.
  if (req.method === 'GET' && p === '/api/tools') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    return send(res, 200, JSON.stringify({ tools: toolList() }));
  }

  // The saved endpoints. One file for every tool, path derived server-side. The list
  // reply carries no token at all: a key is handed out one row at a time, by name,
  // and only when Apply asks for it.
  if (req.method === 'GET' && p === '/api/connections') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const { exists, profiles } = readConnections();
    return send(res, 200, JSON.stringify({
      file: connectionsFile(), exists, atRest: secretsAtRest(),
      profiles: profiles.map(r => ({ name: r.name, baseUrl: r.baseUrl, model: r.model, hasKey: !!r.apiKey })),
    }));
  }

  if (req.method === 'POST' && p === '/api/connections') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const rows = Array.isArray(payload.profiles) ? payload.profiles : null;
    if (!rows) return send(res, 400, JSON.stringify({ error: 'profiles must be an array' }));
    if (rows.length > CONNECTIONS_MAX) {
      return send(res, 400, JSON.stringify({ error: `at most ${CONNECTIONS_MAX} connections` }));
    }
    // A row that arrives without a key keeps the one already stored under that name,
    // so editing a URL or a model never means retyping the token.
    const stored = new Map(readConnections().profiles.map(r => [r.name, r]));
    const out = [];
    for (const row of rows) {
      const clean = cleanConnection(row);
      if (!clean) {
        const said = str(row && row.name);
        return send(res, 400, JSON.stringify({ error: `a connection needs a name and an http(s) Base URL (got ${JSON.stringify(said)})` }));
      }
      if (out.some(r => r.name.toLowerCase() === clean.name.toLowerCase())) {
        return send(res, 400, JSON.stringify({ error: `two connections are named "${clean.name}"` }));
      }
      const typed = str(row.apiKey);
      const kept = stored.get(clean.name);
      const secret = typed ? protectSecret(typed)
        : kept && kept.apiKey ? { apiKey: kept.apiKey, enc: kept.enc }
        : { apiKey: '', enc: 'plain' };
      out.push({ ...clean, ...secret });
    }
    let doc;
    try { doc = writeConnections(out); } catch (e) {
      return send(res, 500, JSON.stringify({ error: `write failed: ${e.code || e.message}` }));
    }
    // Never the values — one of them is a live token.
    console.log(`wrote ${connectionsFile()} (${doc.profiles.length} connections)`);
    return send(res, 200, JSON.stringify({ ok: true, file: connectionsFile(), count: doc.profiles.length }));
  }

  // The token for one row, by name. Apply is the only caller.
  if (req.method === 'POST' && p === '/api/connections/reveal') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const name = str(payload.name);
    const row = readConnections().profiles.find(r => r.name === name);
    if (!row) return send(res, 404, JSON.stringify({ error: `no connection named "${name}"` }));
    const { apiKey, keyError } = revealSecret(row.enc, row.apiKey);
    if (keyError) return send(res, 409, JSON.stringify({ error: keyError }));
    return send(res, 200, JSON.stringify({ apiKey }));
  }

  // The settings of one tool. `?tool=` defaults to claude so an older page that
  // never learned about tools keeps working unchanged.
  if (req.method === 'GET' && p === '/api/settings') {
    // This reply carries env.ANTHROPIC_AUTH_TOKEN, so the read needs the same gate
    // as the write: a DNS-rebinding page reaches 127.0.0.1 with Host=evil.com and
    // would otherwise read the token straight out of the JSON.
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const tool = toolById(url.searchParams.get('tool') || 'claude');
    if (!tool) return send(res, 400, JSON.stringify({ error: 'unknown tool' }));
    const paths = toolPaths(tool.id);
    if (tool.mode === 'env') return send(res, 200, JSON.stringify({ ...readSettings(paths.file), selected: paths.file }));
    const s = readSimple(tool, paths);
    // stat separately: the file can vanish between the read and the stat.
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(paths.file).mtimeMs; } catch { /* raced deletion — exists:false stands */ }
    return send(res, 200, JSON.stringify({
      selected: paths.file, tool: tool.id, file: paths.file, values: s.values,
      exists: s.exists, mtimeMs, parseError: s.parseError,
    }));
  }

  // The model list is fetched server-side: the token must never travel to the
  // browser, and the endpoint may not send CORS headers. The URL and token come
  // from the request (the browser holds the unsaved draft), not from the file.
  if (req.method === 'POST' && p === '/api/models') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const base = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
    const token = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (!base) return send(res, 400, JSON.stringify({ error: 'Base URL is empty — set it on the Connection card first.' }));

    let url;
    try {
      url = modelsUrl(base);
    } catch {
      return send(res, 400, JSON.stringify({ error: `"${base}" is not a valid URL.` }));
    }
    // http(s) only: a file:// or ftp:// base must not turn this into a local read.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return send(res, 400, JSON.stringify({ error: `Base URL must be http or https, got ${url.protocol}` }));
    }

    const headers = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;

    let r, text;
    try {
      r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      text = await r.text();
    } catch (e) {
      // Node's fetch says only "fetch failed"; the cause carries the real reason
      // (ECONNREFUSED, ENOTFOUND, "bad port", cert error) and is what the user
      // needs to see. cause.code is absent for some of them, so fall back to its message.
      const c = e.cause || {};
      const why = e.name === 'TimeoutError' ? 'timed out after 15s'
        : (c.code || c.message) ? `${c.code ? `${c.code}: ` : ''}${c.message || ''}`.trim()
        : e.message;
      return send(res, 502, JSON.stringify({ error: `${url.href} — ${why}` }));
    }

    let body = null;
    try { body = JSON.parse(text); } catch { /* handled below */ }
    // The shape OpenAI, Anthropic and most gateways share. Anything else with no
    // `data` array is reported as "this endpoint has no model list", not as a crash.
    const rows = body && Array.isArray(body.data) ? body.data : null;
    if (!r.ok) {
      const detail = (body && (body.error?.message || body.error || body.message)) || text.slice(0, 300);
      return send(res, 502, JSON.stringify({ error: `${url.href} returned ${r.status}: ${detail}` }));
    }
    if (!rows) {
      return send(res, 200, JSON.stringify({ url: url.href, models: null,
        error: `${url.href} does not provide a model list (no "data" array in the response).` }));
    }
    const models = rows
      .map(m => (m && typeof m === 'object' ? (m.id || m.name || m.model) : m))
      .filter(m => typeof m === 'string' && m)
      .sort((a, b) => a.localeCompare(b));
    console.log(`models: ${models.length} from ${url.href}`);
    return send(res, 200, JSON.stringify({ url: url.href, models, caps: modelCaps(rows) }));
  }

  // Is this model actually answering? One tiny completion is the only honest test:
  // a model can be listed and still be down upstream. Nothing about the answer is
  // read, so a 200 is the whole signal.
  if (req.method === 'POST' && p === '/api/test-model') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    const payload = await jsonBody(req, res);
    if (!payload) return;
    const base = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
    const token = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    if (!base) return send(res, 400, JSON.stringify({ error: 'Base URL is empty.' }));
    if (!model) return send(res, 400, JSON.stringify({ error: 'No model to test.' }));

    let url;
    try { url = chatUrl(base); } catch { return send(res, 400, JSON.stringify({ error: `"${base}" is not a valid URL.` })); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return send(res, 400, JSON.stringify({ error: `Base URL must be http or https, got ${url.protocol}` }));
    }

    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const started = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false }),
        signal: AbortSignal.timeout(30000),
      });
      const text = await r.text();
      const ms = Date.now() - started;
      if (!r.ok) {
        let detail = text.slice(0, 300);
        try {
          const b = JSON.parse(text);
          detail = b?.error?.message || b?.error || b?.message || detail;
        } catch { /* not json */ }
        return send(res, 200, JSON.stringify({ ok: false, ms, error: `${r.status}: ${detail}` }));
      }
      return send(res, 200, JSON.stringify({ ok: true, ms }));
    } catch (e) {
      const c = e.cause || {};
      const why = e.name === 'TimeoutError' ? 'timed out after 30s'
        : (c.code || c.message) ? `${c.code ? `${c.code}: ` : ''}${c.message || ''}`.trim()
        : e.message;
      return send(res, 200, JSON.stringify({ ok: false, ms: Date.now() - started, error: why }));
    }
  }

  // The launcher opens a console window that is easy to forget. This is the switch
  // for it: answer first, then exit, so the browser gets the reply.
  if (req.method === 'POST' && p === '/api/shutdown') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));
    send(res, 200, JSON.stringify({ ok: true }));
    console.log('\n  stopped from the page.\n');
    setTimeout(() => process.exit(0), 200);
    return;
  }

  if (req.method === 'POST' && p === '/api/settings') {
    if (!originOk(req, port)) return send(res, 403, JSON.stringify({ error: 'bad origin' }));

    const payload = await jsonBody(req, res);
    if (!payload) return;

    const tool = toolById(typeof payload.tool === 'string' ? payload.tool : 'claude');
    if (!tool) return send(res, 400, JSON.stringify({ error: `unknown tool: ${payload.tool}` }));
    const paths = toolPaths(tool.id);
    const file = paths.file;

    // ---- simple mode: three values patched into a file this editor does not own.
    if (tool.mode === 'simple') {
      const v = payload.values;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return send(res, 400, JSON.stringify({ error: 'missing values' }));
      const values = {
        baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '',
        apiKey: typeof v.apiKey === 'string' ? v.apiKey.trim() : '',
        model: typeof v.model === 'string' ? v.model.trim() : '',
      };
      // A base URL with no scheme would be written into a config as a path. Caught
      // here rather than at the next CLI launch, where the error is a network one.
      if (!values.baseUrl) return send(res, 400, JSON.stringify({ error: 'Base URL is required.' }));
      let parsed;
      try { parsed = new URL(values.baseUrl); } catch {
        return send(res, 400, JSON.stringify({ error: `"${values.baseUrl}" is not a valid URL.` }));
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return send(res, 400, JSON.stringify({ error: `Base URL must be http or https, got ${parsed.protocol}` }));
      }
      if (!values.model) return send(res, 400, JSON.stringify({ error: 'Model is required.' }));

      // Stale-write guard, same as env mode: another writer may have touched the
      // file since load. Only the main file is guarded — the Hermes .env upsert
      // is append-only and low-risk.
      // The check runs whenever the client sent a mtime at all — 0 means "there was
      // no file when I loaded", which is exactly the case that must not silently
      // overwrite a file another writer created in the meantime.
      const before = readText(file);
      if (before !== null && Number.isFinite(payload.baseMtimeMs)) {
        try {
          const m = fs.statSync(file).mtimeMs;
          if (Math.abs(m - payload.baseMtimeMs) > 1) {
            return send(res, 409, JSON.stringify({ error: 'file changed on disk since you loaded it', mtimeMs: m }));
          }
        } catch { /* raced deletion — fall through to the write */ }
      }
      let backup = null;
      if (before !== null) { try { backup = backupBeforeWrite(file); } catch { /* a missing backup must not block the save */ } }
      let text;
      try {
        text = writeSimple(tool, paths, values);
      } catch (e) {
        return send(res, e.status || 500, JSON.stringify({ error: `write failed: ${e.message}` }));
      }
      const st = fs.statSync(file);
      // Never log the values — apiKey is a live token.
      console.log(`wrote ${file} (${st.size} bytes)${backup ? ` — previous version saved to ${backup}` : ''}`);
      return send(res, 200, JSON.stringify({ ok: true, file, bytes: st.size, mtimeMs: st.mtimeMs, backup, text }));
    }

    // A doc that is not an object would be written straight to the file as
    // `"not-an-object"` — valid JSON, but not a settings file. Refused here.
    if (!payload.doc || typeof payload.doc !== 'object' || Array.isArray(payload.doc)) {
      return send(res, 400, JSON.stringify({ error: 'doc must be a JSON object' }));
    }
    const current = readSettings(file);

    // Stale-write guard: Claude Code writes this file live. Last-write-wins would
    // silently discard whatever landed since load. 409 keeps the client's draft.
    // Number.isFinite, not truthiness: baseMtimeMs 0 means the file was absent at
    // load, and a file that appeared since must be a conflict, not a free overwrite.
    if (current.exists && Number.isFinite(payload.baseMtimeMs) && Math.abs(current.mtimeMs - payload.baseMtimeMs) > 1) {
      return send(res, 409, JSON.stringify({ error: 'file changed on disk since you loaded it', mtimeMs: current.mtimeMs }));
    }

    const text = (current.bom ? '\uFEFF' : '') + JSON.stringify(payload.doc, null, 2).replace(/\n/g, current.eol || '\n') + (current.eol || '\n');
    // Back up only when the bytes actually change, so a no-op save does not burn a
    // slot in the rotation.
    let backup = null;
    if (current.exists && current.raw !== text) {
      try { backup = backupBeforeWrite(file); } catch { /* a missing backup must not block the save */ }
    }
    try {
      atomicWrite(file, text);
    } catch (e) {
      return send(res, 500, JSON.stringify({ error: `write failed: ${e.code || e.message}` }));
    }
    const st = fs.statSync(file);
    // Never log file contents — settings.json holds env.ANTHROPIC_AUTH_TOKEN.
    console.log(`wrote ${file} (${st.size} bytes)${backup ? ` — previous version saved to ${backup}` : ''}`);
    return send(res, 200, JSON.stringify({ ok: true, file, bytes: st.size, mtimeMs: st.mtimeMs, backup }));
  }

  send(res, 404, JSON.stringify({ error: 'not found' }));
}

module.exports = { handler };
