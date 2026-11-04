import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { McpServerManager } from "./manager";
import { configSchema, preferences } from "../shared/mcp";

const api = {} as PluginHandlerContext["paseo"];
const connectionKey = "a".repeat(64);
const publicUrl = "https://paseo.example/mcp";
async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("starts only on command and stop closes its actual port", async (t) => {
  const manager = new McpServerManager();
  t.after(() => manager.stop());
  assert.equal(manager.status().running, false);
  const config = configSchema.parse({ port: await freePort(), connectionKey, publicUrl });
  const status = await manager.start(config, api);
  assert.equal(status.running, true);
  assert.equal(status.host, "0.0.0.0");
  assert.equal((await fetch(status.upstreamUrl!)).status, 401);
  assert.equal((await manager.start(config, api)).startedAt, status.startedAt);
  await manager.stop();
  assert.equal(manager.status().upstreamUrl, null);
  await assert.rejects(fetch(status.upstreamUrl!));
});

test("a port conflict is recoverable and leaves the other service alone", async (t) => {
  const occupied = createServer((_req, res) => res.end("existing service")).listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const port = (occupied.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const manager = new McpServerManager();
  t.after(() => manager.stop());
  await assert.rejects(manager.start(configSchema.parse({ port, connectionKey, publicUrl }), api), /사용 중/);
  assert.equal(manager.status().running, false);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), "existing service");
  await manager.start(configSchema.parse({ port: await freePort(), connectionKey, publicUrl }), api);
  assert.equal(manager.status().running, true);
});

test("OAuth public URL and credential edits stop the listener to prevent issuer drift", async (t) => {
  const manager = new McpServerManager();
  t.after(() => manager.stop());
  const config = configSchema.parse({ port: await freePort(), connectionKey, publicUrl });
  await manager.start(config, api);
  await manager.reconcile({ ...config, publicUrl: "https://mcp.example.com/mcp" });
  assert.equal(manager.status().running, false);
  await manager.start(config, api);
  await manager.reconcile({ ...config, connectionKey: "b".repeat(64) });
  assert.equal(manager.status().running, false);
});

test("concurrent start and stop serialize and an empty connection key cannot bind", async (t) => {
  const manager = new McpServerManager();
  t.after(() => manager.stop());
  const config = configSchema.parse({ port: await freePort(), connectionKey, publicUrl });
  await assert.rejects(manager.start({ ...config, connectionKey: "" }, api), /연결 비밀키/);
  await Promise.all([manager.start(config, api), manager.stop()]);
  assert.equal(manager.status().running, false);
});

test("v1 and v2 settings preserve listener, public URL and secret while removing old modes", async () => {
  for (const version of [1, 2]) {
    const previous = { host: "0.0.0.0", port: 9000, token: connectionKey, publicUrl, oauthEnabled: true, legacyTokenEnabled: true };
    assert.deepEqual(configSchema.parse(await preferences.migrate!(previous, version)), { host: "0.0.0.0", port: 9000, connectionKey, publicUrl });
  }
  assert.equal(configSchema.parse({}).connectionKey, "");
  assert.equal(configSchema.parse({}).host, "0.0.0.0");
  assert.equal(configSchema.parse({ host: "127.0.0.1" }).host, "127.0.0.1");
});

test("incomplete drafts can be saved but malformed public URLs cannot", () => {
  assert.equal(configSchema.safeParse({}).success, true);
  for (const publicUrl of ["https://mcp.example", "https://mcp.example/", "https://mcp.example/mcp"]) {
    assert.equal(configSchema.parse({ publicUrl }).publicUrl, publicUrl);
  }
  for (const publicUrl of ["unfinished", "http://mcp.example", "http://mcp.example/mcp", "https://mcp.example/wrong", "https://mcp.example/?x=1", "https://mcp.example/#fragment", "https://mcp.example/mcp?x=1", "https://user:secret@mcp.example/mcp"]) {
    assert.equal(configSchema.safeParse({ publicUrl }).success, false);
  }
});

test("a domain-only public URL starts MCP at the root with matching discovery", async (t) => {
  const manager = new McpServerManager();
  t.after(() => manager.stop());
  const status = await manager.start(configSchema.parse({ port: await freePort(), connectionKey, publicUrl: "https://paseo.example" }), api);
  assert.equal(new URL(status.upstreamUrl!).pathname, "/");
  const response = await fetch(status.upstreamUrl!);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate")!, /oauth-protected-resource"/);
  const metadata = await (await fetch(new URL("/.well-known/oauth-protected-resource", status.upstreamUrl!))).json() as { resource: string };
  assert.equal(metadata.resource, "https://paseo.example/");
});

test("both public URL and connection key are mandatory and OAuth is always available", async (t) => {
  const manager = new McpServerManager();
  t.after(() => manager.stop());
  const config = configSchema.parse({ port: await freePort(), connectionKey, publicUrl });
  await assert.rejects(manager.start({ ...config, publicUrl: "" }, api), /공개 HTTPS/);
  await assert.rejects(manager.start({ ...config, connectionKey: "" }, api), /연결 비밀키/);
  assert.equal(manager.status().running, false);
  const status = await manager.start(config, api);
  const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", status.upstreamUrl!));
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json() as { issuer: string }).issuer, "https://paseo.example/");
  assert.equal((await fetch(status.upstreamUrl!, { headers: { authorization: `Bearer ${connectionKey}` } })).status, 401);
});
