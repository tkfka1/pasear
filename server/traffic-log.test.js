import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, utimes, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrafficLog, redact } from "./traffic-log.js";
import { createApp } from "./app.js";
import { OAuthStore, PaseoOAuthProvider, SCOPES } from "./oauth.js";

async function harness(t, limits) {
  const directory = await mkdtemp(join(tmpdir(), "pasear-logs-test-"));
  const log = new TrafficLog(directory, limits); await log.ready;
  t.after(async () => { await log.close(); await rm(directory, { recursive: true, force: true }); });
  return { log, directory };
}
const entry = (patch = {}) => ({ at: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 12,
  connectionId: "chat-a", clientName: "Chat A", httpMethod: "POST", path: "/mcp", status: 200, outcome: "ok", method: "tools/call", tool: "get_agent",
  request: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_agent", arguments: { agentId: "a" } } },
  response: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "작업 완료" }] } }, ...patch });
const record = (log, row) => log.record(row, log.capture());
async function exportAll(log, filter = {}) { let cursor, content = ""; do { const page = await log.exportPage({ ...filter, cursor }); content += page.content; cursor = page.nextCursor; } while (cursor); return content.split("\n").filter(Boolean).map((s) => JSON.parse(s)); }

test("traffic records persist across reloads, have private permissions and paginated metadata-only queries", async (t) => {
  const { log, directory } = await harness(t);
  record(log, entry()); record(log, entry({ connectionId: "chat-b", clientName: "Chat B", tool: "list_agents" })); record(log, entry());
  const first = await log.list({ limit: 2 }); assert.equal(first.entries.length, 2); assert.ok(first.nextCursor);
  assert.equal("request" in first.entries[0], false); assert.equal("response" in first.entries[0], false);
  const last = await log.list({ limit: 2, before: first.nextCursor }); assert.equal(last.entries.length, 1); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.entries, ...last.entries].map((r) => r.id)).size, 3);
  const detail = await log.detail(first.entries[0].id); assert.deepEqual(detail.request, entry().request); assert.deepEqual(detail.response, entry().response);
  assert.equal((await log.list({ connection: "CHAT B", tool: "list" })).entries.length, 1);
  const reopened = new TrafficLog(directory); await reopened.ready; assert.equal((await reopened.list()).entries.length, 3); await reopened.close();
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory)) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
});

test("credentials are redacted in nested objects, JSON text, arrays and free text while normal task text stays intact", () => {
  const actual = redact({ Authorization: "header-secret", token: "generic-secret", nested: [{ access_token: "access-secret", apiKey: "api-secret", connection_key: "key-secret", password: "password-secret", client_secret: "client-secret" }],
    text: JSON.stringify({ result: { refreshToken: "refresh-secret", message: "Bearer token-in-text" } }), prose: 'api_key="inline-secret" password=password-text bearer abc.def.123 known-value', prompt: "한국어 작업 내용" }, ["known-value"]);
  const serialized = JSON.stringify(actual);
  for (const secret of ["header-secret", "generic-secret", "access-secret", "api-secret", "key-secret", "password-secret", "client-secret", "refresh-secret", "token-in-text", "inline-secret", "password-text", "abc.def.123", "known-value"]) assert.ok(!serialized.includes(secret), secret);
  assert.equal(actual.prompt, "한국어 작업 내용"); assert.ok(serialized.includes("REDACTED"));
});

test("disable survives reload, enabling is immediate, and clearing cannot resurrect in-flight or queued requests", async (t) => {
  const { log, directory } = await harness(t);
  record(log, entry()); await log.status();
  const inFlight = log.capture(); record(log, entry()); const clearing = log.clear(); await clearing;
  log.record(entry(), inFlight); assert.equal((await log.list()).entries.length, 0);
  record(log, entry()); assert.equal((await log.list()).entries.length, 1);
  await log.configure(false); record(log, entry()); assert.equal((await log.list()).entries.length, 1);
  const reopened = new TrafficLog(directory); await reopened.ready; assert.equal((await reopened.status()).enabled, false); await reopened.close();
  await log.configure(true); record(log, entry()); assert.equal((await log.list()).entries.length, 2);
  const selected = (await log.list()).entries[0].id; await log.clear(); await assert.rejects(log.detail(selected), /expired|deleted/); await assert.rejects(log.list({ before: selected }), /expired|deleted/);
});

test("rotation bounds disk usage and retention cleans old segments on startup without erasing current records", async (t) => {
  const { log, directory } = await harness(t, { maxBytes: 2000, segmentBytes: 1000, queueBytes: 10000 });
  for (let i = 0; i < 12; i++) { record(log, entry({ request: { n: i }, response: "result" })); await log.status(); }
  assert.ok((await log.status()).storedBytes <= 2000); assert.ok((await log.list()).entries.length < 12);
  const file = (await readdir(directory)).find((s) => s.endsWith('.jsonl'));
  const old = new Date(Date.now() - 8 * 86400000); await utimes(join(directory, file), old, old);
  const reopened = new TrafficLog(directory, { maxBytes: 2000, segmentBytes: 1000 }); await reopened.ready;
  assert.ok(!(await readdir(directory)).includes(file)); await reopened.close();
});

test("filtered JSONL export has a stable snapshot, chunks large Unicode data and invalidates after delete", async (t) => {
  const { log } = await harness(t);
  record(log, entry({ response: "산책🐶".repeat(18000) })); record(log, entry({ clientName: "Chat B", tool: "list_agents" }));
  const begin = await log.exportPage({ connection: "Chat A", tool: "get_agent" }); assert.ok(begin.nextCursor);
  record(log, entry({ response: "later" })); await log.status();
  let text = begin.content, cursor = begin.nextCursor;
  do { const page = await log.exportPage({ cursor }); text += page.content; cursor = page.nextCursor; } while (cursor);
  const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line)); assert.equal(rows.length, 1); assert.equal(rows[0].response, "산책🐶".repeat(18000));
  assert.equal((await exportAll(log)).length, 3);
  const next = await log.exportPage(); assert.ok(next.nextCursor); await log.clear(); await assert.rejects(log.exportPage({ cursor: next.nextCursor }), /expired|deleted/);
});

test("queue pressure and filesystem errors are visible without breaking MCP caller code", async (t) => {
  const { log, directory } = await harness(t, { queueBytes: 1 });
  assert.doesNotThrow(() => record(log, entry())); assert.equal((await log.status()).dropped, 1);
  const brokenPath = join(directory, "blocked"); await writeFile(brokenPath, "file");
  const broken = new TrafficLog(brokenPath); await broken.ready;
  assert.doesNotThrow(() => record(broken, entry())); const state = await broken.status(); assert.equal(state.dropped, 1); assert.ok(state.error);
  await assert.rejects(broken.configure(false), /settings/); await broken.close();
});

test("HTTP logs capture authenticated MCP requests and replies, protocol errors and notices while excluding OAuth traffic and untrusted credentials", async (t) => {
  const { log, directory } = await harness(t);
  const connectionKey = "e".repeat(64), publicUrl = "https://logs.example/mcp", oauthStore = new OAuthStore();
  const provider = new PaseoOAuthProvider(oauthStore, publicUrl, connectionKey), grantId = randomUUID();
  oauthStore.data.grants[grantId] = { id: grantId, clientName: "Web chat", clientId: "test", createdAt: Math.floor(Date.now() / 1000), resource: publicUrl, keyHash: provider.keyHash, scopes: SCOPES, workspaceIds: null, expiresAt: Date.now() / 1000 + 1000 };
  const token = provider.issue(grantId).access_token;
  const api = { agents: { list: async () => ({ entries: [], pageInfo: { nextCursor: null } }) } };
  const listener = createApp({ connectionKey, publicUrl, oauthStore, trafficLog: log, connection: { getApi: async () => api } }).listen(0, "127.0.0.1"); await once(listener, "listening");
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const post = (body, path = "/mcp", authorized = true) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorized ? { authorization: `Bearer ${token}`, cookie: "sensitive-cookie" } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "/")).status, 200);
  assert.equal((await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_agents", arguments: { hiddenToken: token, apiKey: 'unknown-api-secret', prompt: connectionKey } } })).status, 200);
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await post("malformed json")).status, 400);
  assert.equal((await post({ jsonrpc: "2.0", id: 3, method: "not-supported" })).status, 200);
  assert.equal((await post({ connection_key: connectionKey }, "/mcp?access_token=private-query", false)).status, 401);
  await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'secret-oauth-client', redirect_uris: ['https://chat.example/callback'], token_endpoint_auth_method: 'none' }) });
  await fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_secret=oauth-form-secret' });
  await fetch(base + '/healthz'); await log.status();
  const rows = (await log.list()).entries; assert.equal(rows.length, 6);
  assert.ok(rows.some((r) => r.method === 'notifications/initialized')); assert.ok(rows.some((r) => r.status === 400)); assert.ok(rows.some((r) => r.outcome === 'error' && r.status === 200));
  const tool = await log.detail(rows.find((r) => r.tool === 'list_agents').id);
  assert.equal(tool.request.params.name, 'list_agents'); assert.deepEqual(tool.response.result.structuredContent.entries, []); assert.equal(tool.connectionId, grantId); assert.equal(tool.clientName, 'Web chat');
  assert.equal(tool.request.params.arguments.hiddenToken, '[REDACTED]'); assert.equal(tool.request.params.arguments.apiKey, '[REDACTED]'); assert.equal(tool.request.params.arguments.prompt, '[REDACTED]');
  const denied = await log.detail(rows.find((r) => r.status === 401).id); assert.equal(denied.request, null); assert.equal(denied.method, null); assert.equal(denied.path, '/mcp');
  const raw = (await Promise.all((await readdir(directory)).map((n) => readFile(join(directory, n), 'utf8')))).join('\n');
  for (const secret of [connectionKey, token, 'sensitive-cookie', 'private-query', 'oauth-form-secret', 'secret-oauth-client', 'unknown-api-secret']) assert.ok(!raw.includes(secret), secret);
  assert.ok(raw.includes('list_agents')); assert.equal((await fetch(base + '/mcp')).status, 401);
  const collected = await log.list(); const events = structuredClone(oauthStore.snapshot().events);
  await log.configure(false);
  assert.equal((await post({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "list_agents", arguments: {} } })).status, 200);
  assert.equal((await fetch(base + '/mcp')).status, 401);
  assert.deepEqual((await log.list()).entries, collected.entries);
  assert.deepEqual(oauthStore.snapshot().events, events, "disabled collection also excludes in-memory tool audit");
  await log.configure(true);
  assert.equal((await post({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "list_agents", arguments: {} } })).status, 200);
  assert.equal((await log.list()).entries.length, collected.entries.length + 1);
  assert.equal(oauthStore.snapshot().events.length, events.length + 1);
});

test("reload leaves malformed tail isolated, cleanup flushes completed records, and large reply omissions are explicit", async (t) => {
  const { log, directory } = await harness(t);
  record(log, entry()); await log.close();
  const existing = (await readdir(directory)).find((s) => s.endsWith('.jsonl'));
  await writeFile(join(directory, existing), '{"incomplete":', { flag: 'a' });
  const reopened = new TrafficLog(directory); await reopened.ready; record(reopened, entry({ response: 'after reload' }));
  const rows = await exportAll(reopened); assert.equal(rows.length, 2); assert.equal(rows.at(-1).response, 'after reload'); await reopened.close();
});

test("oversized HTTP replies remain successful and record an omission marker without a credential-bearing preview", async (t) => {
  const { log } = await harness(t, { bodyBytes: 60 });
  const { default: express } = await import('express');
  const { captureTraffic } = await import('./traffic-http.js');
  const app = express(); app.use(captureTraffic(log, 'known-key'));
  app.post('/mcp', (_req, res) => res.json({ content: 'sensitive-result'.repeat(100) }));
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/mcp`, { method: 'POST' });
  assert.equal(response.status, 200); assert.ok((await response.json()).content.includes('sensitive-result'));
  const row = await log.detail((await log.list()).entries[0].id);
  assert.equal(row.response.omitted, 'body_size_limit'); assert.ok(row.response.bytes > 60); assert.ok(!JSON.stringify(row).includes('sensitive-result'));
});

test("an interrupted MCP response records one aborted exchange without delaying the caller", async (t) => {
  const { log } = await harness(t);
  const { default: express } = await import('express');
  const { captureTraffic } = await import('./traffic-http.js');
  const app = express(); app.use(captureTraffic(log, 'key'));
  let disconnected; const closed = new Promise((resolve) => { disconnected = resolve; });
  app.post('/mcp', (_req, res) => { res.once('close', disconnected); res.set('content-type', 'application/json'); res.write('{"partial":'); });
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/mcp`, { method: 'POST', signal: controller.signal });
  controller.abort(); await response.body.cancel().catch(() => {}); await closed;
  const rows = (await log.list()).entries; assert.equal(rows.length, 1); assert.equal(rows[0].outcome, 'aborted');
});


test("collection off removes active response capture immediately and bypasses hooks on new requests", async (t) => {
  const { log } = await harness(t);
  const { default: express } = await import('express');
  const { captureTraffic } = await import('./traffic-http.js');
  const app = express(); let active, originalWrite, originalEnd;
  app.use((_req, res, next) => { originalWrite = res.write; originalEnd = res.end; next(); });
  app.use(captureTraffic(log, 'key'));
  app.post('/mcp', (_req, res) => { active = res; res.set('content-type', 'application/json'); res.write('{"message":'); });
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/mcp`, { method: 'POST' });
  assert.notEqual(active.write, originalWrite); assert.equal(log.captures.size, 1);
  await log.configure(false);
  assert.equal(log.captures.size, 0); assert.equal(active.write, originalWrite); assert.equal(active.end, originalEnd);
  active.end('"private response"}'); assert.equal((await response.json()).message, 'private response');
  assert.equal((await log.list()).entries.length, 0);
  const next = await fetch(`http://127.0.0.1:${listener.address().port}/mcp`, { method: 'POST' });
  assert.equal(active.write, originalWrite); assert.equal(active.end, originalEnd); assert.equal(log.captures.size, 0);
  active.end('"not collected"}'); await next.json(); assert.equal((await log.list()).entries.length, 0);
  await log.configure(true); assert.equal((await log.status()).enabled, true);
});
