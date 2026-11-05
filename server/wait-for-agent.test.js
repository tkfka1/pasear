import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./tools.js";
import { waitForAgents } from "./wait-for-agent.js";

async function harness(t, { api, ...context }) {
  const principal = { connectionId: "wait-test", scopes: ["paseo:read"], workspaceIds: null, ...context.principal };
  const server = createMcpServer({ getApi: async () => api }, { ...context, principal });
  const client = new Client({ name: "wait-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { client, call: (args) => client.callTool({ name: "wait_for_agent", arguments: args }) };
}

const snapshot = (id, status = "running", extra = {}) => ({ agentId: id, status, pendingPermissionCount: 0, ...extra });
const never = () => new Promise(() => {});

for (const status of ["idle", "closed", "error"]) {
  test(`wait_for_agent immediately reports ${status} and a bounded assistant excerpt`, async (t) => {
    let waited = false;
    const h = await harness(t, { api: { agents: { ref: (id) => ({
      refresh: async () => ({}), current: () => ({ id, status }),
      waitForFinish: async () => { waited = true; },
      timeline: { refetch: async () => ({ entries: [
        { item: { type: "user_message", text: "Do not return this" } },
        { item: { type: "assistant_message", text: "old" } },
        { item: { type: "assistant_message", text: "x".repeat(1200) } },
        { item: { type: "tool_call", input: "private-input" } },
      ] }) },
    }) } } });
    const result = await h.call({ agentId: "a" });
    assert.equal(result.isError, undefined);
    const value = result.structuredContent;
    assert.equal(value.status, status); assert.equal(value.reason, status);
    assert.equal(value.timedOut, false); assert.equal(value.lastMessageSummary.length, 1000);
    assert.equal(value.lastMessageTruncated, true); assert.equal(value.summaryUnavailable, false);
    assert.equal(waited, false); assert.ok(!JSON.stringify(result).includes("private-input"));
    assert.match(value.nextAction, /Idle is not proof of success/);
  });
}

test("permission requests stop a running agent wait without approving them", async (t) => {
  const h = await harness(t, { api: { agents: { ref: (id) => ({
    refresh: async () => ({}), current: () => ({ id, status: "running", pendingPermissions: [{}] }),
    timeline: { refetch: async () => ({ entries: [] }) },
  }) } } });
  const { structuredContent: value } = await h.call({ agentId: "a" });
  assert.equal(value.reason, "permission"); assert.equal(value.status, "running");
  assert.equal(value.pendingPermissionCount, 1); assert.equal(value.timedOut, false);
  assert.match(value.permissionAction, /Paseo/); assert.equal(value.lastMessageSummary, null);
});

test("polling refreshes state and stops at the first observed finish in a group", async () => {
  let rounds = 0;
  const result = await waitForAgents({ agentIds: ["a", "b"], timeoutSeconds: 1, pollIntervalSeconds: 0.01,
    observe: async (id) => {
      if (id === "a") rounds++;
      return snapshot(id, id === "b" && rounds >= 2 ? "idle" : "running");
    },
    summarize: async (id) => ({ state: snapshot(id, "idle"), text: "Done", truncated: false }),
  });
  assert.equal(rounds, 2); assert.equal(result.agentId, "b"); assert.equal(result.reason, "idle");
  assert.equal(result.lastMessageSummary, "Done"); assert.equal(result.timedOut, false);
  assert.deepEqual(result.remainingAgentIds, ["a"]);
});

test("simultaneous finishes use input order and a new turn during summary keeps waiting", async () => {
  let summaries = 0;
  const result = await waitForAgents({ agentIds: ["b", "a"], timeoutSeconds: 1, pollIntervalSeconds: 0.01,
    observe: async (id) => snapshot(id, "idle"),
    summarize: async (id) => ({ state: snapshot(id, ++summaries === 1 ? "running" : "idle"), text: "latest" }),
  });
  assert.equal(summaries, 2); assert.equal(result.agentId, "b"); assert.equal(result.status, "idle");
});

test("timeouts are bounded, include current state/message and can be called again", async () => {
  let status = "running", reads = 0;
  const options = { agentIds: ["a"], timeoutSeconds: 0.1, pollIntervalSeconds: 10,
    observe: async (id) => { reads++; return snapshot(id, status); },
    summarize: async (id) => ({ state: snapshot(id, status), text: "Working on it" }),
  };
  const first = await waitForAgents(options);
  assert.equal(first.timedOut, true); assert.equal(first.status, "running");
  assert.equal(first.lastMessageSummary, "Working on it"); assert.equal(first.next, "wait_for_agent");
  assert.match(first.nextAction, /again with the same/); assert.ok(first.elapsedSeconds < 1);
  assert.equal(reads, 1);
  status = "idle";
  const second = await waitForAgents(options);
  assert.equal(second.timedOut, false); assert.equal(second.status, "idle");
});

test("slow SDK reads and timeline reads cannot hold the polling call indefinitely", async () => {
  const noState = await waitForAgents({ agentIds: ["a"], timeoutSeconds: 0.1, pollIntervalSeconds: 1, observe: never, summarize: never });
  assert.equal(noState.timedOut, true); assert.equal(noState.status, null);
  assert.equal(noState.summaryUnavailable, true); assert.ok(noState.elapsedSeconds < 1);
  const noSummary = await waitForAgents({ agentIds: ["a"], timeoutSeconds: 0.1, pollIntervalSeconds: 1,
    observe: async (id) => snapshot(id, "idle"), summarize: never });
  assert.equal(noSummary.reason, "idle"); assert.equal(noSummary.timedOut, false);
  assert.equal(noSummary.summaryUnavailable, true); assert.equal(noSummary.lastMessageSummary, null);
  assert.ok(noSummary.elapsedSeconds < 1);
});

test("cancellation stops polling and removes the abort listener", async () => {
  const controller = new AbortController();
  const promise = waitForAgents({ agentIds: ["a"], timeoutSeconds: 10, pollIntervalSeconds: 1,
    signal: controller.signal, observe: async (id) => { controller.abort(new Error("cancelled")); return snapshot(id); }, summarize: never });
  await assert.rejects(promise);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const pending = new AbortController();
  const hung = waitForAgents({ agentIds: ["a"], timeoutSeconds: 10, pollIntervalSeconds: 1,
    signal: pending.signal, observe: never, summarize: never });
  pending.abort();
  await assert.rejects(hung, { name: "AbortError" });
  assert.equal(getEventListeners(pending.signal, "abort").length, 0);
});

test("wait tool validates target choice and budgets, and publishes its defaults", async (t) => {
  const h = await harness(t, { api: {} });
  const { tools } = await h.client.listTools();
  const tool = tools.find((entry) => entry.name === "wait_for_agent");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.inputSchema.properties.timeoutSeconds.default, 15);
  assert.equal(tool.inputSchema.properties.timeoutSeconds.maximum, 20);
  assert.equal(tool.inputSchema.properties.pollIntervalSeconds.default, 2);
  for (const args of [{}, { agentId: "a", agentIds: ["b"] }, { agentIds: [] },
    { agentIds: Array(11).fill("a") }, { agentId: "a", timeoutSeconds: 21 },
    { agentId: "a", timeoutSeconds: 0 }, { agentId: "a", pollIntervalSeconds: 0 },
    { agentId: "a", pollIntervalSeconds: 6 }]) {
    assert.equal((await h.call(args)).isError, true, JSON.stringify(args));
  }
});

test("group IDs are deduplicated and all targets must be accessible before summary reads", async (t) => {
  let reads = 0;
  const h = await harness(t, { principal: { workspaceIds: ["yes"] }, api: { agents: { ref: (id) => ({
    refresh: async () => ({}), current: () => ({ id, status: "idle", workspaceId: id === "a" ? "yes" : "no" }),
    timeline: { refetch: async () => { reads++; return { entries: [] }; } },
  }) } } });
  const denied = await h.call({ agentIds: ["a", "b"] });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /does not permit/);
  assert.equal(reads, 0); assert.equal(denied.structuredContent, undefined);
  const allowed = await h.call({ agentIds: ["a", "a"] });
  assert.deepEqual(allowed.structuredContent.watchedAgentIds, ["a"]);
});

for (const stage of ["poll", "summary", "revision", "revoke"]) {
  test(`wait does not leak timeline/state after access changes at ${stage}`, async (t) => {
    let placement = "yes", refreshes = 0, revision = 0, revoked = false, reads = 0;
    const h = await harness(t, {
      principal: { workspaceIds: ["yes"] },
      getPrincipal: async () => { if (revoked) throw new Error("private-credential"); return { scopes: ["paseo:read"], accessRevision: revision }; },
      api: { agents: { ref: (id) => ({
        refresh: async () => { if (stage === "poll" && ++refreshes === 2) placement = "no"; return {}; },
        current: () => ({ id, status: "idle", workspaceId: placement }),
        timeline: { refetch: async () => {
          reads++;
          if (stage === "summary") placement = "no";
          if (stage === "revision") revision++;
          if (stage === "revoke") revoked = true;
          return { entries: [{ item: { type: "assistant_message", text: "private-answer" } }] };
        } },
      }) } },
    });
    const result = await h.call({ agentId: "a" });
    assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes("private-"));
    assert.equal(result.structuredContent, undefined);
    if (stage === "poll") assert.equal(reads, 0);
  });
}

test("missing agents and SDK failures return sanitized errors", async (t) => {
  let fail = false;
  const h = await harness(t, { api: { agents: { ref: () => ({ refresh: async () => {
    if (fail) throw new Error("private-secret");
    return null;
  } }) } } });
  assert.match((await h.call({ agentId: "missing" })).content[0].text, /not found/);
  fail = true;
  const result = await h.call({ agentId: "a" });
  assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes("private-secret"));
});

test("group summary rechecks every watched agent's placement before returning any private output", async (t) => {
  let moved = false;
  const h = await harness(t, { principal: { workspaceIds: ["yes"] }, api: { agents: { ref: (id) => ({
    refresh: async () => ({}),
    current: () => ({ id, status: id === "a" ? "idle" : "running", workspaceId: moved && id === "b" ? "no" : "yes" }),
    timeline: { refetch: async () => {
      moved = true;
      return { entries: [{ item: { type: "assistant_message", text: "private-answer" } }] };
    } },
  }) } } });
  const result = await h.call({ agentIds: ["a", "b"] });
  assert.equal(result.isError, true); assert.equal(result.structuredContent, undefined);
  assert.match(result.content[0].text, /does not permit/);
  assert.ok(!JSON.stringify(result).includes("private-answer"));
});

test("an unavailable timeline preserves completion but marks the missing summary", async (t) => {
  const h = await harness(t, { api: { agents: { ref: (id) => ({
    refresh: async () => ({}), current: () => ({ id, status: "idle" }),
    timeline: { refetch: async () => { throw new Error("private-secret"); } },
  }) } } });
  const result = await h.call({ agentId: "a" });
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.reason, "idle");
  assert.equal(result.structuredContent.summaryUnavailable, true);
  assert.ok(!JSON.stringify(result).includes("private-secret"));
});
