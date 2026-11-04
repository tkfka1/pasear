import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeImporter, type NativeImportInput } from "./import-agent";

const input: NativeImportInput = { provider: "claude", sessionId: "session-123", cwd: "/repo/with spaces/$(literal)", requestId: "a".repeat(64), intentHash: "b".repeat(64), connectionId: "connection-123" };
test("native CLI import uses literal argv, the captured daemon home and a bounded JSON receipt", async () => {
  let invocation: unknown[] = [];
  const execute = (async (...args: unknown[]) => { invocation = args; return { stdout: '{"agentId":"imported-id","extra":"must not return"}' }; }) as Parameters<typeof createNativeImporter>[1];
  const importer = createNativeImporter("/daemon/home with spaces", execute);
  assert.equal(await importer(input), "imported-id");
  const [command, args, options] = invocation as [string, string[], Record<string, number>];
  assert.equal(command, "paseo"); assert.equal(args[0], "agent"); assert.equal(args[1], "import");
  assert.equal(args[2], "session-123");
  assert.equal(args[args.indexOf("--home") + 1], "/daemon/home with spaces");
  assert.equal(args[args.indexOf("--cwd") + 1], input.cwd);
  assert.equal(args.includes("--host"), false);
  assert.equal(args.at(-1), "--json");
  assert.equal(options.timeout, 20000); assert.equal(options.maxBuffer, 65536);
});

test("native CLI adapter rejects option injection, control characters, relative placement and malformed receipts", async () => {
  let calls = 0;
  const execute = (async () => { calls++; return { stdout: '{"status":"created"}' }; }) as Parameters<typeof createNativeImporter>[1];
  const importer = createNativeImporter("/local/home", execute);
  for (const patch of [{ sessionId: "--host=remote" }, { provider: "-bad" }, { sessionId: "bad\nvalue" }, { cwd: "relative" }, { cwd: "/bad\u0000path" }, { requestId: "short" }, { intentHash: "short" }, { connectionId: "\n" }]) await assert.rejects(importer({ ...input, ...patch }));
  assert.equal(calls, 0);
  await assert.rejects(importer(input), /Invalid import receipt/);
  assert.equal(calls, 1);
});
