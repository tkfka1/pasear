import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { OAuthStore, PaseoOAuthProvider, SCOPES } from "./oauth.js";

const publicUrl = "https://paseo.example/mcp";
const redirectUri = "https://client.example/callback";
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const connectionKey = "a".repeat(64);
async function harness(t, api = {}, cancelAgent, configuredPublicUrl = publicUrl, throughProxy = false) {
  const publicUrl = configuredPublicUrl;
  const store = new OAuthStore();
  const listener = createApp({ connectionKey, publicUrl, oauthStore: store, connection: { getApi: async () => api }, cancelAgent }).listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  const proxyRequests = [];
  let port = listener.address().port;
  if (throughProxy) {
    const upstreamPort = port;
    const proxy = createServer((req, res) => {
      proxyRequests.push(req.url.split("?")[0]);
      const upstream = httpRequest({ hostname: "127.0.0.1", port: upstreamPort, path: req.url, method: req.method,
        headers: { ...req.headers, host: new URL(publicUrl).host, "x-forwarded-proto": "https" },
      }, (response) => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
      upstream.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    }).listen(0, "127.0.0.1");
    await once(proxy, "listening");
    t.after(() => { proxy.closeAllConnections(); return new Promise((resolve) => proxy.close(resolve)); });
    port = proxy.address().port;
  }
  const base = `http://127.0.0.1:${port}`;
  const request = (path, options) => fetch(new URL(new URL(path, base).pathname + new URL(path, base).search, base), { redirect: "manual", ...options });
  const form = (path, params) => request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(publicUrl).origin }, body: new URLSearchParams(params) });
  async function register(extra = {}) {
    const response = await request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Web chat test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", ...extra }) });
    return { response, client: await response.json() };
  }
  async function begin(client, extra = {}, admit = true) {
    const proof = pkce();
    const response = await request("/authorize?" + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", code_challenge_method: "S256", code_challenge: proof.challenge, resource: publicUrl, state: "roundtrip-state", ...extra }));
    const flowUrl = response.headers.get("location");
    let csrf;
    if (response.status === 303 && flowUrl?.includes("/oauth/flow/")) {
      const html = await (await request(flowUrl)).text();
      csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
      if (admit) assert.equal((await form(flowUrl, { csrf, connection_key: connectionKey })).status, 303);
    }
    return { response, proof, flowUrl, csrf };
  }
  async function authorize({ workspaceIds = null, extra = {} } = {}) {
    const { client } = await register();
    const start = await begin(client, extra);
    assert.equal(start.response.status, 303);
    const pending = store.snapshot().pending.at(-1);
    store.decide(pending.id, true, workspaceIds);
    const redirect = await request(start.flowUrl);
    const url = new URL(redirect.headers.get("location"));
    assert.equal(url.searchParams.get("state"), "roundtrip-state");
    const params = { client_id: client.client_id, grant_type: "authorization_code", code: url.searchParams.get("code"), code_verifier: start.proof.verifier, redirect_uri: redirectUri, resource: extra.resource ?? publicUrl };
    const response = await form("/token", params);
    assert.equal(response.status, 200);
    return { client, params, tokens: await response.json(), grant: store.snapshot().connections.at(-1) };
  }
  async function call(token, name, args = {}, path = "/mcp") {
    const response = await request(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }) });
    return { status: response.status, body: await response.json() };
  }
  return { store, request, form, register, begin, authorize, call, proxyRequests };
}

for (const configuredPublicUrl of ["https://paseo.example", "https://paseo.example/", publicUrl]) {
  test(`root and /mcp share authenticated MCP and OAuth discovery for ${configuredPublicUrl}`, async (t) => {
    const h = await harness(t, {}, undefined, configuredPublicUrl, true);
    for (const path of ["/", "/mcp"]) {
      const unauthorized = await h.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "not JSON" });
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers.get("location"), null);
      const metadataUrl = unauthorized.headers.get("www-authenticate").match(/resource_metadata="([^"]+)"/)[1];
      const metadata = await (await h.request(metadataUrl)).json();
      assert.equal(metadata.resource, new URL(configuredPublicUrl).href);
      assert.deepEqual(metadata.authorization_servers, ["https://paseo.example/"]);
    }
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      assert.equal((await (await h.request(path)).json()).resource, new URL(configuredPublicUrl).href);
    }
    const metadata = await (await h.request("/.well-known/oauth-authorization-server")).json();
    assert.equal(metadata.authorization_endpoint, "https://paseo.example/authorize");
    assert.equal(metadata.token_endpoint, "https://paseo.example/token");
    assert.equal((await h.request("/unknown")).status, 404);
    assert.equal((await h.request("/mcp/unknown")).status, 404);

    for (const resource of ["https://paseo.example/", publicUrl]) {
      const { tokens, client, grant } = await h.authorize({ extra: { resource } });
      assert.equal(h.store.data.grants[grant.id].resource, resource);
      for (const path of ["/", "/mcp"]) {
        const response = await h.request(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "root-test", version: "1" } } }) });
        assert.equal(response.status, 200);
        assert.ok((await response.json()).result.serverInfo);
        assert.equal((await h.call(tokens.access_token, "tools/list", {}, path)).body.result.tools.length, 10);
        const unsupported = await h.request(path, { headers: { authorization: `Bearer ${tokens.access_token}` } });
        assert.equal(unsupported.status, 405);
        assert.equal(unsupported.headers.get("allow"), "POST");
      }
      const mismatch = await h.form("/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource: resource === publicUrl ? "https://paseo.example/" : publicUrl });
      assert.equal(mismatch.status, 400);
      const refresh = await h.form("/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource });
      assert.equal(refresh.status, 200);
      const renewed = await refresh.json();
      h.store.revoke(grant.id);
      for (const path of ["/", "/mcp"]) assert.equal((await h.call(renewed.access_token, "tools/list", {}, path)).status, 401);
    }
    const { client } = await h.register();
    for (const resource of ["https://other.example/", "https://paseo.example/unrelated"]) {
      const denied = await h.begin(client, { resource });
      assert.equal(new URL(denied.response.headers.get("location")).searchParams.get("error"), "invalid_target");
    }
    for (const path of ["/", "/mcp", "/register", "/authorize", "/token", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) assert.ok(h.proxyRequests.includes(path));
    assert.ok(h.proxyRequests.some((path) => path.startsWith("/oauth/flow/")));
  });
}

test("switching the configured path preserves existing grant audiences, scope and refresh tokens", async (t) => {
  const h = await harness(t);
  const { tokens, client, grant } = await h.authorize({ workspaceIds: ["allowed"] });
  const before = JSON.stringify(h.store.data);
  const rootProvider = new PaseoOAuthProvider(h.store, "https://paseo.example", connectionKey);
  assert.equal(JSON.stringify(h.store.data), before);
  const info = await rootProvider.verifyAccessToken(tokens.access_token);
  assert.equal(info.resource.href, publicUrl);
  assert.deepEqual(info.extra.workspaceIds, ["allowed"]);
  const renewed = await rootProvider.exchangeRefreshToken(client, tokens.refresh_token, undefined, new URL(publicUrl));
  assert.equal((await h.call(renewed.access_token, "tools/list", {}, "/")).status, 200);
  assert.equal(h.store.data.grants[grant.id].resource, publicUrl);
});

test("OAuth discovery advertises the configured HTTPS resource behind a proxy", async (t) => {
  const h = await harness(t);
  const unauthorized = await h.request("/mcp");
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /https:\/\/paseo.example\/\.well-known\/oauth-protected-resource\/mcp/);
  const resource = await (await h.request("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(resource.resource, publicUrl);
  const metadata = await (await h.request("/.well-known/oauth-authorization-server", { headers: { "x-forwarded-host": "evil.example" } })).json();
  assert.equal(metadata.authorization_endpoint, "https://paseo.example/authorize");
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.ok(metadata.registration_endpoint);
  assert.ok(metadata.revocation_endpoint);
});

test("authorization waits for explicit Paseo consent and escapes untrusted client labels", async (t) => {
  const h = await harness(t);
  const { client } = await h.register({ client_name: "<script>bad()</script>" });
  const start = await h.begin(client);
  const waiting = await h.request(start.flowUrl);
  assert.equal(waiting.status, 200);
  const html = await waiting.text();
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>bad"));
  assert.equal(h.store.snapshot().connections.length, 0);
  assert.equal(h.store.codes.size, 0);
  assert.equal((await h.request("/oauth/approve", { method: "POST" })).status, 404);
  const pending = h.store.snapshot().pending[0];
  assert.throws(() => h.store.decide(pending.id, true, []), /워크스페이스/);
  h.store.decide(pending.id, false, []);
  const denied = new URL((await h.request(start.flowUrl)).headers.get("location"));
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("state"), "roundtrip-state");
});

test("DCR rejects unsafe redirects, unsupported auth and unknown scopes", async (t) => {
  const h = await harness(t);
  for (const redirect of ["http://evil.example/callback", "javascript:alert(1)", "https://client.example/cb#fragment", "https://user:pass@client.example/cb"]) {
    assert.equal((await h.register({ redirect_uris: [redirect] })).response.status, 400);
  }
  assert.equal((await h.register({ token_endpoint_auth_method: "client_secret_basic" })).response.status, 400);
  assert.equal((await h.register({ scope: "host:root" })).response.status, 400);
});

test("new connections have one task-control permission and reject partial requests before key admission", async (t) => {
  const h = await harness(t);
  const { client } = await h.register();
  for (const scope of ["paseo:read", "paseo:read paseo:write", "paseo:read paseo:cancel"]) {
    const start = await h.begin(client, { scope });
    assert.equal(new URL(start.response.headers.get("location")).searchParams.get("error"), "invalid_scope");
    assert.equal(h.store.admissions.size, 0);
    assert.equal(h.store.pending.size, 0);
  }
  const approved = await h.authorize({ extra: { scope: SCOPES.join(" ") }, workspaceIds: ["yes"] });
  assert.deepEqual([...approved.grant.scopes].sort(), [...SCOPES].sort());
  assert.equal((await h.call(approved.tokens.access_token, "tools/list")).body.result.tools.length, 10);
  const challenge = (await h.request("/mcp")).headers.get("www-authenticate");
  assert.ok(challenge.includes('scope="paseo:read paseo:write paseo:cancel"'));
});

test("owner consent cannot approve a manually injected partial-scope request", async (t) => {
  const h = await harness(t);
  const { client } = await h.register();
  await h.begin(client);
  const pending = [...h.store.pending.values()][0];
  pending.params.scopes = ["paseo:read"];
  assert.throws(() => h.store.decide(pending.id, true, null), /작업 제어/);
  assert.equal(h.store.snapshot().connections.length, 0);
  assert.equal(pending.decision, "pending");
});

test("PKCE, exact callback, resource audience and one-time code are enforced", async (t) => {
  const h = await harness(t);
  const { client } = await h.register();
  const start = await h.begin(client);
  h.store.decide(h.store.snapshot().pending[0].id, true, null);
  const code = new URL((await h.request(start.flowUrl)).headers.get("location")).searchParams.get("code");
  const params = { client_id: client.client_id, grant_type: "authorization_code", code, code_verifier: start.proof.verifier, redirect_uri: redirectUri, resource: publicUrl };
  for (const patch of [{ code_verifier: pkce().verifier }, { redirect_uri: "https://other.example/cb" }, { resource: "https://other.example/mcp" }]) {
    assert.equal((await h.form("/token", { ...params, ...patch })).status, 400);
  }
  assert.equal((await h.form("/token", params)).status, 200);
  assert.equal((await h.form("/token", params)).status, 400);
  const wrongResource = await h.begin(client, { resource: "https://other.example/mcp" });
  assert.equal(new URL(wrongResource.response.headers.get("location")).searchParams.get("error"), "invalid_target");
});

test("previously approved tokens gain task control without reconnecting and keep workspace boundaries", async (t) => {
  let sends = 0, timelineReads = 0, providerReads = 0;
  const h = await harness(t, {
    workspaces: { list: async () => ({ entries: [{ id: "yes", name: "Allowed" }, { id: "no", name: "Private" }], pageInfo: {} }), ref: (id) => ({ refresh: async () => ({ id }), directory: "/allowed" }) },
    agents: { list: async () => ({ entries: [{ agent: { id: "a", workspaceId: "yes" } }, { agent: { id: "b", workspaceId: "no" } }], pageInfo: {} }), ref: (id) => ({ id, current: () => ({ id, workspaceId: id === "a" ? "yes" : "no" }), refresh: async () => ({ agent: { id } }), send: async () => { sends++; }, timeline: { refetch: async () => { timelineReads++; return { entries: [] }; } } }) },
    providers: { snapshot: async () => { providerReads++; return { entries: [] }; } },
  });
  const { tokens, grant, client } = await h.authorize({ workspaceIds: ["yes"] });
  // Model the pre-unification policy, then start the provider over the same state.
  delete h.store.data.grants[grant.id].controlPermissionVersion;
  h.store.data.grants[grant.id].scopes = ["paseo:read"];
  for (const kind of ["access", "refresh"]) for (const entry of Object.values(h.store.data[kind])) if (entry.grantId === grant.id) entry.scopes = ["paseo:read"];
  new PaseoOAuthProvider(h.store, publicUrl, connectionKey);
  const tools = (await h.call(tokens.access_token, "tools/list")).body.result.tools;
  assert.equal(tools.length, 10);
  assert.deepEqual((await h.call(tokens.access_token, "list_workspaces")).body.result.structuredContent.entries.map((w) => w.workspaceId), ["yes"]);
  assert.deepEqual((await h.call(tokens.access_token, "list_agents")).body.result.structuredContent.entries.map((a) => a.agentId), ["a"]);
  assert.equal((await h.call(tokens.access_token, "get_agent", { agentId: "b" })).body.result.isError, true);
  assert.equal((await h.call(tokens.access_token, "list_providers", { cwd: "/private" })).body.result.isError, true);
  assert.equal((await h.call(tokens.access_token, "list_providers", { workspaceId: "yes" })).body.result.isError, undefined);
  assert.equal((await h.call(tokens.access_token, "send_agent_prompt", { agentId: "a", prompt: "Continue", messageId: "upgrade-test" })).body.result.structuredContent.accepted, true);
  assert.equal((await h.call(tokens.access_token, "send_agent_prompt", { agentId: "b", prompt: "Private", messageId: "upgrade-deny" })).body.result.isError, true);
  const refreshed = await h.form("/token", { client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token, scope: "paseo:read" });
  assert.equal(refreshed.status, 200);
  assert.deepEqual((await refreshed.json()).scope.split(" ").sort(), [...SCOPES].sort());
  assert.equal(providerReads, 1); assert.equal(timelineReads, 0); assert.equal(sends, 1);
});

test("scoped control denies raw cwd placement and agent ID access outside allowed workspaces", async (t) => {
  let creates = 0, stops = 0;
  const h = await harness(t, {
    agents: { create: async () => { creates++; }, ref: (id) => ({ id, current: () => ({ id, workspaceId: "no" }), refresh: async () => ({ agent: { id } }) }) },
    workspaces: { ref: () => ({ agents: { create: async () => { creates++; } } }) },
  }, async () => { stops++; });
  const { tokens } = await h.authorize({ workspaceIds: ["yes"] });
  for (const placement of [{ cwd: "/outside" }, { workspaceId: "no" }]) {
    const result = await h.call(tokens.access_token, "create_agent", { provider: "codex/model", title: "Task", prompt: "Work", requestKey: "same", ...placement });
    assert.equal(result.body.result.isError, true);
  }
  assert.equal((await h.call(tokens.access_token, "cancel_agent", { agentId: "outside" })).body.result.isError, true);
  assert.equal(creates, 0); assert.equal(stops, 0);
});

test("control cancellation targets the refreshed exact agent ID and keeps history", async (t) => {
  const stopped = [];
  const h = await harness(t, { agents: { ref: () => ({ id: "exact-agent-id", refresh: async () => ({ agent: { id: "exact-agent-id" } }), current: () => ({ id: "exact-agent-id", workspaceId: "yes", status: "running" }) }) } }, async (id) => stopped.push(id));
  const { tokens } = await h.authorize({ workspaceIds: ["yes"] });
  const result = await h.call(tokens.access_token, "cancel_agent", { agentId: "exact-agent-id" });
  assert.equal(result.body.result.structuredContent.cancellationRequested, true);
  assert.deepEqual(stopped, ["exact-agent-id"]);
  assert.deepEqual(h.store.snapshot().events.map((e) => e.tool), ["cancel_agent"]);
});

test("name resolution, default placement and selection choices expose only granted workspaces", async (t) => {
  const visible = { id: "yes", name: "Shop", workspaceDirectory: "/shop" };
  const hidden = { id: "no", name: "private-workspace", workspaceDirectory: "/private" };
  let created = 0, sent = 0;
  const allowedAgent = { id: "visible-agent", title: "Review", workspaceId: "yes" };
  const h = await harness(t, {
    workspaces: {
      list: async () => ({ entries: [hidden, visible] }),
      ref: (id) => ({ id, refresh: async () => id === "yes" ? visible : null, directory: "/shop", agents: {
        create: async (options) => { created++; assert.equal(id, "yes"); return { id: "new", current: () => ({ id: "new", workspaceId: id }) }; },
      } }),
    },
    providers: {
      snapshot: async ({ cwd }) => { assert.equal(cwd, "/shop"); return { entries: [{ provider: "codex", enabled: true, status: "ready" }] }; },
      listModels: async () => ({ models: [{ id: "default", isDefault: true }] }),
    },
    agents: {
      list: async () => ({ entries: [{ agent: { id: "secret-agent", title: "Review", workspaceId: "no" } }, { agent: allowedAgent }] }),
      ref: (id) => ({ id, refresh: async () => id === allowedAgent.id ? { agent: allowedAgent } : null, current: () => allowedAgent, send: async () => { sent++; assert.equal(id, allowedAgent.id); } }),
    },
  });
  const { tokens } = await h.authorize({ workspaceIds: ["yes"] });
  const task = await h.call(tokens.access_token, "create_agent", { prompt: "Investigate login", requestKey: "auto" });
  assert.equal(task.body.result.structuredContent.accepted, true);
  assert.equal(created, 1);
  const followup = await h.call(tokens.access_token, "send_agent_prompt", { agentId: "Review", prompt: "Test it", messageId: "follow" });
  assert.equal(followup.body.result.structuredContent.agentId, allowedAgent.id);
  assert.equal(sent, 1);
  const missing = await h.call(tokens.access_token, "create_agent", { workspaceId: "private-workspace", prompt: "Work", requestKey: "no" });
  assert.equal(missing.body.result.structuredContent.status, "needs_selection");
  assert.deepEqual(missing.body.result.structuredContent.choices, [{ workspaceId: "yes", name: "Shop" }]);
  assert.ok(!JSON.stringify(missing.body).includes("private"));
  assert.equal(created, 1);
});

test("control connections expose all tools with action hints and isolated retry keys", async (t) => {
  const messages = [];
  const h = await harness(t, { agents: { ref: (id) => ({ id, refresh: async () => ({}), current: () => ({ id, workspaceId: "yes" }), send: async (_text, options) => messages.push(options.messageId) }) } });
  const first = await h.authorize();
  const second = await h.authorize();
  const catalogue = (await h.call(second.tokens.access_token, "tools/list")).body.result.tools;
  assert.equal(catalogue.length, 10);
  assert.deepEqual(catalogue.find((tool) => tool.name === "get_agent")._meta.securitySchemes[0].scopes, ["paseo:read"]);
  assert.deepEqual(catalogue.find((tool) => tool.name === "cancel_agent")._meta.securitySchemes[0].scopes, ["paseo:cancel"]);
  assert.equal(catalogue.find((tool) => tool.name === "cancel_agent").annotations.destructiveHint, true);
  assert.equal((await h.call(first.tokens.access_token, "tools/list")).body.result.tools.length, 10);
  for (const tokens of [first.tokens, first.tokens, second.tokens]) {
    const result = await h.call(tokens.access_token, "send_agent_prompt", { agentId: "a", prompt: "Continue", messageId: "same-key" });
    assert.equal(result.body.result.structuredContent.accepted, true);
  }
  assert.equal(messages[0], messages[1]);
  assert.notEqual(messages[0], messages[2]);
});

test("workspace movement or revocation during waiting and timeline fetch cannot leak output", async (t) => {
  let placement = "yes", action = "move-after-wait", grantId, store, timelineReads = 0;
  const h = await harness(t, { agents: { ref: (id) => ({ id,
    refresh: async () => ({}), current: () => ({ id, workspaceId: placement, status: "running" }),
    waitForFinish: async () => { placement = "no"; return { status: "idle", lastMessage: "private-wait-result" }; },
    timeline: { refetch: async () => {
      timelineReads++;
      if (action === "revoke") store.revoke(grantId); else placement = "no";
      return { entries: [{ item: { type: "assistant_message", text: "private-timeline" } }] };
    } },
  }) } });
  store = h.store;
  const { tokens, grant } = await h.authorize({ workspaceIds: ["yes"] });
  grantId = grant.id;
  for (const scenario of ["move-after-wait", "move-after-fetch", "revoke"]) {
    action = scenario; placement = "yes";
    const result = await h.call(tokens.access_token, "get_agent", { agentId: "a", waitSeconds: scenario === "move-after-wait" ? 1 : 0 });
    assert.equal(result.body.result.isError, true);
    assert.ok(!JSON.stringify(result).includes("private-"));
    if (scenario === "move-after-wait") assert.equal(timelineReads, 0);
  }
});

test("refresh rotation rejects replay and revokes every access token in the connection", async (t) => {
  const h = await harness(t);
  const { client, tokens } = await h.authorize();
  const params = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource: publicUrl };
  assert.equal((await h.form("/token", { ...params, scope: "host:admin" })).status, 400);
  const rotated = await h.form("/token", params);
  assert.equal(rotated.status, 200);
  const newer = await rotated.json();
  assert.notEqual(newer.refresh_token, tokens.refresh_token);
  assert.equal((await h.call(newer.access_token, "tools/list")).status, 200);
  assert.equal((await h.form("/token", params)).status, 400);
  assert.equal((await h.call(tokens.access_token, "tools/list")).status, 401);
  assert.equal((await h.call(newer.access_token, "tools/list")).status, 401);
});

test("owner revocation immediately blocks access and token refresh", async (t) => {
  const h = await harness(t);
  const { client, tokens, grant } = await h.authorize();
  h.store.revoke(grant.id);
  assert.equal((await h.call(tokens.access_token, "tools/list")).status, 401);
  assert.equal((await h.form("/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token })).status, 400);
});

test("confidential client secret, token revocation endpoint and expiry boundaries", async (t) => {
  const h = await harness(t);
  const { client } = await h.register({ token_endpoint_auth_method: "client_secret_post" });
  assert.ok(client.client_secret);
  const start = await h.begin(client);
  const pending = h.store.snapshot().pending[0];
  h.store.decide(pending.id, true, null);
  const code = new URL((await h.request(start.flowUrl)).headers.get("location")).searchParams.get("code");
  const params = { client_id: client.client_id, grant_type: "authorization_code", code, code_verifier: start.proof.verifier, redirect_uri: redirectUri };
  assert.equal((await h.form("/token", params)).status, 400);
  assert.equal((await h.form("/token", { ...params, client_secret: "wrong" })).status, 400);
  const tokens = await (await h.form("/token", { ...params, client_secret: client.client_secret })).json();
  assert.equal((await h.call(tokens.access_token, "tools/list")).status, 200);
  assert.equal((await h.form("/revoke", { client_id: client.client_id, client_secret: client.client_secret, token: tokens.access_token })).status, 200);
  assert.equal((await h.call(tokens.access_token, "tools/list")).status, 401);
  const later = await h.begin(client);
  h.store.pending.get(new URL(later.flowUrl).pathname.split("/").at(-1)).expiresAt = 0;
  assert.equal((await h.request(later.flowUrl)).status, 410);
});

test("refresh normalizes cached scopes to task control and rejects unknown scopes without consuming the token", async (t) => {
  const h = await harness(t);
  const { client, tokens } = await h.authorize();
  const params = { client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token };
  for (const scope of ["", "paseo:read paseo:write paseo:cancel host:admin"]) {
    const response = await h.form("/token", { ...params, scope });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_scope");
  }
  let refresh = tokens.refresh_token;
  for (const scope of ["paseo:read", "paseo:read paseo:write", "paseo:cancel", SCOPES.join(" "), undefined]) {
    const response = await h.form("/token", { ...params, refresh_token: refresh, ...(scope === undefined ? {} : { scope }) });
    assert.equal(response.status, 200);
    const full = await response.json();
    assert.equal(full.scope, SCOPES.join(" "));
    assert.equal((await h.call(full.access_token, "tools/list")).body.result.tools.length, 10);
    refresh = full.refresh_token;
  }
});

test("persisted permission migration treats every client equally and preserves token identity and lifetime", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pasear-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OAuthStore(join(dir, "oauth.json"));
  const provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  const connections = [];
  for (const [index, clientName] of ["Claude", "GPT", "Gemini", "Grok", "An unrelated client"].entries()) {
    const id = `connection-${index}`, client = { client_id: `client-${index}` };
    const grant = { id, clientId: client.client_id, clientName, keyHash: createHash("sha256").update(connectionKey).digest("hex"), resource: publicUrl, scopes: [...SCOPES], workspaceIds: ["yes"], createdAt: 100, expiresAt: Math.floor(Date.now() / 1000) + 1000, revoked: false };
    store.data.clients[client.client_id] = client;
    store.data.grants[id] = grant;
    const tokens = provider.issue(id);
    grant.scopes = ["paseo:read"];
    for (const kind of ["access", "refresh"]) for (const entry of Object.values(store.data[kind])) if (entry.grantId === id) entry.scopes = ["paseo:read"];
    connections.push({ id, client, tokens });
  }
  store.persist();
  const before = JSON.parse(readFileSync(store.file, "utf8"));
  const restored = new OAuthStore(store.file);
  const migrated = new PaseoOAuthProvider(restored, publicUrl, connectionKey);
  const after = JSON.parse(readFileSync(store.file, "utf8"));
  for (const { id, tokens } of connections) {
    assert.deepEqual((await migrated.verifyAccessToken(tokens.access_token)).scopes, SCOPES);
    assert.deepEqual(after.grants[id], { ...before.grants[id], scopes: SCOPES, controlPermissionVersion: 1 });
  }
  assert.deepEqual(after.clients, before.clients);
  for (const kind of ["access", "refresh"]) {
    assert.deepEqual(Object.keys(after[kind]), Object.keys(before[kind]));
    for (const key of Object.keys(before[kind])) assert.deepEqual(after[kind][key], { ...before[kind][key], scopes: SCOPES });
  }
  const persisted = readFileSync(store.file, "utf8");
  new PaseoOAuthProvider(restored, publicUrl, connectionKey);
  assert.equal(readFileSync(store.file, "utf8"), persisted);
  const { client, tokens } = connections[0];
  const refreshed = await migrated.exchangeRefreshToken(client, tokens.refresh_token);
  assert.equal(refreshed.scope, SCOPES.join(" "));
  await assert.rejects(migrated.exchangeRefreshToken(client, tokens.refresh_token), /reuse/);
  await assert.rejects(migrated.verifyAccessToken(refreshed.access_token));
});

test("permission migration cannot revive expired, revoked, unverified or mismatched credentials", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pasear-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OAuthStore(join(dir, "oauth.json"));
  const provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  const fixtures = [];
  for (const reason of ["revoked", "expired-grant", "expired-token", "wrong-resource", "wrong-key", "unverified", "unknown-scope", "used-refresh"]) {
    const client = { client_id: reason };
    const grant = { id: reason, clientId: reason, keyHash: createHash("sha256").update(connectionKey).digest("hex"), resource: publicUrl, scopes: [...SCOPES], workspaceIds: null, createdAt: 100, expiresAt: Math.floor(Date.now() / 1000) + 1000, revoked: false };
    store.data.grants[reason] = grant;
    const tokens = provider.issue(reason);
    grant.scopes = ["paseo:read"];
    const access = store.data.access[createHash("sha256").update(tokens.access_token).digest("hex")];
    const refresh = store.data.refresh[createHash("sha256").update(tokens.refresh_token).digest("hex")];
    access.scopes = refresh.scopes = ["paseo:read"];
    if (reason === "revoked") grant.revoked = true;
    if (reason === "expired-grant") grant.expiresAt = 0;
    if (reason === "expired-token") access.expiresAt = refresh.expiresAt = 0;
    if (reason === "wrong-resource") grant.resource = "https://other.example/mcp";
    if (reason === "wrong-key") grant.keyHash = "b".repeat(64);
    if (reason === "unverified") delete grant.keyHash;
    if (reason === "unknown-scope") grant.scopes = ["host:root"];
    if (reason === "used-refresh") refresh.used = true;
    fixtures.push({ reason, client, tokens });
  }
  store.persist();
  const restored = new OAuthStore(store.file), migrated = new PaseoOAuthProvider(restored, publicUrl, connectionKey);
  for (const { reason, client, tokens } of fixtures) {
    if (reason !== "used-refresh") await assert.rejects(migrated.verifyAccessToken(tokens.access_token));
    await assert.rejects(migrated.exchangeRefreshToken(client, tokens.refresh_token));
    if (reason === "used-refresh") await assert.rejects(migrated.verifyAccessToken(tokens.access_token));
  }
});

test("editing workspace and agent access applies to existing tokens, exact names and creation", async (t) => {
  let sent = [], stopped = [], timelineReads = 0, creates = 0;
  const agents = [{ id: "a", title: "Shared", workspaceId: "one" }, { id: "b", title: "Shared", workspaceId: "one" }, { id: "c", title: "Private", workspaceId: "two" }];
  const h = await harness(t, {
    workspaces: {
      list: async () => ({ entries: [{ id: "one", name: "One" }, { id: "two", name: "Two" }] }),
      ref: (id) => ({ id, directory: `/repo/${id}`, refresh: async () => ({ id }), agents: { create: async () => { creates++; return { id: "new", current: () => ({ id: "new", workspaceId: id }) }; } } }),
    },
    agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })) }), ref: (id) => ({ id,
      refresh: async () => agents.find((a) => a.id === id) || null, current: () => agents.find((a) => a.id === id),
      send: async () => sent.push(id), timeline: { refetch: async () => { timelineReads++; return { entries: [] }; } },
    }) },
  }, async (id) => stopped.push(id));
  const { grant, client, tokens } = await h.authorize();
  h.store.updateAccess(grant.id, ["one"], ["a"], 0);
  assert.deepEqual((await h.call(tokens.access_token, "list_agents")).body.result.structuredContent.entries.map((a) => a.agentId), ["a"]);
  assert.deepEqual((await h.call(tokens.access_token, "list_workspaces")).body.result.structuredContent.entries.map((a) => a.workspaceId), ["one"]);
  for (const name of ["get_agent", "send_agent_prompt", "cancel_agent"]) {
    const denied = await h.call(tokens.access_token, name, { agentId: "b", prompt: "Continue", messageId: "denied" });
    assert.equal(denied.body.result.isError, true);
  }
  assert.equal(timelineReads, 0);
  const accepted = await h.call(tokens.access_token, "send_agent_prompt", { agentId: "Shared", prompt: "Continue", messageId: "allowed" });
  assert.equal(accepted.body.result.structuredContent.agentId, "a");
  await h.call(tokens.access_token, "cancel_agent", { agentId: "a" });
  assert.deepEqual(sent, ["a"]); assert.deepEqual(stopped, ["a"]);
  assert.equal((await h.call(tokens.access_token, "create_agent", { workspaceId: "one", provider: "codex/model", prompt: "New", requestKey: "new" })).body.result.isError, true);
  assert.equal(creates, 0);
  const provider = new PaseoOAuthProvider(h.store, publicUrl, connectionKey);
  const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token);
  assert.deepEqual((await provider.verifyAccessToken(refreshed.access_token)).extra.agentIds, ["a"]);
  h.store.updateAccess(grant.id, ["one"], null, 1);
  assert.deepEqual((await h.call(tokens.access_token, "list_agents")).body.result.structuredContent.entries.map((a) => a.agentId), ["a", "b"]);
  const created = (await h.call(tokens.access_token, "create_agent", { workspaceId: "one", provider: "codex/model", prompt: "New", requestKey: "new" })).body.result;
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.equal(created.structuredContent.accepted, true);
  assert.equal(creates, 1);
});

test("access edits during waits and timeline fetches cannot disclose the old scope", async (t) => {
  let grantId, store, stage, timelineReads = 0;
  const h = await harness(t, { agents: { ref: (id) => ({ id, current: () => ({ id, workspaceId: "yes", status: "running" }), refresh: async () => ({}),
    waitForFinish: async () => { if (stage === "wait") store.updateAccess(grantId, ["no"], null, 0); return { status: "idle" }; },
    timeline: { refetch: async () => { timelineReads++; store.updateAccess(grantId, ["no"], null, 0); return { entries: [{ item: { type: "assistant_message", text: "private-scope-output" } }] }; } },
  }) } });
  store = h.store;
  for (const view of ["summary", "messages", "activity"]) for (stage of ["wait", "timeline"]) {
    timelineReads = 0;
    const { grant, tokens } = await h.authorize({ workspaceIds: ["yes"] }); grantId = grant.id;
    const result = await h.call(tokens.access_token, "get_agent", { agentId: "a", view, waitSeconds: stage === "wait" ? 1 : 0 });
    assert.equal(result.body.result.isError, true);
    assert.ok(!JSON.stringify(result).includes("private-scope-output"));
    if (stage === "wait") assert.equal(timelineReads, 0);
  }
});

test("access edits before sends and while preparing selection results block stale writes and choices", async (t) => {
  let grantId, store, stage, sends = 0;
  const change = () => store.updateAccess(grantId, ["new"], ["new-agent"], 0);
  const h = await harness(t, {
    agents: { ref: (id) => ({ id, current: () => ({ id, workspaceId: "old" }), refresh: async () => { change(); return {}; }, send: async () => sends++ }) },
    workspaces: { list: async () => { change(); return { entries: [{ id: "old", name: "private-old-choice" }, { id: "other", name: "private-other-choice" }] }; } },
  });
  store = h.store;
  for (stage of ["send", "selection"]) {
    const { grant, tokens } = await h.authorize(); grantId = grant.id;
    const result = stage === "send"
      ? await h.call(tokens.access_token, "send_agent_prompt", { agentId: "a", prompt: "Work", messageId: "racy" })
      : await h.call(tokens.access_token, "create_agent", { prompt: "Work", requestKey: "racy" });
    assert.equal(result.body.result.isError, true);
    assert.ok(!JSON.stringify(result).includes("private-"));
  }
  assert.equal(sends, 0);
});

test("access edits persist without changing tokens and reject stale, invalid and revoked updates", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pasear-access-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OAuthStore(join(dir, "oauth.json")), provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  store.data.grants.example = { id: "example", clientId: "web", clientName: "Web", keyHash: provider.keyHash, resource: publicUrl, scopes: SCOPES, workspaceIds: null, createdAt: 100, expiresAt: Math.floor(Date.now() / 1000) + 1000, revoked: false };
  const tokens = provider.issue("example");
  const before = JSON.parse(readFileSync(store.file, "utf8"));
  store.updateAccess("example", ["w", "w"], ["a", "a"], 0);
  assert.throws(() => store.updateAccess("example", null, null, 0), /다른 곳/);
  assert.throws(() => store.updateAccess("example", [], null, 1), /대상/);
  assert.throws(() => store.updateAccess("example", null, [], 1), /대상/);
  const restored = new OAuthStore(store.file), next = new PaseoOAuthProvider(restored, publicUrl, connectionKey);
  const info = await next.verifyAccessToken(tokens.access_token);
  assert.deepEqual(info.extra.workspaceIds, ["w"]); assert.deepEqual(info.extra.agentIds, ["a"]); assert.equal(info.extra.accessRevision, 1);
  const after = JSON.parse(readFileSync(store.file, "utf8"));
  assert.deepEqual(after.access, before.access); assert.deepEqual(after.refresh, before.refresh);
  assert.equal(after.grants.example.expiresAt, before.grants.example.expiresAt);
  restored.revoke("example");
  assert.throws(() => restored.updateAccess("example", null, null, 1), /해제/);
  await assert.rejects(next.verifyAccessToken(tokens.access_token));
});

test("project rules include future workspaces and agents while mixed agent-only branches stay limited", async (t) => {
  let sent = [], stopped = [], created = [];
  const workspaces = [{ id: "w1", name: "One", projectId: "p1", projectDisplayName: "Project One" }, { id: "w2", name: "Two", projectId: "p2" }, { id: "w3", name: "Three", projectId: "p3" }];
  const agents = [{ id: "a1", title: "Same", workspaceId: "w1" }, { id: "a2", title: "Same", workspaceId: "w2" }, { id: "b2", title: "Private", workspaceId: "w2" }, { id: "a3", title: "Private", workspaceId: "w3" }];
  const h = await harness(t, {
    workspaces: { list: async () => ({ entries: workspaces }), ref: (id) => ({ id, get projectId() { return workspaces.find((w) => w.id === id)?.projectId; }, directory: `/repo/${id}`,
      refresh: async () => workspaces.find((w) => w.id === id) || null, agents: { create: async () => { created.push(id); return { id: "new-agent", current: () => ({ id: "new-agent", workspaceId: id }) }; } },
    }) },
    providers: { snapshot: async () => ({ entries: [] }) },
    agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })) }), ref: (id) => ({ id, current: () => agents.find((a) => a.id === id), refresh: async () => agents.find((a) => a.id === id) || null, send: async () => sent.push(id), timeline: { refetch: async () => ({ entries: [] }) } }) },
  }, async (id) => stopped.push(id));
  const { grant, tokens, client } = await h.authorize({ workspaceIds: ["w3"] });
  const rules = [{ kind: "project", id: "p1" }, { kind: "agent", id: "a2", workspaceId: "w2" }];
  h.store.updateAccess(grant.id, null, null, 0, rules);
  let visible = (await h.call(tokens.access_token, "list_workspaces")).body.result.structuredContent.entries;
  assert.deepEqual(visible.map((w) => w.workspaceId), ["w1", "w2"]);
  assert.equal(visible[0].projectId, "p1"); assert.equal(visible[0].projectName, "Project One");
  assert.deepEqual((await h.call(tokens.access_token, "list_agents")).body.result.structuredContent.entries.map((a) => a.agentId), ["a1", "a2"]);
  for (const target of ["b2", "a3"]) {
    for (const name of ["get_agent", "send_agent_prompt", "cancel_agent"]) assert.equal((await h.call(tokens.access_token, name, { agentId: target, prompt: "Work", messageId: "denied" })).body.result.isError, true);
  }
  await h.call(tokens.access_token, "send_agent_prompt", { agentId: "a2", prompt: "Work", messageId: "allowed" });
  await h.call(tokens.access_token, "cancel_agent", { agentId: "a1" });
  for (const workspaceId of ["w2", "w3"]) assert.equal((await h.call(tokens.access_token, "create_agent", { workspaceId, provider: "codex/model", prompt: "Work", requestKey: "no" })).body.result.isError, true);
  assert.equal((await h.call(tokens.access_token, "list_providers", { cwd: "/private" })).body.result.isError, true);
  workspaces.push({ id: "future", name: "Future", projectId: "p1" });
  agents.push({ id: "future-agent", title: "Future task", workspaceId: "future" });
  assert.deepEqual((await h.call(tokens.access_token, "list_agents")).body.result.structuredContent.entries.map((a) => a.agentId), ["a1", "a2", "future-agent"]);
  assert.equal((await h.call(tokens.access_token, "create_agent", { workspaceId: "future", provider: "codex/model", prompt: "Work", requestKey: "new" })).body.result.structuredContent.accepted, true);
  assert.deepEqual(created, ["future"]); assert.deepEqual(sent, ["a2"]); assert.deepEqual(stopped, ["a1"]);
  // Moving an explicitly selected agent to another workspace removes its access.
  agents.find((a) => a.id === "a2").workspaceId = "w3";
  assert.equal((await h.call(tokens.access_token, "get_agent", { agentId: "a2", view: "status" })).body.result.isError, true);
  const provider = new PaseoOAuthProvider(h.store, publicUrl, connectionKey);
  const refresh = await provider.exchangeRefreshToken(client, tokens.refresh_token);
  assert.deepEqual((await provider.verifyAccessToken(refresh.access_token)).extra.accessRules, rules);
  // Project access follows actual current membership, not a workspace list's old metadata.
  workspaces.find((w) => w.id === "w1").projectId = "p3";
  assert.equal((await h.call(tokens.access_token, "get_agent", { agentId: "a1", view: "status" })).body.result.isError, true);
});

test("project movement while fetching results or preparing a write blocks private output and actions", async (t) => {
  let project = "allowed", stage, sent = 0, timelineReads = 0, workspaceReads = 0;
  const h = await harness(t, {
    workspaces: { ref: () => ({ get projectId() { return project; }, refresh: async () => { workspaceReads++; if (stage === "before-send" && workspaceReads >= 2) project = "private"; return {}; } }) },
    agents: { ref: (id) => ({ id, current: () => ({ id, workspaceId: "w" }), refresh: async () => ({}), send: async () => sent++,
      waitForFinish: async () => { if (stage === "wait") project = "private"; return { status: "idle" }; },
      timeline: { refetch: async () => { timelineReads++; project = "private"; return { entries: [{ item: { type: "assistant_message", text: "secret-project-result" } }] }; } },
    }) },
  });
  const { grant, tokens } = await h.authorize();
  h.store.updateAccess(grant.id, null, null, 0, [{ kind: "project", id: "allowed" }]);
  for (const view of ["summary", "messages", "activity"]) for (stage of ["wait", "timeline", "before-send"]) {
    project = "allowed"; workspaceReads = 0; timelineReads = 0;
    const response = stage === "before-send" ? await h.call(tokens.access_token, "send_agent_prompt", { agentId: "a", prompt: "Work", messageId: "m" })
      : await h.call(tokens.access_token, "get_agent", { agentId: "a", view, waitSeconds: stage === "wait" ? 1 : 0 });
    assert.equal(response.body.result.isError, true);
    assert.ok(!JSON.stringify(response).includes("secret-project-result"));
    if (stage === "wait") assert.equal(timelineReads, 0);
  }
  assert.equal(sent, 0);
});

test("hierarchical rules persist without altering old grants and explicit workspace rules include new agents", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pasear-project-access-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OAuthStore(join(dir, "oauth.json")), provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  for (const id of ["old", "new"]) store.data.grants[id] = { id, clientId: id, controlPermissionVersion: 1, keyHash: provider.keyHash, scopes: SCOPES, workspaceIds: ["w"], agentIds: ["a"], resource: publicUrl, createdAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 1000, revoked: false };
  const token = provider.issue("new").access_token; store.persist(); const original = JSON.parse(readFileSync(store.file, "utf8"));
  store.updateAccess("new", null, null, 0, [{ kind: "workspace", id: "w" }]);
  assert.throws(() => store.updateAccess("new", null, null, 1, []), /프로젝트/);
  const restored = new OAuthStore(store.file), next = new PaseoOAuthProvider(restored, publicUrl, connectionKey);
  assert.deepEqual(restored.data.grants.old, original.grants.old);
  assert.deepEqual(restored.data.access, original.access); assert.deepEqual(restored.data.refresh, original.refresh);
  assert.deepEqual((await next.verifyAccessToken(token)).extra.accessRules, [{ kind: "workspace", id: "w" }]);
  const { connectionAccess } = await import("./access.js");
  const access = connectionAccess({}, { accessRules: [{ kind: "workspace", id: "w" }] });
  assert.equal(await access.agent({ id: "brand-new", workspaceId: "w" }), true);
  assert.equal(await access.agent({ id: "other", workspaceId: "private" }), false);
  assert.equal(await access.workspace("w", true), true);
});

test("private persistence stores token hashes and survives process reload and issuer changes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dar-oauth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OAuthStore(join(dir, "oauth.json"));
  const provider = new PaseoOAuthProvider(store, publicUrl, connectionKey);
  store.data.grants.example = { keyHash: createHash("sha256").update(connectionKey).digest("hex"), id: "example", clientId: "web", clientName: "Web", resource: publicUrl, scopes: SCOPES, workspaceIds: ["yes"], createdAt: Date.now() / 1000, expiresAt: Date.now() / 1000 + 1000, revoked: false };
  const tokens = provider.issue("example");
  const raw = readFileSync(store.file, "utf8");
  assert.ok(!raw.includes(tokens.access_token)); assert.ok(!raw.includes(tokens.refresh_token));
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  const restored = new OAuthStore(store.file);
  assert.equal((await new PaseoOAuthProvider(restored, publicUrl, connectionKey).verifyAccessToken(tokens.access_token)).extra.grantId, "example");
  await assert.rejects(new PaseoOAuthProvider(restored, "https://new.example/mcp", connectionKey).verifyAccessToken(tokens.access_token));
  Object.values(restored.data.access)[0].expiresAt = 0;
  await assert.rejects(new PaseoOAuthProvider(restored, publicUrl, connectionKey).verifyAccessToken(tokens.access_token));
});


test("only a correct connection key admits a request, and admission never grants MCP access", async (t) => {
  const h = await harness(t);
  const { client } = await h.register({ client_name: "<img src=x onerror=bad()>" });
  const start = await h.begin(client, {}, false);
  const id = new URL(start.flowUrl).pathname.split("/").at(-1);
  assert.deepEqual(h.store.snapshot().pending, []);
  assert.throws(() => h.store.decide(id, true, null));
  const html = await (await h.request(start.flowUrl)).text();
  assert.ok(html.includes("&lt;img")); assert.ok(!html.includes("<img"));
  assert.ok(!html.includes(connectionKey));
  assert.match((await h.request(start.flowUrl)).headers.get("content-security-policy"), /form-action 'self'/);
  assert.equal((await h.request(start.flowUrl)).headers.get("referrer-policy"), "same-origin");
  for (const connection_key of ["", "b".repeat(64)]) {
    assert.equal((await h.form(start.flowUrl, { csrf: start.csrf, connection_key })).status, 401);
    assert.deepEqual(h.store.snapshot().pending, []);
  }
  assert.equal((await h.form(start.flowUrl, { csrf: start.csrf, connection_key: connectionKey })).status, 303);
  assert.equal(h.store.snapshot().pending.length, 1);
  assert.equal(h.store.codes.size, 0); assert.equal(h.store.snapshot().connections.length, 0);
  assert.equal((await h.call(connectionKey, "tools/list")).status, 401);
  assert.equal((await h.request("/mcp", { headers: { "x-api-key": connectionKey } })).status, 401);
  assert.equal((await h.form(start.flowUrl, { csrf: start.csrf, connection_key: connectionKey })).status, 410);
});

test("key form enforces origin, CSRF, request size, attempt count and expiry", async (t) => {
  const h = await harness(t);
  const { client } = await h.register();
  const start = await h.begin(client, {}, false);
  assert.equal((await h.form(start.flowUrl, { csrf: "wrong", connection_key: connectionKey })).status, 403);
  for (const origin of ["https://evil.example", undefined]) {
    assert.equal((await h.request(start.flowUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) }, body: new URLSearchParams({ csrf: start.csrf, connection_key: connectionKey }) })).status, 403);
  }
  assert.equal((await h.form(start.flowUrl, { csrf: start.csrf, connection_key: "x".repeat(3000) })).status, 413);
  for (let n = 1; n <= 5; n++) assert.equal((await h.form(start.flowUrl, { csrf: start.csrf, connection_key: "wrong" })).status, n === 5 ? 429 : 401);
  assert.equal((await h.request(start.flowUrl)).status, 410);
  const expired = await h.begin(client, {}, false);
  h.store.admissions.get(new URL(expired.flowUrl).pathname.split("/").at(-1)).expiresAt = 0;
  assert.equal((await h.form(expired.flowUrl, { csrf: expired.csrf, connection_key: connectionKey })).status, 410);
  assert.deepEqual(h.store.snapshot().pending, []);
});

test("key rotation revokes access and refresh; old unverified grants are invalidated on reload", async (t) => {
  const h = await harness(t);
  const { tokens, client } = await h.authorize();
  const provider = new PaseoOAuthProvider(h.store, publicUrl, "b".repeat(64));
  await assert.rejects(provider.verifyAccessToken(tokens.access_token));
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token));
  assert.equal((await h.call(tokens.access_token, "tools/list")).status, 401);
  const dir = mkdtempSync(join(tmpdir(), "dar-old-grants-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OAuthStore(join(dir, "oauth.json"));
  store.data.grants.old = { id: "old", revoked: false, expiresAt: Date.now() / 1000 + 1000 };
  store.persist();
  assert.equal(new OAuthStore(store.file).data.grants.old.revoked, true);
});
