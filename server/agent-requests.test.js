import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./tools.js";
import { createApp } from "./app.js";
import { OAuthStore, PaseoOAuthProvider, SCOPES } from "./oauth.js";
import { presentRequest, pendingRequestInfo, permissionResponse, requestToken, createAgentResponder } from "./agent-requests.js";

const permission = { id: "req-1", kind: "tool", name: "Shell", title: "Run tests?", input: { command: "npm test", env: { TOKEN: "private-secret" } }, metadata: { token: "private-secret" } };
const question = { id: "q-1", kind: "question", name: "AskUserQuestion", input: { questions: [
  { header: "Colour", question: "Which colour?", options: [{ label: "Red" }, { label: "Blue", description: "Ocean" }], isOther: true },
  { header: "Checks", question: "Which checks?", options: [{ label: "Unit" }, { label: "Integration" }], multiSelect: true, allowOther: true },
] } };
const args = (request, extra = {}) => ({ requestId: request.id, requestToken: requestToken(request), decision: "approve", ...extra });

async function harness(t, { principal: overrides, ...options } = {}) {
  let pending = [structuredClone(permission)], placement = "yes", reads = 0;
  const sent = [];
  const agent = { id: "a", refresh: async () => { reads++; await options.onRefresh?.(reads); return {}; },
    current: () => ({ id: "a", status: "running", workspaceId: placement, pendingPermissions: pending }),
    respondToPermission: async (response) => { sent.push(response); await options.onSend?.(response); pending = pending.filter((r) => r.id !== response.requestId); },
    timeline: { refetch: async () => ({ entries: [] }) },
  };
  const principal = { connectionId: "responses-test", scopes: SCOPES, workspaceIds: ["yes"], ...overrides };
  const server = createMcpServer({ getApi: async () => ({ agents: { ref: () => agent } }) }, { principal, getPrincipal: options.getPrincipal, respondToAgent: options.respondToAgent });
  const client = new Client({ name: "responses-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, sent, setPending: (requests) => { pending = requests; }, move: (value) => { placement = value; },
    get: () => client.callTool({ name: "get_agent", arguments: { agentId: "a", view: "requests" } }),
    call: (values) => client.callTool({ name: "respond_to_agent", arguments: { agentId: "a", ...values } }),
  };
}

test("request presentation provides consent context and stable fingerprints without exporting arbitrary metadata", () => {
  const result = presentRequest(permission);
  assert.equal(result.details.command, "npm test"); assert.equal(result.supported, true);
  assert.ok(!JSON.stringify(result).includes("private-secret"));
  assert.equal(result.requestToken, requestToken({ metadata: permission.metadata, input: permission.input, title: permission.title, name: permission.name, kind: permission.kind, id: permission.id }));
  assert.notEqual(result.requestToken, requestToken({ ...permission, title: "Run something else?" }));
});

test("question forms preserve single/multi choices, descriptions, free text and empty-answer flags", () => {
  const shown = presentRequest(question);
  assert.equal(shown.questions[0].options[1].option, 2);
  assert.equal(shown.questions[0].options[1].description, "Ocean");
  const response = permissionResponse(question, args(question, { decision: "answer", answers: [
    { question: 1, options: [2] }, { question: 2, options: [1, 2], text: "Smoke" },
  ] }));
  assert.equal(response.behavior, "allow");
  assert.deepEqual({ ...response.updatedInput.answers }, { Colour: "Blue", Checks: "Unit, Integration, Smoke" });
  const free = { ...question, input: { questions: [{ header: "Details", question: "More?", options: [], allowEmpty: true }] } };
  assert.equal(permissionResponse(free, args(free, { decision: "answer", answers: [{ question: 1, text: "Free answer" }] })).updatedInput.answers.Details, "Free answer");
  assert.equal(permissionResponse(free, args(free, { decision: "answer", answers: [{ question: 1 }] })).updatedInput.answers.Details, "");
});

test("question validation rejects unknown questions/options, incomplete forms and disallowed text", () => {
  const strict = { ...question, input: { questions: [{ header: "Mode", question: "Mode?", options: [{ label: "A" }, { label: "B" }] }] } };
  for (const answers of [[], [{ question: 2, options: [1] }], [{ question: 1, options: [3] }],
    [{ question: 1, options: [1, 1] }], [{ question: 1, options: [1, 2] }], [{ question: 1, text: "other" }],
    [{ question: 1 }], [{ question: 1, options: [1] }, { question: 1, options: [1] }]]) {
    assert.throws(() => permissionResponse(strict, args(strict, { decision: "answer", answers })));
  }
  assert.throws(() => permissionResponse(question, args(question)), /needs decision=answer/);
  assert.throws(() => permissionResponse(question, args(question, { decision: "answer", answers: [{ question: 1, options: [1], text: "also" }, { question: 2, options: [1] }] })), /either one option/);
});

test("advertised plan/mode actions are validated and preserve allow/deny semantics", () => {
  const request = { ...permission, kind: "plan", actions: [{ id: "implement", label: "Implement", behavior: "allow" }, { id: "dismiss", label: "Dismiss", behavior: "deny" }] };
  assert.deepEqual(permissionResponse(request, args(request, { decision: "select", actionId: "implement" })), { behavior: "allow", selectedActionId: "implement" });
  assert.deepEqual(permissionResponse(request, args(request, { decision: "select", actionId: "dismiss" })), { behavior: "deny", selectedActionId: "dismiss" });
  assert.throws(() => permissionResponse(request, args(request)), /explicit actionId/);
  assert.throws(() => permissionResponse(request, args(request, { actionId: "dismiss" })), /conflicts/);
  assert.throws(() => permissionResponse(request, args(request, { actionId: "invented" })), /Unknown action/);
  assert.throws(() => permissionResponse(request, args(request, { requestToken: "0".repeat(64) })), /changed/);
});

test("unsupported, malformed and oversized requests can be denied but not approved", () => {
  for (const request of [{ ...question, input: { questions: [{ title: "Unknown format" }] } },
    { ...permission, description: "x".repeat(7000) }, { ...permission, actions: [{ id: "a", behavior: "unknown", label: "?" }] },
    { ...question, input: { questions: Array.from({ length: 10 }, (_, i) => ({ header: String(i), question: "x".repeat(3000), options: [] })) } }]) {
    assert.equal(presentRequest(request).supported, false);
    assert.throws(() => permissionResponse(request, args(request)), /unsupported|truncated/);
    assert.equal(permissionResponse(request, args(request, { decision: "deny" })).behavior, "deny");
  }
  const many = pendingRequestInfo({ pendingPermissions: Array.from({ length: 40 }, (_, i) => ({ ...permission, id: String(i) })) });
  assert.equal(many.pendingRequests.length, 10); assert.equal(many.requestsTruncated, true);
});

for (const decision of ["approve", "deny"]) {
  test(`MCP ${decision} sends exactly one current response and retry returns its receipt`, async (t) => {
    const h = await harness(t);
    const request = (await h.get()).structuredContent.pendingRequests[0];
    const response = { requestId: request.requestId, requestToken: request.requestToken, decision };
    const first = await h.call(response);
    assert.equal(first.isError, undefined); assert.equal(first.structuredContent.accepted, true);
    assert.equal(h.sent[0].response.behavior, decision === "approve" ? "allow" : "deny");
    const retry = await h.call(response);
    assert.equal(retry.structuredContent.replayed, true); assert.equal(h.sent.length, 1);
  });
}

test("get_agent requests and wait_for_agent expose the same actionable question; answer resumes waiting", async (t) => {
  const h = await harness(t); h.setPending([question]);
  const get = (await h.get()).structuredContent;
  const wait = (await h.client.callTool({ name: "wait_for_agent", arguments: { agentId: "a" } })).structuredContent;
  assert.deepEqual(wait.pendingRequests, get.pendingRequests); assert.equal(wait.next, "respond_to_agent");
  const result = await h.call(args(question, { decision: "answer", answers: [{ question: 1, text: "Green" }, { question: 2, options: [1] }] }));
  assert.equal(result.structuredContent.accepted, true);
  assert.equal(result.structuredContent.next, "wait_for_agent");
  assert.deepEqual({ ...h.sent[0].response.updatedInput.answers }, { Colour: "Green", Checks: "Unit" });
});

test("stale, conflicting and already-resolved requests do not dispatch", async (t) => {
  const h = await harness(t);
  const stale = args(permission);
  h.setPending([{ ...permission, title: "A different operation" }]);
  assert.equal((await h.call(stale)).isError, true); assert.equal(h.sent.length, 0);
  h.setPending([]);
  assert.equal((await h.call(stale)).structuredContent.status, "already_resolved");
  assert.equal(h.sent.length, 0);
});

test("scope and placement checks block responses and hide pending request content", async (t) => {
  const h = await harness(t); h.move("no");
  assert.equal((await h.get()).isError, true);
  assert.equal((await h.call(args(permission))).isError, true);
  assert.equal(h.sent.length, 0);
  const readOnly = await harness(t, { principal: { scopes: ["paseo:read"] } });
  assert.ok(!(await readOnly.client.listTools()).tools.some((tool) => tool.name === "respond_to_agent"));
  assert.equal((await readOnly.call(args(permission))).isError, true);
});

test("access revocation immediately before dispatch prevents a response", async (t) => {
  let revoked = false;
  const h = await harness(t, { onRefresh: (reads) => { if (reads >= 3) revoked = true; },
    getPrincipal: async () => { if (revoked) throw new Error("private-secret"); return { scopes: SCOPES }; } });
  const result = await h.call(args(permission));
  assert.equal(result.isError, true); assert.equal(h.sent.length, 0);
  assert.ok(!JSON.stringify(result).includes("private-secret"));
});

test("uncertain SDK delivery is sanitized and never automatically resent", async (t) => {
  const h = await harness(t, { onSend: () => { throw new Error("private-secret"); } });
  const first = await h.call(args(permission));
  assert.equal(first.structuredContent.status, "response_uncertain");
  assert.equal(first.structuredContent.accepted, null);
  assert.ok(!JSON.stringify(first).includes("private-secret"));
  const second = await h.call(args(permission));
  assert.equal(second.structuredContent.replayed, true); assert.equal(h.sent.length, 1);
});

test("shared coordinator serializes separate HTTP requests and OAuth connections", async (t) => {
  const store = new OAuthStore(), key = "a".repeat(64), url = "https://mcp.example/";
  const provider = new PaseoOAuthProvider(store, url, key);
  const tokens = ["first", "second"].map((id) => {
    store.data.grants[id] = { id, clientId: id, resource: url, keyHash: provider.keyHash, scopes: SCOPES, workspaceIds: null, expiresAt: Date.now() / 1000 + 1000 };
    return provider.issue(id).access_token;
  });
  let dispatches = 0;
  const agent = { id: "a", refresh: async () => ({}), current: () => ({ id: "a", pendingPermissions: [permission] }),
    respondToPermission: async () => { dispatches++; await new Promise((resolve) => setTimeout(resolve, 10)); } };
  const listener = createApp({ connectionKey: key, publicUrl: url, oauthStore: store, connection: { getApi: async () => ({ agents: { ref: () => agent } }) } }).listen(0, "127.0.0.1");
  await once(listener, "listening");
  t.after(() => { listener.closeAllConnections(); return new Promise((resolve) => listener.close(resolve)); });
  const call = async (token, values) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "respond_to_agent", arguments: { agentId: "a", ...values } } }) });
    return (await response.json()).result;
  };
  const results = await Promise.all(tokens.map((token) => call(token, args(permission))));
  assert.equal(dispatches, 1); assert.ok(results.some((r) => r.structuredContent.replayed));
  const conflict = await call(tokens[0], args(permission, { decision: "deny" }));
  assert.equal(conflict.isError, true); assert.equal(dispatches, 1);
});

test("a pending request that changes during preflight is not answered", async () => {
  let reads = 0, sends = 0;
  const respond = createAgentResponder();
  await assert.rejects(respond({ agentId: "a", args: args(permission), authorize: async () => {}, read: async () => {
    reads++;
    return { current: () => ({ pendingPermissions: [{ ...permission, title: reads > 1 ? "Changed" : permission.title }] }), respondToPermission: async () => { sends++; } };
  } }), /changed/);
  assert.equal(sends, 0);
});
