import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "./app.js";
import { OAuthStore, PaseoOAuthProvider, SCOPES } from "./oauth.js";

const connectionKey = "a".repeat(64), publicUrl = "https://paseo.example/mcp";
const archivedAt = "2026-11-06T00:00:00.000Z";
async function harness(t, hooks = {}) {
  const records = new Map([
    ["a", { id: "a", title: "Login", workspaceId: "yes", status: "idle" }],
    ["b", { id: "b", title: "Other", workspaceId: "no", status: "running" }],
  ]);
  const calls = { archive: [], delete: [], send: [], cancel: [], list: [], refresh: [] };
  const store = new OAuthStore(), provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  const grant = { id: "cleanup", clientId: "test", resource: publicUrl, keyHash: provider.keyHash,
    scopes: SCOPES, controlPermissionVersion: 1, accessRevision: 0, workspaceIds: null, expiresAt: Date.now() / 1000 + 1000, ...hooks.grant };
  store.data.grants.cleanup = grant;
  const token = provider.issue(grant.id).access_token;
  const api = { agents: {
    list: async options => { calls.list.push(options); return { entries: [...records.values()].filter(a => options.filter.includeArchived || !a.archivedAt).map(agent => ({ agent })), pageInfo: {} }; },
    ref: id => ({ id, current: () => records.get(hooks.resolve?.(state, id) ?? id),
      refresh: async () => { calls.refresh.push(id); await hooks.refresh?.(state, id); return records.get(hooks.resolve?.(state, id) ?? id) ?? null; },
      archive: async () => {
        calls.archive.push(id);
        if (hooks.archive) return hooks.archive(state, id);
        records.set(id, { ...records.get(id), status: "closed", archivedAt });
        return { archivedAt };
      },
      send: async (text, options) => { calls.send.push({ id, text, options }); },
    }),
  } };
  const remove = async id => { calls.delete.push(id); if (hooks.delete) return hooks.delete(state, id); records.delete(id); };
  const listener = createApp({ connectionKey, publicUrl, oauthStore: store, connection: { getApi: async () => api },
    deleteAgent: hooks.noDelete ? undefined : remove, cancelAgent: async id => { calls.cancel.push(id); },
  }).listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => { listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve)); });
  const url = `http://127.0.0.1:${listener.address().port}/mcp`;
  const state = { records, calls, grant, store };
  state.rpc = async (method, params = {}) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  state.call = (name, agentId = "a", extra = {}) => state.rpc("tools/call", { name, arguments: { agentId, ...extra } });
  return state;
}

for (const operation of ["close", "archive"]) {
  test(`${operation}_agent directly archives idle/running agents and returns archive semantics`, async t => {
    const h = await harness(t);
    for (const id of ["a", "b"]) {
      const result = await h.call(`${operation}_agent`, id);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.deepEqual(result.structuredContent, { agentId: id, operation, archived: true, archivedAt, alreadyArchived: false, childAgentsMayBeArchived: true, next: "list_agents", includeArchived: true });
      assert.equal(h.records.get(id).status, "closed");
    }
    assert.deepEqual(h.calls.archive, ["a", "b"]);
    assert.deepEqual(h.calls.delete, []); assert.deepEqual(h.calls.cancel, []);
    const retry = await h.call(`${operation}_agent`, "a");
    assert.equal(retry.structuredContent.alreadyArchived, true);
    assert.deepEqual(h.calls.archive, ["a", "b"]);
  });

  test(`${operation}_agent blocks cascade for workspace/project/agent-only connections`, async t => {
    for (const accessRules of [[{ kind: "workspace", id: "yes" }], [{ kind: "project", id: "p" }], [{ kind: "agent", id: "a", workspaceId: "yes" }]]) {
      const h = await harness(t, { grant: { accessRules } });
      const result = await h.call(`${operation}_agent`);
      assert.equal(result.isError, true); assert.match(result.content[0].text, /whole-host.*descendant/);
      assert.deepEqual(h.calls.archive, []); assert.deepEqual(h.calls.delete, []);
    }
  });
}

test("archive/close aliases resolve an archived exact unique title and report an existing archive", async t => {
  const h = await harness(t);
  h.records.get("a").archivedAt = archivedAt;
  const result = await h.call("close_agent", "Login");
  assert.equal(result.structuredContent.agentId, "a"); assert.equal(result.structuredContent.alreadyArchived, true);
  assert.equal(h.calls.list[0].filter.includeArchived, true); assert.deepEqual(h.calls.archive, []);
});

test("delete_agent resolves an archived title then removes exactly that record without post-delete existence errors", async t => {
  const h = await harness(t, { grant: { accessRules: [{ kind: "agent", id: "a", workspaceId: "yes" }] } });
  h.records.get("a").archivedAt = archivedAt;
  const result = await h.call("delete_agent", "Login");
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(result.structuredContent, { agentId: "a", deletionRequested: true, next: "list_agents", includeArchived: true });
  assert.deepEqual(h.calls.delete, ["a"]); assert.equal(h.records.has("a"), false); assert.equal(h.records.has("b"), true);
  assert.equal(h.calls.list[0].filter.includeArchived, true);
});

test("delete_agent supports allowed running agents without an extra confirmation or cancel call", async t => {
  const h = await harness(t);
  const result = await h.call("delete_agent", "b");
  assert.equal(result.structuredContent.deletionRequested, true);
  assert.deepEqual(h.calls.delete, ["b"]); assert.deepEqual(h.calls.cancel, []);
});

test("daemon title/prefix resolution is normalized to the snapshot's exact ID before every cleanup", async t => {
  for (const operation of ["close", "archive", "delete"]) {
    for (const alias of ["Login", "agent-prefix"]) {
      const h = await harness(t, { resolve: (_, id) => id === alias ? "a" : id });
      const result = await h.call(`${operation}_agent`, alias);
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(result.structuredContent.agentId, "a");
      assert.deepEqual(operation === "delete" ? h.calls.delete : h.calls.archive, ["a"]);
      assert.equal(h.records.has(alias), false);
    }
  }
});

test("cleanup rejects an invalid or changing SDK snapshot ID before mutation", async t => {
  for (const id of ["--all", "bad\nvalue", "x".repeat(201)]) {
    const h = await harness(t);
    h.records.get("a").id = id;
    assert.equal((await h.call("delete_agent")).isError, true);
    assert.deepEqual(h.calls.delete, []);
  }
  const h = await harness(t, { refresh: state => { if (state.calls.refresh.length === 2) state.records.get("a").id = "b"; } });
  assert.equal((await h.call("archive_agent")).isError, true);
  assert.deepEqual(h.calls.archive, []);
});

test("cleanup cannot select missing/ambiguous names or delete an inaccessible exact ID", async t => {
  const h = await harness(t, { grant: { workspaceIds: ["yes"] } });
  h.records.set("c", { id: "c", title: "Login", workspaceId: "yes", status: "idle" });
  const ambiguous = await h.call("delete_agent", "Login");
  assert.equal(ambiguous.structuredContent.status, "needs_selection");
  for (const id of ["b", "missing"]) assert.equal((await h.call("delete_agent", id)).isError, true);
  assert.deepEqual(h.calls.delete, []);
});

test("cleanup rechecks target placement and grant revision immediately before mutation", async t => {
  for (const operation of ["delete", "archive", "close"]) {
    const h = await harness(t, { refresh: state => { if (state.calls.refresh.length === 2) state.grant.accessRevision++; } });
    assert.equal((await h.call(`${operation}_agent`)).isError, true);
    assert.deepEqual(h.calls.archive, []); assert.deepEqual(h.calls.delete, []);
  }
  const h = await harness(t, { grant: { workspaceIds: ["yes"] }, refresh: state => {
    if (state.calls.refresh.length === 2) state.records.get("a").workspaceId = "no";
  } });
  assert.equal((await h.call("delete_agent")).isError, true); assert.deepEqual(h.calls.delete, []);
});

test("access revocation during deletion suppresses its receipt without requiring the record to exist", async t => {
  const h = await harness(t, { delete: (state, id) => { state.records.delete(id); state.grant.accessRevision++; } });
  const result = await h.call("delete_agent");
  assert.equal(result.isError, true); assert.match(result.content[0].text, /access changed/i);
  assert.equal(result.structuredContent, undefined); assert.deepEqual(h.calls.delete, ["a"]);
});

test("missing CLI, malformed archive receipts and SDK/CLI failures expose no private errors", async t => {
  for (const hooks of [{ noDelete: true }, { delete: () => { throw new Error("secret-path-and-token"); } }]) {
    const h = await harness(t, hooks);
    const result = await h.call("delete_agent");
    assert.equal(result.isError, true); assert.match(result.content[0].text, /may already have been applied/);
    assert.ok(!JSON.stringify(result).includes("secret-path-and-token"));
  }
  for (const receipt of [null, {}, { archivedAt: "invalid" }]) {
    const h = await harness(t, { archive: () => receipt });
    assert.equal((await h.call("archive_agent")).isError, true);
  }
  const h = await harness(t, { archive: () => { throw new Error("secret-path-and-token"); } });
  const result = await h.call("close_agent");
  assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes("secret-path-and-token"));
});

test("cleanup discovery declares write scope/destructive effects and no confirmation arguments", async t => {
  const h = await harness(t);
  const { tools } = await h.rpc("tools/list");
  for (const name of ["close_agent", "archive_agent", "delete_agent"]) {
    const tool = tools.find(t => t.name === name);
    assert.deepEqual(tool._meta.securitySchemes[0].scopes, ["paseo:write"]);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), ["agentId"]);
  }
});

test("send_agent_prompt forwards both public modes without inventing a completion queue", async t => {
  const h = await harness(t);
  for (const behavior of ["steer", "interrupt"]) {
    const result = await h.call("send_agent_prompt", "a", { behavior, prompt: "Do this", messageId: behavior });
    assert.equal(result.structuredContent.accepted, true);
    assert.equal(h.calls.send.at(-1).options.activeTurnBehavior, behavior);
  }
  const invalid = await h.call("send_agent_prompt", "a", { behavior: "queue", prompt: "Later", messageId: "queue" });
  assert.equal(invalid.isError, true); assert.equal(h.calls.send.length, 2);
  const { tools } = await h.rpc("tools/list");
  const tool = tools.find(t => t.name === "send_agent_prompt");
  assert.match(tool.description, /Neither option queues/);
  assert.deepEqual(tool.inputSchema.properties.behavior.enum, ["steer", "interrupt"]);
  assert.equal(tool.inputSchema.properties.behavior.default, "steer");
});
