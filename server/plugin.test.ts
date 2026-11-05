import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { configSchema, decideConnection } from "../shared/mcp";

test("plugin load keeps the port closed; start uses the injected SDK; unload closes it", async (t) => {
  const previousHome = process.env.PASEO_HOME;
  const temporaryHome = mkdtempSync(join(tmpdir(), "dar-plugin-test-"));
  process.env.PASEO_HOME = temporaryHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    rmSync(temporaryHome, { recursive: true, force: true });
  });
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const config = configSchema.parse({ port, connectionKey: "a".repeat(64), publicUrl: "https://paseo.example/mcp" });
  const handlers = new Map<string, (input: object, context: object) => Promise<any>>();
  let unsubscribeCalled = false;
  let sdkReads = 0;
  const context = {
    paseo: {
      agents: { list: async () => { sdkReads++; return { entries: [], pageInfo: {} }; }, ref: (id: string) => ({ refresh: async () => id === "allowed-agent" || id === "outside-agent" ? {} : null, current: () => ({ id, workspaceId: id === "allowed-agent" ? "allowed" : "outside" }) }) },
      workspaces: { ref: (id: string) => ({ refresh: async () => id === "allowed" ? {} : null }) },
      projects: { list: async () => ({ projects: [{ projectId: "project" }] }) },
    },
  };
  const cleanup = contribute({
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "1", values: config }),
      subscribe: () => () => { unsubscribeCalled = true; },
    }),
    handle: (contract: { name: string }, handler: (input: object, context: object) => Promise<any>) => handlers.set(contract.name, handler),
  } as unknown as PluginServerContext);
  try {
    assert.equal((await handlers.get("mcp.status")!({}, context)).running, false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
    const status = await handlers.get("mcp.start")!({}, context);
    const base = `http://127.0.0.1:${port}`;
    const request = (path: string, options: RequestInit = {}) => fetch(base + new URL(path, base).pathname + new URL(path, base).search, { redirect: "manual", ...options });
    const form = (path: string, params: Record<string, string>) => request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://paseo.example" }, body: new URLSearchParams(params).toString() });
    const client = await (await request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Plugin integration", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" }) })).json() as any;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = await request("/authorize?" + new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: "https://client.example/callback", code_challenge: challenge, code_challenge_method: "S256" }));
    const flowUrl = authorization.headers.get("location")!;
    assert.deepEqual((await handlers.get("mcp.connections")!({}, context)).pending, []);
    const html = await (await request(flowUrl)).text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    assert.equal((await form(flowUrl, { csrf, connection_key: config.connectionKey })).status, 303);
    const pending = (await handlers.get("mcp.connections")!({}, context)).pending[0];
    const approve = (patch: object) => handlers.get("mcp.consent")!({ id: pending.id, allow: true, ...patch }, context);
    for (const patch of [
      {}, { accessRules: [] }, { accessRules: [{ kind: "project", id: "missing" }] },
      { accessRules: [{ kind: "workspace", id: "missing" }] },
      { accessRules: [{ kind: "agent", id: "allowed-agent", workspaceId: "outside" }] },
      { accessRules: [{ kind: "agent", id: "missing-agent", workspaceId: "allowed" }] },
    ]) {
      await assert.rejects(approve(patch));
      const state = await handlers.get("mcp.connections")!({}, context);
      assert.equal(state.pending[0].id, pending.id);
      assert.deepEqual(state.connections, []);
      const waiting = await request(flowUrl);
      assert.equal(waiting.headers.get("location"), null, "invalid approval must not issue an authorization code");
    }
    const approvedRules = [{ kind: "all", id: "*" }];
    await approve({ accessRules: approvedRules });
    const initial = (await handlers.get("mcp.connections")!({}, context)).connections[0];
    assert.deepEqual(initial.accessRules, approvedRules);
    assert.equal(initial.accessRevision, 0);
    const code = new URL((await request(flowUrl)).headers.get("location")!).searchParams.get("code")!;
    const tokens = await (await form("/token", { grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: "https://client.example/callback" })).json() as any;
    assert.ok(tokens.access_token);
    const response = await fetch(status.upstreamUrl, {
      method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_agents", arguments: {} } }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { result: { structuredContent: { entries: unknown[] } } };
    assert.deepEqual(result.result.structuredContent.entries, []);
    assert.equal(sdkReads, 1);
    const connection = (await handlers.get("mcp.connections")!({}, context)).connections[0];
    const update = (patch: object) => handlers.get("mcp.access")!({ id: connection.id, workspaceIds: ["allowed"], agentIds: ["allowed-agent"], accessRevision: 0, ...patch }, context);
    await assert.rejects(update({ workspaceIds: ["missing"] }), /workspace/i);
    await assert.rejects(update({ agentIds: ["missing-agent"] }), /agent/i);
    await assert.rejects(update({ agentIds: ["outside-agent"] }), /workspace/i);
    const saved = (await update({})).connections[0];
    assert.deepEqual(saved.workspaceIds, ["allowed"]);
    assert.deepEqual(saved.agentIds, ["allowed-agent"]);
    assert.equal(saved.accessRevision, 1);
    await assert.rejects(update({ agentIds: null }), /changed elsewhere/);
    await assert.rejects(update({ accessRevision: 1, accessRules: [{ kind: "project", id: "missing" }] }), /project/i);
    await assert.rejects(update({ accessRevision: 1, accessRules: [{ kind: "agent", id: "allowed-agent", workspaceId: "outside" }] }), /workspace/i);
    const hierarchical = await update({ accessRevision: 1, accessRules: [{ kind: "project", id: "project" }] });
    assert.deepEqual(hierarchical.connections[0].accessRules, [{ kind: "project", id: "project" }]);
    assert.equal(hierarchical.connections[0].accessRevision, 2);
  } finally { await cleanup(); }
  assert.equal(unsubscribeCalled, true);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
});

test("two host installations keep listeners, SDK calls and OAuth connections independent", async (t) => {
  const previousHome = process.env.PASEO_HOME;
  const temporaryHome = mkdtempSync(join(tmpdir(), "pasear-hosts-test-"));
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    if (previousHome === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previousHome;
    rmSync(temporaryHome, { recursive: true, force: true });
  });
  async function install(name: string) {
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const config = configSchema.parse({ port, connectionKey: randomBytes(32).toString("hex"), publicUrl: `https://${name}.example/mcp` });
    const handlers = new Map<string, (input: any, context: any) => any>();
    let reads = 0;
    const context = { paseo: { agents: { list: async () => { reads++; return { entries: [], pageInfo: {} }; } } } };
    process.env.PASEO_HOME = join(temporaryHome, name);
    const cleanup = contribute({
      registerSettings: () => ({ read: async () => ({ status: "ready", revision: "1", values: config }), subscribe: () => () => {} }),
      handle: (contract: { name: string }, handler: (input: any, context: any) => any) => handlers.set(contract.name, handler),
    } as unknown as PluginServerContext);
    cleanups.push(cleanup);
    const rpc = (name: string, input = {}) => handlers.get(name)!(input, context);
    const origin = new URL(config.publicUrl).origin;
    const base = `http://127.0.0.1:${port}`;
    const request = (path: string, options: RequestInit = {}) => fetch(new URL(new URL(path, base).pathname + new URL(path, base).search, base), { redirect: "manual", ...options });
    const form = (path: string, values: Record<string, string>) => request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: new URLSearchParams(values).toString() });
    async function authorize() {
      const redirectUri = "https://chat.example/callback";
      const client = await (await request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Same chat name", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) })).json() as any;
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const auth = await request("/authorize?" + new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256" }));
      const flow = auth.headers.get("location")!;
      const html = await (await request(flow)).text();
      const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
      assert.equal((await form(flow, { csrf, connection_key: config.connectionKey })).status, 303);
      const pending = (await rpc("mcp.connections")).pending[0];
      await rpc("mcp.consent", { id: pending.id, allow: true, workspaceIds: null });
      const code = new URL((await request(flow)).headers.get("location")!).searchParams.get("code")!;
      const response = await form("/token", { grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirectUri });
      assert.equal(response.status, 200);
      return (await response.json() as any).access_token as string;
    }
    const list = (token: string) => request("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_agents", arguments: {} } }) });
    return { rpc, request, authorize, list, reads: () => reads, port };
  }
  const a = await install("host-a"), b = await install("host-b");
  assert.notEqual(a.port, b.port);
  assert.equal((await a.rpc("mcp.status")).running, false);
  assert.equal((await b.rpc("mcp.status")).running, false);
  await a.rpc("mcp.start");
  assert.equal((await a.request("/healthz")).status, 200);
  assert.equal((await b.rpc("mcp.status")).running, false);
  await assert.rejects(b.request("/healthz"));
  const tokenA = await a.authorize();
  assert.deepEqual((await b.rpc("mcp.connections")).connections, []);
  await b.rpc("mcp.start");
  const tokenB = await b.authorize();
  const beforeB = await b.rpc("mcp.connections");
  assert.equal((await a.list(tokenA)).status, 200);
  assert.equal(a.reads(), 1);
  assert.equal(b.reads(), 0);
  assert.equal((await b.list(tokenB)).status, 200);
  assert.equal(b.reads(), 1);
  assert.equal((await a.list(tokenB)).status, 401);
  assert.equal((await b.list(tokenA)).status, 401);
  const connectionA = (await a.rpc("mcp.connections")).connections[0];
  await b.rpc("mcp.revoke", { id: connectionA.id });
  assert.deepEqual((await b.rpc("mcp.connections")).connections, beforeB.connections);
  await a.rpc("mcp.access", { id: connectionA.id, accessRevision: 0, workspaceIds: null, agentIds: null, accessRules: [{ kind: "all", id: "*" }] });
  assert.deepEqual((await b.rpc("mcp.connections")).connections, beforeB.connections);
  await a.rpc("mcp.stop");
  assert.equal((await b.rpc("mcp.status")).running, true);
  await assert.rejects(a.request("/healthz"));
  assert.equal((await b.list(tokenB)).status, 200);
  await a.rpc("mcp.start");
  assert.equal((await a.list(tokenA)).status, 200);
  await a.rpc("mcp.revoke", { id: connectionA.id });
  assert.equal((await a.list(tokenA)).status, 401);
  assert.equal((await b.list(tokenB)).status, 200);
  assert.deepEqual((await b.rpc("mcp.connections")).connections, beforeB.connections);
});


test("initial consent RPC requires an explicit nonempty target and preserves legacy clients", () => {
  for (const invalid of [{}, { workspaceIds: [] }, { accessRules: [] }, { accessRules: [{ kind: "all", id: "wrong" }] }, { accessRules: [{ kind: "agent", id: "a" }] }]) {
    assert.equal(decideConnection.input.safeParse({ id: "request", allow: true, ...invalid }).success, false);
  }
  for (const valid of [{ workspaceIds: null }, { workspaceIds: ["w"] }, { accessRules: [{ kind: "project", id: "p" }] }]) {
    assert.equal(decideConnection.input.safeParse({ id: "request", allow: true, ...valid }).success, true);
  }
  assert.equal(decideConnection.input.safeParse({ id: "request", allow: false }).success, true);
});
