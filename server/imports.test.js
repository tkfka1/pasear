import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "./app.js";
import { OAuthStore, PaseoOAuthProvider, SCOPES } from "./oauth.js";
import { handoffContext } from "./handoff.js";

const publicUrl = "https://paseo.example/mcp", connectionKey = "a".repeat(64);
const handoff = { mode: "handoff", sourceAgentId: "source", provider: "codex/model", prompt: "Continue fixing login and verify tests", handoffSummary: "Goal: fix login. Decisions: preserve OAuth. Changes: login.ts edited. Checks: tests not run. Remaining: run tests. Gaps: older history unread.", requestKey: "handoff-1" };
const native = { mode: "native", provider: "claude", sessionId: "provider-session-1", cwd: "/repo/one", requestKey: "native-1" };
async function harness(t, hooks = {}) {
  const records = new Map([["source", { id: "source", title: "Login task", provider: "claude", workspaceId: "one", cwd: "/repo/one", status: "idle", archivedAt: "2026-01-01", persistence: { sessionId: "provider-session-1", nativeHandle: "native-handle-1" } }]]);
  const workspaces = new Map(["one", "two"].map(id => [id, { id, name: id, directory: `/repo/${id}`, projectId: `project-${id}` }]));
  const counts = { lists: 0, timelines: 0, creates: 0, imports: 0, sends: 0, refresh: 0 };
  const creations = [], imported = [], keys = new Map();
  const api = {
    providers: {
      snapshot: async () => { await hooks.provider?.(state); return { entries: [{ provider: "codex", enabled: true, status: "ready" }] }; },
      listModels: async () => ({ models: [{ id: "model", isDefault: true }] }),
    },
    workspaces: { list: async () => ({ entries: [...workspaces.values()], pageInfo: {} }), ref: id => ({
      id, get directory() { return workspaces.get(id)?.directory; }, get projectId() { return workspaces.get(id)?.projectId; },
      current: () => workspaces.get(id), refresh: async () => workspaces.get(id) ?? null,
      agents: { create: async options => {
        counts.creates++; creations.push({ workspaceId: id, ...options });
        if (!keys.has(options.idempotencyKey)) {
          const agentId = `new-${keys.size + 1}`; keys.set(options.idempotencyKey, agentId);
          records.set(agentId, { id: agentId, workspaceId: id, cwd: workspaces.get(id).directory, title: options.title, labels: options.labels, status: "running" });
        }
        return api.agents.ref(keys.get(options.idempotencyKey));
      } },
    }) },
    agents: {
      list: async options => { counts.lists++; await hooks.list?.(state, options); return { entries: [...records.values()].filter(agent => options.filter.includeArchived || !agent.archivedAt).map(agent => ({ agent })), pageInfo: {} }; },
      ref: id => ({ id, current: () => records.get(id), refresh: async () => { counts.refresh++; await hooks.refresh?.(state, id); return records.get(id) ?? null; },
        send: async () => counts.sends++,
        timeline: { refetch: async () => {
          counts.timelines++;
          if (hooks.timeline) return hooks.timeline(state);
          return { entries: [
            { item: { type: "user_message", text: "Fix login" }, timestamp: "2026-01-01" },
            { item: { type: "reasoning", text: "private-reasoning" } },
            { item: { type: "tool_call", name: "write_file", status: "completed", detail: { type: "write", filePath: "login.ts", content: "private-file-source" }, input: "private-tool-input", output: "private-tool-output" } },
            { item: { type: "tool_call", name: "shell", status: "completed", detail: { type: "shell", command: "private-shell-command", exitCode: 1 } } },
            { item: { type: "error", message: "private-error" } },
            { item: { type: "assistant_message", text: "Login change made; tests remain" } },
          ], hasOlder: true, hasNewer: false, startCursor: { epoch: "one", seq: 1 }, endCursor: { epoch: "one", seq: 6 } };
        } },
      }),
    },
  };
  const store = new OAuthStore(), provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  function token(id = "test", extra = {}) {
    store.data.grants[id] = { id, clientId: id, controlPermissionVersion: 1, resource: publicUrl, keyHash: provider.keyHash, scopes: SCOPES, workspaceIds: null, expiresAt: Date.now() / 1000 + 1000, ...extra };
    return provider.issue(id).access_token;
  }
  const auth = token();
  const importAgent = async input => {
    counts.imports++; imported.push(input);
    if (hooks.import) return hooks.import(state, input);
    const source = records.get("source");
    if ([source.persistence?.sessionId, source.persistence?.nativeHandle].includes(input.sessionId)) {
      source.archivedAt = null;
      source.labels = { pasearRequest: input.requestId, pasearImportIntent: input.intentHash };
      return source.id;
    }
    const id = "native-new";
    records.set(id, { id, title: "Native", provider: input.provider, cwd: input.cwd, workspaceId: "two", persistence: { sessionId: input.sessionId }, labels: { pasearRequest: input.requestId, pasearImportIntent: input.intentHash }, status: "idle" });
    return id;
  };
  const listener = createApp({ publicUrl, connectionKey, oauthStore: store, connection: { getApi: async () => api }, importAgent }).listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => { listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve)); });
  const url = `http://127.0.0.1:${listener.address().port}/mcp`;
  const state = { records, workspaces, counts, creations, imported, store, api, token, auth };
  state.call = async (args, bearer = auth) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "import_agent", arguments: args } }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  return state;
}

test("handoff finds archived sources by exact name, adds safe recent evidence, and starts a separate provider session", async t => {
  let archivedListed = false;
  const h = await harness(t, { list: (_, options) => { archivedListed ||= options.filter.includeArchived; } });
  const source = structuredClone(h.records.get("source"));
  const result = await h.call({ ...handoff, sourceAgentId: "Login task" });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.mode, "handoff");
  assert.equal(result.structuredContent.fileStateRestored, false);
  assert.equal(result.structuredContent.history.partial, true);
  assert.equal(result.structuredContent.history.sourceArchived, true);
  assert.equal(h.counts.creates, 1); assert.equal(h.counts.imports, 0); assert.equal(h.counts.sends, 0);
  assert.equal(archivedListed, true);
  assert.deepEqual(h.records.get("source"), source);
  const created = h.creations[0];
  assert.equal(created.workspaceId, "one"); assert.equal(created.config.provider, "codex/model");
  assert.equal(created.labels.pasearSourceAgent, "source");
  assert.equal(created.parent, undefined);
  for (const expected of [handoff.prompt, handoff.handoffSummary, "login.ts", '"exitCode":1', '"hasOlder":true', "untrusted reference data", "No files"]) assert.ok(created.prompt.includes(expected), expected);
  for (const hidden of ["private-reasoning", "private-file-source", "private-tool-input", "private-tool-output", "private-shell-command", "private-error"]) assert.ok(!created.prompt.includes(hidden), hidden);
  assert.ok(!JSON.stringify(result).includes("Login change made"));
});

test("handoff retries reuse stored lineage and reject a changed intention without fetching history again", async t => {
  const h = await harness(t);
  const first = await h.call(handoff);
  const second = await h.call(handoff);
  assert.equal(second.structuredContent.agentId, first.structuredContent.agentId);
  assert.equal(second.structuredContent.reused, true);
  assert.equal(h.counts.creates, 1); assert.equal(h.counts.timelines, 1);
  const different = await h.call({ ...handoff, prompt: "A different task" });
  assert.equal(different.isError, true); assert.match(different.content[0].text, /different import/);
  const fresh = await h.call({ ...handoff, requestKey: "fresh", prompt: "A different task" });
  assert.notEqual(fresh.structuredContent.agentId, first.structuredContent.agentId);
  assert.equal(h.counts.creates, 2);
});

test("handoff accepts a permitted agent source and a different fully permitted destination", async t => {
  const h = await harness(t);
  h.store.updateAccess("test", null, null, 0, [{ kind: "agent", id: "source", workspaceId: "one" }, { kind: "project", id: "project-two" }]);
  const result = await h.call({ ...handoff, workspaceId: "two" });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(h.creations[0].workspaceId, "two");
  assert.equal(result.structuredContent.sourceAgentId, "source");
});

test("handoff denies inaccessible sources and agent-only or inaccessible destinations before reading history or creating", async t => {
  const h = await harness(t);
  for (const rules of [
    [{ kind: "workspace", id: "two" }],
    [{ kind: "agent", id: "source", workspaceId: "one" }],
  ]) {
    const bearer = h.token(`scope-${h.counts.refresh}`, { accessRules: rules });
    const result = await h.call(handoff, bearer);
    assert.equal(result.isError, true);
  }
  const scoped = h.token("legacy", { workspaceIds: ["one"], agentIds: ["source"] });
  assert.equal((await h.call(handoff, scoped)).isError, true);
  assert.equal(h.counts.creates, 0); assert.equal(h.counts.timelines, 0);
});

test("handoff rechecks grant revocation, source placement and destination project changes after private history reads", async t => {
  for (const stage of ["revoke", "source", "destination", "revision"]) {
    const h = await harness(t, { timeline: state => {
      if (stage === "revoke") state.store.revoke("test");
      if (stage === "source") state.records.get("source").workspaceId = "private";
      if (stage === "destination") state.workspaces.get("two").projectId = "private";
      if (stage === "revision") state.store.updateAccess("test", null, null, 1, [{ kind: "workspace", id: "one" }]);
      return { entries: [{ item: { type: "assistant_message", text: "private-output" } }], hasOlder: false };
    } });
    h.store.updateAccess("test", null, null, 0, [{ kind: "agent", id: "source", workspaceId: "one" }, { kind: "project", id: "project-two" }]);
    const result = await h.call({ ...handoff, workspaceId: "two" });
    assert.equal(result.isError, true, stage);
    assert.equal(h.counts.creates, 0, stage);
    assert.ok(!JSON.stringify(result).includes("private-output"));
  }
});

test("handoff does not start if timeline retrieval fails or destination access changes during provider selection", async t => {
  const a = await harness(t, { timeline: () => ({ error: "private-sdk-error", entries: [] }) });
  assert.equal((await a.call(handoff)).isError, true); assert.equal(a.counts.creates, 0);
  const b = await harness(t, { provider: state => { state.workspaces.get("one").projectId = "private"; } });
  b.store.updateAccess("test", null, null, 0, [{ kind: "project", id: "project-one" }]);
  assert.equal((await b.call({ ...handoff, provider: undefined })).isError, true); assert.equal(b.counts.creates, 0);
});

test("handoff bounds escaped text and explicitly flags gaps and omitted older evidence", () => {
  const page = { entries: [
    { item: { type: "assistant_message", text: "old message" } },
    { item: { type: "assistant_message", text: "\u0000".repeat(50000) + "newest evidence" } },
  ], hasOlder: false, hasNewer: false, gap: true };
  const result = handoffContext({ id: "source" }, page, 1000);
  assert.equal(result.truncated, true); assert.equal(result.partial, true); assert.equal(result.gap, true);
  assert.ok(JSON.stringify(result.entries).length <= 1000);
  assert.ok(result.entries.some(entry => entry.text.endsWith("newest evidence")));
});

test("native imports revive archived original sessions without prompts and reuse active sessions on retry", async t => {
  const h = await harness(t);
  const result = await h.call({ mode: "native", sourceAgentId: "Login task", requestKey: "restore" });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.agentId, "source"); assert.equal(result.structuredContent.promptSent, false);
  assert.equal(h.counts.imports, 1); assert.equal(h.counts.creates, 0); assert.equal(h.counts.sends, 0);
  assert.equal(h.imported[0].sessionId, "native-handle-1"); assert.equal(h.imported[0].provider, "claude"); assert.equal(h.imported[0].cwd, "/repo/one");
  assert.match(h.imported[0].requestId, /^[a-f0-9]{64}$/);
  assert.equal((await h.call({ mode: "native", sourceAgentId: "source", requestKey: "restore" })).structuredContent.reused, true);
  assert.equal(h.counts.imports, 1);
});

test("native external import serializes concurrent chats and returns one original session", async t => {
  const h = await harness(t);
  const secondToken = h.token("second-chat");
  const request = { ...native, sessionId: "external-session" };
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => h.call({ ...request, requestKey: `key-${i}` }, i % 2 ? secondToken : h.auth)));
  for (const result of results) { assert.equal(result.isError, undefined, JSON.stringify(result)); assert.equal(result.structuredContent.agentId, "native-new"); }
  assert.equal(h.counts.imports, 1); assert.equal(h.counts.creates, 0); assert.equal(h.counts.sends, 0);
});

test("native import denies every constrained grant before catalog or CLI access", async t => {
  const h = await harness(t);
  for (const [i, scope] of [
    { workspaceIds: ["one"] }, { workspaceIds: null, agentIds: ["source"] },
    { accessRules: [{ kind: "project", id: "project-one" }] },
    { accessRules: [{ kind: "workspace", id: "one" }] },
    { accessRules: [{ kind: "agent", id: "source", workspaceId: "one" }] },
  ].entries()) {
    const result = await h.call(native, h.token(`limited-${i}`, scope));
    assert.equal(result.isError, true); assert.match(result.content[0].text, /whole host/);
  }
  assert.equal(h.counts.lists, 0); assert.equal(h.counts.imports, 0); assert.equal(h.counts.refresh, 0);
});

test("native import validates mutually exclusive inputs, unsupported sources and unsafe CLI values", async t => {
  const h = await harness(t);
  for (const request of [
    { mode: "native", requestKey: "missing" },
    { ...native, sourceAgentId: "source" }, { ...native, workspaceId: "one" },
    { ...native, prompt: "Do not silently send this" }, { ...native, title: "Rename" },
    { ...native, sessionId: "--host=evil" }, { ...native, provider: "claude/model" },
    { ...native, cwd: "relative/path" }, { ...native, sessionId: "bad\nvalue" },
  ]) assert.equal((await h.call(request)).isError, true, JSON.stringify(request));
  h.records.get("source").persistence = null;
  assert.equal((await h.call({ mode: "native", sourceAgentId: "source", requestKey: "no-handle" })).isError, true);
  assert.equal(h.counts.imports, 0);
});

test("native import rejects changed request-key intentions and checks scope again after catalog reads", async t => {
  const h = await harness(t);
  assert.equal((await h.call(native)).isError, undefined);
  const conflict = await h.call({ ...native, sessionId: "different-session" });
  assert.equal(conflict.isError, true); assert.match(conflict.content[0].text, /different import/);
  assert.equal(h.counts.imports, 1);
  const racy = await harness(t, { list: state => { state.store.updateAccess("test", ["one"], null, 0); } });
  assert.equal((await racy.call(native)).isError, true); assert.equal(racy.counts.imports, 0);
});

test("an uncertain native receipt is recovered by discovery without importing twice or exposing CLI errors", async t => {
  const h = await harness(t, { import: (state, input) => {
    const source = state.records.get("source"); source.archivedAt = null;
    source.labels = { pasearRequest: input.requestId, pasearImportIntent: input.intentHash };
    throw new Error("private-cli-token-and-output");
  } });
  const failed = await h.call(native);
  assert.equal(failed.isError, true); assert.ok(!JSON.stringify(failed).includes("private-cli-token"));
  const retry = await h.call(native);
  assert.equal(retry.isError, undefined, JSON.stringify(retry)); assert.equal(retry.structuredContent.reused, true);
  assert.equal(h.counts.imports, 1);
});

test("imports never pick the first of ambiguous archived titles", async t => {
  const h = await harness(t);
  h.records.set("another", { ...h.records.get("source"), id: "another" });
  for (const request of [{ ...handoff, sourceAgentId: "Login task" }, { mode: "native", sourceAgentId: "Login task", requestKey: "ambiguous" }]) {
    const result = await h.call(request);
    assert.equal(result.isError, true); assert.equal(result.structuredContent.status, "needs_selection");
    assert.equal(result.structuredContent.choices.length, 2);
  }
  assert.equal(h.counts.imports, 0); assert.equal(h.counts.creates, 0);
});

test("concurrent handoff retries serialize one snapshot and one creation, while chat connections keep separate retry keys", async t => {
  const h = await harness(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => h.call(handoff)));
  assert.ok(results.every(r => !r.isError && r.structuredContent.agentId === results[0].structuredContent.agentId));
  assert.equal(h.counts.creates, 1); assert.equal(h.counts.timelines, 1);
  const other = await h.call(handoff, h.token("another-connection"));
  assert.equal(other.isError, undefined);
  assert.notEqual(other.structuredContent.agentId, results[0].structuredContent.agentId);
  assert.notEqual(h.creations[0].idempotencyKey, h.creations[1].idempotencyKey);
});
