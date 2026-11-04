import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createApp } from "./app.js";
import { OAuthStore, PaseoOAuthProvider, SCOPES } from "./oauth.js";

async function harness(t) {
  const projects = [
    { projectId: "p1", projectDisplayName: "One", projectCustomName: "Shop", projectRootPath: "/private/root-one", privateMetadata: "do-not-export" },
    { projectId: "p2", projectDisplayName: "Two", projectCustomName: "Shop", projectRootPath: "/private/root-two" },
    { projectId: "hidden", projectDisplayName: "Secret project" },
    { projectId: "empty", projectDisplayName: "Empty project" },
  ];
  const workspaces = [
    { id: "w1", name: "Main", projectId: "p1", projectDisplayName: "One", workspaceDirectory: "/repo/one" },
    { id: "w2", name: "Main", projectId: "p2", projectDisplayName: "Two", workspaceDirectory: "/repo/two" },
    { id: "sibling", name: "Private sibling", projectId: "p2", workspaceDirectory: "/private/sibling" },
    { id: "private", name: "Hidden workspace", projectId: "hidden", workspaceDirectory: "/private/hidden" },
  ];
  const agents = [{ id: "a1", title: "One task", workspaceId: "w1" }, { id: "a2", title: "Allowed task", workspaceId: "w2" },
    { id: "other", title: "Private task", workspaceId: "w2" }, { id: "sibling-agent", title: "Private sibling task", workspaceId: "sibling" }];
  const hooks = {}, created = [], queries = [];
  const api = {
    projects: { list: async () => { const result = projects.map((p) => ({ ...p })); await hooks.projects?.(); return { projects: result }; } },
    workspaces: {
      list: async (options = {}) => {
        queries.push(options);
        const entries = workspaces.filter((w) => !options.filter?.projectId || w.projectId === options.filter.projectId).map((w) => ({ ...w }));
        await hooks.workspaces?.();
        return { entries, pageInfo: { nextCursor: null } };
      },
      ref: (id) => ({ id, get projectId() { return workspaces.find((w) => w.id === id)?.projectId; }, get directory() { return workspaces.find((w) => w.id === id)?.workspaceDirectory; },
        current: () => workspaces.find((w) => w.id === id),
        refresh: async () => { await hooks.workspaceRefresh?.(id); return workspaces.find((w) => w.id === id) ?? null; },
        agents: { create: async (options) => { created.push({ workspaceId: id, ...options }); return { id: "new", current: () => ({ id: "new", workspaceId: id }) }; } },
      }),
    },
    agents: {
      list: async () => { const entries = agents.map((agent) => ({ agent: { ...agent } })); await hooks.agents?.(); return { entries, pageInfo: { nextCursor: "next-agent-page" } }; },
      ref: (id) => ({ id, current: () => agents.find((a) => a.id === id), refresh: async () => { await hooks.agentRefresh?.(id); return agents.find((a) => a.id === id) ?? null; } }),
    },
    providers: { snapshot: async () => { await hooks.providers?.(); return { entries: [{ provider: "codex", enabled: true, status: "ready" }] }; }, listModels: async () => ({ models: [{ id: "model", isDefault: true }] }) },
  };
  const connectionKey = "a".repeat(64), publicUrl = "https://paseo.example";
  const store = new OAuthStore(), provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  store.data.grants.test = { id: "test", clientId: "test", resource: provider.resource, keyHash: provider.keyHash, scopes: SCOPES,
    workspaceIds: null, agentIds: null, accessRevision: 0, controlPermissionVersion: 1, expiresAt: Date.now() / 1000 + 1000 };
  const token = provider.issue("test").access_token;
  const listener = createApp({ connectionKey, publicUrl, oauthStore: store, connection: { getApi: async () => api } }).listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  async function call(name, args = {}) {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  const access = (rules) => store.updateAccess("test", null, null, store.data.grants.test.accessRevision, rules);
  return { projects, workspaces, agents, hooks, created, queries, store, call, access };
}

test("project discovery respects whole-project and child-only grants without exposing siblings or private metadata", async (t) => {
  const h = await harness(t);
  h.access([{ kind: "project", id: "p1" }, { kind: "agent", id: "a2", workspaceId: "w2" }]);
  const projects = await h.call("list_projects");
  assert.deepEqual(projects.structuredContent.entries, [{ projectId: "p1", name: "Shop", access: "full" }, { projectId: "p2", name: "Shop", access: "partial" }]);
  assert.ok(!JSON.stringify(projects).includes("private"));
  assert.ok(!JSON.stringify(projects).includes("Secret"));
  assert.ok(!JSON.stringify(projects).includes("do-not-export"));
  const workspaces = await h.call("list_workspaces", { projectId: "p2", cursor: "workspace-page", limit: 10 });
  assert.deepEqual(workspaces.structuredContent.entries.map((w) => w.workspaceId), ["w2"]);
  assert.deepEqual(h.queries.at(-1), { filter: { projectId: "p2" }, page: { cursor: "workspace-page", limit: 10 } });
  const agents = await h.call("list_agents", { projectId: "p2" });
  assert.deepEqual(agents.structuredContent.entries.map((a) => a.agentId), ["a2"]);
  assert.equal(agents.structuredContent.pageInfo.nextCursor, "next-agent-page");
  assert.equal((await h.call("create_agent", { projectId: "p2", provider: "codex/model", prompt: "Work", requestKey: "denied" })).isError, true);
  assert.deepEqual(h.created, []);
  const created = await h.call("create_agent", { projectId: "p1", provider: "codex/model", prompt: "Work", requestKey: "allowed" });
  assert.equal(created.structuredContent.accepted, true);
  assert.equal(h.created[0].workspaceId, "w1");
  h.workspaces.push({ id: "future", name: "Future", projectId: "p1" });
  assert.deepEqual((await h.call("list_workspaces", { projectId: "p1" })).structuredContent.entries.map((w) => w.workspaceId), ["w1", "future"]);
});

test("project and workspace names disambiguate only among allowed choices and cannot cross projects", async (t) => {
  const h = await harness(t);
  h.access([{ kind: "workspace", id: "w1" }, { kind: "workspace", id: "w2" }]);
  const ambiguous = await h.call("list_workspaces", { projectId: "shop" });
  assert.equal(ambiguous.structuredContent.kind, "project");
  assert.deepEqual(ambiguous.structuredContent.choices.map((p) => p.projectId), ["p1", "p2"]);
  const denied = await h.call("list_agents", { projectId: "Secret project" });
  assert.equal(denied.structuredContent.status, "needs_selection");
  assert.ok(!JSON.stringify(denied).includes("Secret project"));
  const create = (args) => h.call("create_agent", { provider: "codex/model", prompt: "Work", requestKey: "select", ...args });
  const workspaces = await create({ workspaceId: "Main" });
  assert.deepEqual(workspaces.structuredContent.choices.map((w) => w.projectId), ["p1", "p2"]);
  assert.equal((await create({ projectId: "p1", workspaceId: "Main" })).structuredContent.accepted, true);
  assert.equal((await create({ projectId: "p1", workspaceId: "w2" })).structuredContent.status, "needs_selection");
  assert.equal((await create({ projectId: "p1", cwd: "/private/sibling" })).isError, true);
  assert.equal(h.created.length, 1);
});

test("legacy grants and empty projects retain their exact permission boundaries", async (t) => {
  const h = await harness(t), grant = h.store.data.grants.test;
  grant.workspaceIds = ["w1"]; grant.agentIds = null;
  assert.deepEqual((await h.call("list_projects")).structuredContent.entries, [{ projectId: "p1", name: "Shop", access: "partial" }]);
  grant.workspaceIds = null; grant.agentIds = ["a2"]; grant.accessRevision++;
  assert.deepEqual((await h.call("list_projects")).structuredContent.entries, [{ projectId: "p2", name: "Shop", access: "partial" }]);
  grant.workspaceIds = ["w1"]; grant.accessRevision++;
  assert.deepEqual((await h.call("list_projects")).structuredContent.entries, []);
  h.access([{ kind: "project", id: "empty" }]);
  assert.deepEqual((await h.call("list_projects")).structuredContent.entries, [{ projectId: "empty", name: "Empty project", access: "full" }]);
  assert.deepEqual((await h.call("list_workspaces", { projectId: "Empty project" })).structuredContent.entries, []);
  assert.equal((await h.call("create_agent", { projectId: "empty", prompt: "Work", provider: "codex/model", requestKey: "empty" })).structuredContent.status, "needs_selection");
  assert.equal(h.created.length, 0);
  h.access([{ kind: "all", id: "*" }]);
  assert.equal((await h.call("list_projects")).structuredContent.entries.length, 4);
});

test("project discovery rechecks current child membership and rejects permission changes during reads", async (t) => {
  const h = await harness(t);
  h.access([{ kind: "workspace", id: "w1" }]);
  h.hooks.projects = () => { h.workspaces[0].projectId = "hidden"; };
  const moved = await h.call("list_projects");
  assert.equal(moved.isError, true);
  assert.ok(!JSON.stringify(moved).includes("Shop"));
  delete h.hooks.projects;
  assert.deepEqual((await h.call("list_projects")).structuredContent.entries, [{ projectId: "hidden", name: "Secret project", access: "partial" }]);
  h.access([{ kind: "agent", id: "a2", workspaceId: "w2" }]);
  h.hooks.projects = () => { h.agents[1].workspaceId = "private"; };
  assert.equal((await h.call("list_projects")).isError, true);
  delete h.hooks.projects;
  assert.deepEqual((await h.call("list_projects")).structuredContent.entries, []);
  h.access([{ kind: "workspace", id: "w1" }]);
  h.hooks.projects = () => h.access([{ kind: "project", id: "empty" }]);
  assert.equal((await h.call("list_projects")).isError, true);
});

test("project filters recheck membership before exposing tasks or starting a write", async (t) => {
  const h = await harness(t);
  h.access([{ kind: "all", id: "*" }]);
  h.hooks.agents = () => { h.agents[0].workspaceId = "private"; };
  const moved = await h.call("list_agents", { projectId: "p1" });
  assert.equal(moved.isError, true);
  assert.ok(!JSON.stringify(moved).includes("One task"));
  delete h.hooks.agents;
  h.hooks.providers = () => { h.workspaces[0].projectId = "hidden"; };
  assert.equal((await h.call("create_agent", { projectId: "p1", provider: "codex", prompt: "Work", requestKey: "moved" })).isError, true);
  assert.equal(h.created.length, 0);
});

test("a moved agent-only grant cannot expose its former workspace through another allowed branch", async (t) => {
  const h = await harness(t);
  h.access([{ kind: "workspace", id: "sibling" }, { kind: "agent", id: "a2", workspaceId: "w2" }]);
  h.agents.find((a) => a.id === "a2").workspaceId = "private";
  assert.deepEqual((await h.call("list_workspaces", { projectId: "p2" })).structuredContent.entries.map((w) => w.workspaceId), ["sibling"]);
  assert.deepEqual((await h.call("list_agents", { projectId: "p2" })).structuredContent.entries.map((a) => a.agentId), ["sibling-agent"]);
});
