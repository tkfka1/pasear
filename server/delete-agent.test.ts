import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentDeleter } from "./delete-agent";

test("delete CLI adapter passes one literal exact ID and captures the local daemon home", async () => {
  let invocation: unknown[] = [];
  const agentId = "agent-123";
  const execute = (async (...args: unknown[]) => { invocation = args; return { stdout: JSON.stringify({ deletedCount: 1, agentIds: [agentId], extra: "private" }) }; }) as Parameters<typeof createAgentDeleter>[1];
  const remove = createAgentDeleter("/local/home with spaces/$(literal)", execute);
  assert.equal(await remove(agentId), undefined);
  assert.deepEqual(invocation, ["paseo", ["agent", "delete", agentId, "--home", "/local/home with spaces/$(literal)", "--json"], { timeout: 15000, maxBuffer: 65536 }]);
});

test("delete CLI adapter rejects option/control injection before execution", async () => {
  let calls = 0;
  const remove = createAgentDeleter("/local/home", async () => { calls++; return { stdout: "{}" }; });
  for (const id of ["", "--all", "--host=remote", "-x", "bad\nvalue", "bad\u0000value", "bad\u007fvalue", "x".repeat(201)]) await assert.rejects(remove(id), /Invalid agent ID/);
  assert.equal(calls, 0);
});

test("delete CLI adapter requires an exact single-target receipt even on a zero-exit failure", async () => {
  for (const receipt of [null, {}, { deletedCount: 0, agentIds: [] }, { deletedCount: 1, agentIds: ["other"] },
    { deletedCount: 2, agentIds: ["a", "b"] }, { deletedCount: 1, agentIds: "a" }, { deletedCount: "1", agentIds: ["a"] }]) {
    const remove = createAgentDeleter("/local/home", async () => ({ stdout: JSON.stringify(receipt) }));
    await assert.rejects(remove("a"), /Invalid deletion receipt/);
  }
  await assert.rejects(createAgentDeleter("/local/home", async () => ({ stdout: "not json" }))("a"));
  await assert.rejects(createAgentDeleter("/local/home", async () => { throw new Error("timeout"); })("a"), /timeout/);
});
