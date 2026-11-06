import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "./app.js";
import { OAuthStore, PaseoOAuthProvider, SCOPES } from "./oauth.js";

const connectionKey = "a".repeat(64);
const publicUrl = "https://paseo.example/mcp";

async function harness(t, api) {
  let calls = 0;
  const relay = { async getApi() { calls++; return api; } };
  const oauthStore = new OAuthStore();
  const provider = new PaseoOAuthProvider(oauthStore, publicUrl, connectionKey);
  oauthStore.data.grants.test = { id: "test", clientId: "test", resource: publicUrl, keyHash: provider.keyHash, scopes: SCOPES, workspaceIds: null, expiresAt: Date.now() / 1000 + 1000 };
  const token = provider.issue("test").access_token;
  const listener = createApp({ connectionKey, publicUrl, oauthStore, connection: relay }).listen(0, "127.0.0.1");
  await once(listener, "listening");
  const url = new URL(`http://127.0.0.1:${listener.address().port}/mcp`);
  const client = new Client({ name: "bridge-integration-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  });
  return {
    url, client,
    calls: () => calls,
    connect: () => client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })),
  };
}

test("requires authentication before parsing bodies or contacting the daemon", async (t) => {
  const h = await harness(t, {});
  for (const authorization of [undefined, "Bearer wrong", `Bearer ${connectionKey}`]) {
    const res = await fetch(h.url, {
      method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { authorization } : {}) },
      body: "not json",
    });
    assert.equal(res.status, 401);
  }
  assert.equal(h.calls(), 0);
  assert.equal((await fetch(new URL("/healthz", h.url))).status, 200);
});

test("Claude-compatible MCP initialization and tool discovery do not require a live daemon", async (t) => {
  const h = await harness(t, {});
  await h.connect();
  const { tools } = await h.client.listTools();
  assert.equal(tools.length, 15);
  assert.ok(tools.some(({ name }) => name === "create_agent"));
  assert.ok(tools.some(({ name }) => name === "get_agent"));
  assert.ok(!tools.some(({ name }) => /kill|permission|config/.test(name)));
  assert.equal(h.calls(), 0);
});

test("agent creation returns a receipt and preserves the idempotency key without waiting", async (t) => {
  let request;
  const h = await harness(t, { agents: { async create(options) {
    request = options;
    return { id: "agent-1", current: () => ({ id: "agent-1", status: "running", workspaceId: "ws-1" }) };
  } } });
  await h.connect();
  const result = await h.client.callTool({ name: "create_agent", arguments: {
    provider: "claude/discovered-model", cwd: "/remote/repository", title: "Review", prompt: "Review the diff", requestKey: "request-123",
  } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.agentId, "agent-1");
  assert.equal(result.structuredContent.accepted, true);
  assert.equal(result.structuredContent.status, "running");
  assert.equal(request.cwd, "/remote/repository");
  const firstKey = request.idempotencyKey;
  assert.match(firstKey, /^[a-f0-9]{64}$/);
  await h.client.callTool({ name: "create_agent", arguments: {
    provider: "claude/discovered-model", cwd: "/remote/repository", title: "Review", prompt: "Review the diff", requestKey: "request-123",
  } });
  assert.equal(request.idempotencyKey, firstKey);
  assert.equal(request.config.provider, "claude/discovered-model");
});

test("workspace discovery returns daemon directories and supports the next page cursor", async (t) => {
  let options;
  const h = await harness(t, { workspaces: { list: async (input) => {
    options = input;
    return {
      entries: [{ id: "ws-1", name: "Feature", workspaceDirectory: "/remote/worktree", projectRootPath: "/remote/repo", status: "active" }],
      pageInfo: { nextCursor: "next-page" },
    };
  } } });
  await h.connect();
  const result = await h.client.callTool({ name: "list_workspaces", arguments: { cursor: "current-page" } });
  assert.equal(result.structuredContent.entries[0].directory, "/remote/worktree");
  assert.equal(result.structuredContent.entries[0].workspaceId, "ws-1");
  assert.equal(result.structuredContent.pageInfo.nextCursor, "next-page");
  assert.equal(options.page.cursor, "current-page");
});

test("creating in an existing workspace uses its placement", async (t) => {
  let workspace;
  const h = await harness(t, { workspaces: { ref: (id) => {
    workspace = id;
    return { id, refresh: async () => ({}), directory: "/remote/worktree", agents: { create: async () => ({ id: "agent-1", current: () => null }) } };
  } } });
  await h.connect();
  const result = await h.client.callTool({ name: "create_agent", arguments: {
    provider: "claude/discovered-model", workspaceId: "existing-workspace", title: "Review", prompt: "Review the diff", requestKey: "request-456",
  } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.accepted, true);
  assert.equal(workspace, "existing-workspace");
});

test("follow-ups steer busy agents by default and retain messageId for retries", async (t) => {
  let sent;
  const h = await harness(t, { agents: { ref: (id) => ({
    id, refresh: async () => ({ agent: { id } }),
    send: async (text, options) => { sent = { text, options }; },
  }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "send_agent_prompt", arguments: {
    agentId: "agent-1", prompt: "Focus on tests", messageId: "message-123",
  } });
  assert.equal(result.structuredContent.accepted, true);
  assert.equal(sent.text, "Focus on tests");
  assert.equal(sent.options.activeTurnBehavior, "steer");
  const firstId = sent.options.messageId;
  assert.match(firstId, /^[a-f0-9]{64}$/);
  await h.client.callTool({ name: "send_agent_prompt", arguments: { agentId: "agent-1", prompt: "Focus on tests", messageId: "message-123" } });
  assert.equal(sent.options.messageId, firstId);
});

test("results page messages, preserve cursors and indicate permission requests", async (t) => {
  const startCursor = { epoch: "epoch-1", seq: 10 };
  const endCursor = { epoch: "epoch-1", seq: 12 };
  let query;
  const h = await harness(t, { agents: { ref: (id) => ({
    id, refresh: async () => ({ agent: { id } }),
    current: () => ({ id, status: "waiting", pendingPermissions: [{}] }),
    pendingPermissions: [{}],
    timeline: { refetch: async (options) => {
      query = options;
      return {
        error: null, startCursor, endCursor, hasOlder: true, hasNewer: false, staleCursor: false,
        entries: [
          { item: { type: "assistant_message", text: "Review complete" }, seqStart: 10, seqEnd: 11 },
          { item: { type: "tool_call", input: { private: "do not export tool input" } }, seqStart: 12, seqEnd: 12 },
        ],
      };
    } },
  }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "get_agent", arguments: {
    agentId: "agent-1", view: "messages", direction: "before", cursor: endCursor,
  } });
  assert.equal(result.structuredContent.messages.length, 1);
  assert.equal(result.structuredContent.messages[0].text, "Review complete");
  assert.deepEqual(result.structuredContent.startCursor, startCursor);
  assert.deepEqual(query.cursor, endCursor);
  assert.equal(result.structuredContent.pendingPermissionCount, 1);
  assert.match(result.structuredContent.permissionAction, /Paseo/);
  assert.ok(!JSON.stringify(result).includes("do not export"));
});

test("wait timeout is bounded and does not cancel the task", async (t) => {
  let timeout;
  const h = await harness(t, { agents: { ref: () => ({
    id: "agent-1", refresh: async () => ({ agent: { id: "agent-1" } }),
    current: () => ({ id: "agent-1", status: "running" }),
    waitForFinish: async (ms) => { timeout = ms; return { status: "timeout", lastMessage: null }; },
  }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "get_agent", arguments: { agentId: "agent-1", waitSeconds: 20, view: "status" } });
  assert.equal(result.structuredContent.waitStatus, "timeout");
  assert.equal(timeout, 20_000);
  const invalid = await h.client.callTool({ name: "get_agent", arguments: { agentId: "agent-1", waitSeconds: 600, view: "status" } });
  assert.equal(invalid.isError, true);
});

test("SDK failures cannot leak pairing URLs or daemon credentials", async (t) => {
  const h = await harness(t, { agents: { list: async () => { throw new Error("secret-password https://app.paseo.sh/#offer=secret"); } } });
  await h.connect();
  const result = await h.client.callTool({ name: "list_agents", arguments: {} });
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("secret-password"));
  assert.ok(!JSON.stringify(result).includes("#offer="));
});

test("unknown agent reports an error without sending a prompt", async (t) => {
  const h = await harness(t, { agents: { ref: () => ({ refresh: async () => null }), list: async () => ({ entries: [] }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "send_agent_prompt", arguments: {
    agentId: "missing", prompt: "Do work", messageId: "message-missing",
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/);
});

test("status separates permission/running/idle states and never treats idle as successful completion", async (t) => {
  let state = { id: "agent-1", status: "running", pendingPermissions: [{}] };
  const h = await harness(t, { agents: { ref: () => ({ id: "agent-1", refresh: async () => ({ agent: state }), current: () => state }) } });
  await h.connect();
  const status = async () => (await h.client.callTool({ name: "get_agent", arguments: { agentId: "agent-1", view: "status" } })).structuredContent;
  assert.equal((await status()).workState, "needs_permission");
  state = { id: "agent-1", status: "running" };
  assert.equal((await status()).workState, "running");
  state = { id: "agent-1", status: "idle" };
  assert.equal((await status()).workState, "idle");
  assert.equal((await status()).workState, "idle");
  state = { id: "agent-1", status: "error", lastError: "secret-daemon-credential" };
  assert.equal((await status()).workState, "failed");
  assert.ok(!JSON.stringify(await status()).includes("secret-daemon-credential"));
});

test("activity reports observed edits and tool failures without raw inputs, output or reasoning", async (t) => {
  const h = await harness(t, { agents: { ref: () => ({ id: "a", refresh: async () => ({ agent: { id: "a" } }), current: () => ({ id: "a", status: "running" }), timeline: { refetch: async () => ({ hasOlder: true, entries: [
    { item: { type: "tool_call", name: "write_file", status: "completed", detail: { type: "write", filePath: "/repo/app.ts", content: "private-source" } } },
    { item: { type: "tool_call", name: "run", status: "failed", detail: { type: "shell", command: "private-command", output: "private-output" } } },
    { item: { type: "reasoning", text: "private-reasoning" } },
    { item: { type: "assistant_message", text: "Tests need attention" } },
  ] }) } }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "get_agent", arguments: { agentId: "a" } });
  assert.deepEqual(result.structuredContent.touchedFiles, ["/repo/app.ts"]);
  assert.equal(result.structuredContent.activity[1].status, "failed");
  assert.equal(result.structuredContent.hasOlder, true);
  assert.equal(result.structuredContent.lastMessage.text, "Tests need attention");
  assert.equal(result.structuredContent.workState, "running");
  assert.ok(!JSON.stringify(result).includes("private-"));
});

test("work history pages include every matching action with safe metadata and unchanged SDK cursors", async (t) => {
  const startCursor = { epoch: "history", seq: 20 }, endCursor = { epoch: "history", seq: 40 };
  const entries = Array.from({ length: 12 }, (_, index) => ({
    item: { type: "tool_call", callId: `call-${index}`, name: "edit_file", status: "completed", detail: { type: "edit", filePath: `/repo/file-${index}.ts`, oldString: "private-old", newString: "private-source" }, metadata: { token: "private-metadata" } },
    timestamp: `2026-11-04T00:00:${String(index).padStart(2, "0")}Z`, turnId: "turn-1", seqStart: 20 + index, seqEnd: 20 + index,
  }));
  entries.push(
    { item: { type: "tool_call", callId: "shell", name: "run", status: "failed", error: "private-error", detail: { type: "shell", command: "private-command", output: "private-output", exitCode: 2 } }, seqStart: 32, seqEnd: 32, turnId: "turn-1" },
    { item: { type: "tool_call", name: "read_file", status: "completed", detail: { type: "read", filePath: "/repo/read.ts", content: "private-content" } }, seqStart: 33, seqEnd: 33 },
    { item: { type: "error", message: "private-error-detail" }, seqStart: 34, seqEnd: 34, turnId: "turn-1" },
    { item: { type: "reasoning", text: "private-reasoning" } },
    { item: { type: "assistant_message", text: "private-answer" } },
  );
  let query;
  const h = await harness(t, { agents: { ref: (id) => ({ id, refresh: async () => ({}), current: () => ({ id, status: "idle" }),
    timeline: { refetch: async (options) => { query = options; return { entries, startCursor, endCursor, hasOlder: true, hasNewer: true, reset: true, staleCursor: true, gap: true }; } },
  }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "get_agent", arguments: { agentId: "a", view: "activity", limit: 100, direction: "before", cursor: startCursor } });
  assert.equal(result.isError, undefined);
  const data = result.structuredContent;
  assert.equal(data.activity.length, 15);
  assert.equal(data.scannedEntries, 17);
  assert.deepEqual(query, { limit: 100, direction: "before", cursor: startCursor });
  assert.deepEqual(data.activity[0], { type: "tool_call", name: "edit_file", status: "completed", timestamp: entries[0].timestamp, callId: "call-0", action: "edit", turnId: "turn-1", seqStart: 20, seqEnd: 20, filePath: "/repo/file-0.ts" });
  assert.equal(data.activity[12].exitCode, 2);
  assert.equal(data.activity[13].filePath, "/repo/read.ts");
  assert.match(data.activity[14].message, /Paseo/);
  assert.equal(data.touchedFiles.length, 12);
  assert.ok(!data.touchedFiles.includes("/repo/read.ts"));
  for (const key of ["hasOlder", "hasNewer", "reset", "staleCursor", "gap"]) assert.equal(data[key], true);
  assert.deepEqual(data.startCursor, startCursor); assert.deepEqual(data.endCursor, endCursor);
  assert.ok(!JSON.stringify(result).includes("private-"));
});

test("conversation and activity traverse empty filtered pages and keep their content separate", async (t) => {
  const first = { epoch: "history", seq: 1 }, second = { epoch: "history", seq: 2 };
  let query;
  const h = await harness(t, { agents: { ref: (id) => ({ id, refresh: async () => ({}), current: () => ({ id }),
    timeline: { refetch: async (options) => {
      query = options;
      const messages = [
        { item: { type: "user_message", text: "조사해줘" }, timestamp: "2026-11-04T00:00:00Z", turnId: "turn", seqStart: 1, seqEnd: 1 },
        { item: { type: "assistant_message", text: "조사 결과입니다" }, timestamp: "2026-11-04T00:00:01Z", turnId: "turn", seqStart: 2, seqEnd: 2 },
      ];
      const tools = [{ item: { type: "tool_call", name: "check", status: "completed", detail: { type: "shell", command: "private-command", output: "private-output", exitCode: 0 } }, seqStart: 2, seqEnd: 2 }];
      return { entries: options.cursor ? messages : tools, startCursor: first, endCursor: second, hasOlder: !options.cursor, hasNewer: !!options.cursor };
    } },
  }) } });
  await h.connect();
  const call = (args) => h.client.callTool({ name: "get_agent", arguments: { agentId: "a", ...args } });
  const emptyMessages = (await call({ view: "messages", limit: 1 })).structuredContent;
  assert.deepEqual(emptyMessages.messages, []); assert.equal(emptyMessages.scannedEntries, 1); assert.equal(emptyMessages.hasOlder, true);
  const older = (await call({ view: "messages", direction: "before", cursor: emptyMessages.startCursor })).structuredContent;
  assert.deepEqual(older.messages.map(({ text }) => text), ["조사해줘", "조사 결과입니다"]);
  assert.equal(older.messages[0].turnId, "turn"); assert.equal(older.messages[0].seqStart, 1);
  assert.ok(!JSON.stringify(older).includes("private-")); assert.equal(older.activity, undefined);
  const emptyActivity = (await call({ view: "activity", direction: "after", cursor: older.endCursor })).structuredContent;
  assert.deepEqual(emptyActivity.activity, []); assert.equal(emptyActivity.scannedEntries, 2); assert.equal(emptyActivity.hasNewer, true);
  assert.deepEqual(query, { limit: 30, direction: "after", cursor: second }); assert.equal(emptyActivity.messages, undefined);
  const latest = (await call({ view: "activity" })).structuredContent;
  assert.equal(latest.activity[0].exitCode, 0); assert.equal(latest.hasOlder, true);
});

test("work history reports unavailable timelines without exporting SDK errors", async (t) => {
  const h = await harness(t, { agents: { ref: (id) => ({ id, refresh: async () => ({}), current: () => ({ id }),
    timeline: { refetch: async () => ({ error: "private-sdk-error", entries: [] }) },
  }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "get_agent", arguments: { agentId: "a", view: "activity" } });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /timeline/i);
  assert.ok(!JSON.stringify(result).includes("private-sdk-error"));
});

test("a short task request resolves the only accessible workspace and default model", async (t) => {
  let created;
  const workspace = { id: "ws-1", name: "상점", workspaceDirectory: "/repo/shop" };
  const h = await harness(t, {
    workspaces: {
      list: async () => ({ entries: [workspace] }),
      ref: (id) => ({ id, refresh: async () => workspace, directory: workspace.workspaceDirectory, agents: {
        create: async (options) => { created = options; return { id: "new-agent", current: () => ({ id: "new-agent", workspaceId: id, status: "running" }) }; },
      } }),
    },
    providers: {
      snapshot: async ({ cwd }) => { assert.equal(cwd, "/repo/shop"); return { entries: [{ provider: "codex", enabled: true, status: "ready" }] }; },
      listModels: async () => ({ models: [{ id: "model-a", label: "A" }, { id: "model-b", isDefault: true }, { id: "hidden", isSelectable: false }] }),
    },
  });
  await h.connect();
  const request = { prompt: "로그인 오류 조사해줘", requestKey: "fresh-task" };
  const result = await h.client.callTool({ name: "create_agent", arguments: request });
  assert.equal(result.structuredContent.agentId, "new-agent");
  assert.equal(created.title, request.prompt);
  assert.equal(created.config.provider, "codex/model-b");
  const originalKey = created.idempotencyKey;
  await h.client.callTool({ name: "create_agent", arguments: { ...request, requestKey: "another-intended-task" } });
  assert.notEqual(created.idempotencyKey, originalKey);
});

test("multiple workspaces/providers/models request a choice without starting anything", async (t) => {
  let creates = 0;
  let entries = [{ id: "a", name: "동일", workspaceDirectory: "/a" }, { id: "b", name: "동일", workspaceDirectory: "/b" }];
  let providers = [{ provider: "codex", status: "ready", enabled: true }, { provider: "claude", status: "ready", enabled: true }];
  let models = [{ id: "one" }, { id: "two" }, { id: "hidden", isSelectable: false }];
  const h = await harness(t, {
    agents: { create: async () => { creates++; } },
    workspaces: { list: async () => ({ entries }), ref: () => ({ refresh: async () => null }) },
    providers: { snapshot: async () => ({ entries: providers }), listModels: async () => ({ models }) },
  });
  await h.connect();
  const call = (args) => h.client.callTool({ name: "create_agent", arguments: { prompt: "Work", requestKey: "choose-first", ...args } });
  assert.equal((await call({})).structuredContent.kind, "workspace");
  assert.equal((await call({ workspaceId: "동일" })).structuredContent.choices.length, 2);
  assert.equal((await call({ cwd: "/repo" })).structuredContent.kind, "provider");
  providers = providers.slice(0, 1);
  const result = await call({ cwd: "/repo" });
  assert.equal(result.structuredContent.kind, "model");
  assert.deepEqual(result.structuredContent.choices.map((m) => m.provider), ["codex/one", "codex/two"]);
  models = [{ id: "codex/model", isDefault: true }];
  // Explicit model discovery yields values that can be passed back unchanged.
  const discovered = await h.client.callTool({ name: "list_models", arguments: { cwd: "/repo", provider: "codex" } });
  assert.equal(discovered.structuredContent.models[0].provider, "codex/model");
  assert.equal(creates, 0);
});

test("exact task titles resolve across pages and return IDs for further conversation", async (t) => {
  const sent = [];
  const agent = { id: "task-2", title: "로그인 수정", workspaceId: "ws-2", status: "running" };
  const h = await harness(t, { agents: {
    ref: (id) => ({ id, refresh: async () => id === agent.id ? { agent } : null, current: () => agent, send: async (prompt) => sent.push({ id, prompt }) }),
    list: async ({ page }) => page.cursor ? { entries: [{ agent }] } : { entries: [], pageInfo: { nextCursor: "page-2" } },
  } });
  await h.connect();
  const result = await h.client.callTool({ name: "send_agent_prompt", arguments: { agentId: "로그인 수정", prompt: "테스트도 해줘", messageId: "follow-up" } });
  assert.equal(result.structuredContent.agentId, "task-2");
  assert.deepEqual(sent, [{ id: "task-2", prompt: "테스트도 해줘" }]);
  const noTarget = await h.client.callTool({ name: "send_agent_prompt", arguments: { prompt: "이어서 해줘", messageId: "no-chat-context" } });
  assert.equal(noTarget.isError, true);
  assert.equal(sent.length, 1);
});

test("duplicate titles and incomplete pagination never send or stop the first match", async (t) => {
  let writes = 0;
  let repeatedCursor = false;
  const h = await harness(t, { agents: {
    ref: () => ({ refresh: async () => null, send: async () => writes++ }),
    list: async ({ page }) => ({ entries: [{ agent: { id: page.cursor ? "b" : "a", title: "Review", workspaceId: "ws" } }], pageInfo: { nextCursor: repeatedCursor || !page.cursor ? "next" : null } }),
  } });
  await h.connect();
  for (const name of ["send_agent_prompt", "cancel_agent"]) {
    const result = await h.client.callTool({ name, arguments: { agentId: "Review", prompt: "Continue", messageId: "safe" } });
    assert.equal(result.structuredContent.status, "needs_selection");
    assert.equal(result.structuredContent.choices.length, 2);
  }
  repeatedCursor = true;
  const result = await h.client.callTool({ name: "send_agent_prompt", arguments: { agentId: "Review", prompt: "Continue", messageId: "safe" } });
  assert.equal(result.structuredContent.kind, "target");
  assert.equal(writes, 0);
});

test("workspace name filters agent discovery and preserves pagination", async (t) => {
  const h = await harness(t, {
    workspaces: { ref: () => ({ refresh: async () => null }), list: async () => ({ entries: [{ id: "ws", name: "상점" }] }) },
    agents: { list: async () => ({ entries: [{ agent: { id: "a", workspaceId: "ws" } }, { agent: { id: "b", workspaceId: "other" } }], pageInfo: { nextCursor: "next" } }) },
  });
  await h.connect();
  const result = await h.client.callTool({ name: "list_agents", arguments: { workspaceId: "상점" } });
  assert.deepEqual(result.structuredContent.entries.map((a) => a.agentId), ["a"]);
  assert.equal(result.structuredContent.pageInfo.nextCursor, "next");
});

test("combined summary refreshes after waiting and marks truncated answers", async (t) => {
  let state = { id: "a", status: "running", activeTurn: { id: "turn" } };
  const h = await harness(t, { agents: { ref: () => ({ id: "a", refresh: async () => ({ agent: state }), current: () => state,
    waitForFinish: async () => { state = { id: "a", status: "idle" }; return { status: "idle" }; },
    timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "x".repeat(4500) }, turnId: "turn" }] }) },
  }) } });
  await h.connect();
  const result = await h.client.callTool({ name: "get_agent", arguments: { agentId: "a", waitSeconds: 1 } });
  assert.equal(result.structuredContent.workState, "idle");
  assert.equal(result.structuredContent.waitStatus, "idle");
  assert.equal(result.structuredContent.lastMessage.text.length, 4000);
  assert.equal(result.structuredContent.lastMessage.truncated, true);
  assert.equal(result.structuredContent.lastMessage.turnId, "turn");
});

test("wait_for_agent over authenticated HTTP times out without cancelling and resumes on the next call", async (t) => {
  let status = "running", refreshes = 0;
  const h = await harness(t, { agents: { ref: (id) => ({
    refresh: async () => { refreshes++; return {}; },
    current: () => ({ id, status }),
    timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "Tests passed" } }] }) },
    waitForFinish: async () => { throw new Error("Must use polling, not the legacy wait"); },
    cancel: async () => { throw new Error("Must not cancel"); },
  }) } });
  await h.connect();
  const args = { agentId: "a", timeoutSeconds: 1, pollIntervalSeconds: 1 };
  const first = await h.client.callTool({ name: "wait_for_agent", arguments: args });
  assert.equal(first.isError, undefined); assert.equal(first.structuredContent.timedOut, true);
  assert.equal(first.structuredContent.status, "running");
  assert.equal(first.structuredContent.next, "wait_for_agent");
  status = "idle";
  const second = await h.client.callTool({ name: "wait_for_agent", arguments: args });
  assert.equal(second.isError, undefined); assert.equal(second.structuredContent.timedOut, false);
  assert.equal(second.structuredContent.status, "idle");
  assert.equal(second.structuredContent.lastMessageSummary, "Tests passed");
  assert.ok(refreshes >= 4);
});
