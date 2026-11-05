import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export type { RpcInput } from "@getpaseo/plugin";

const publicMcpUrlSchema = z.string().url("Enter a valid HTTPS MCP URL.").refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["/", "/mcp"].includes(url.pathname) && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}, "Use an HTTPS domain URL, optionally ending in /mcp, without query parameters or user credentials.");

export const configSchema = z.object({
  host: z.enum(["127.0.0.1", "0.0.0.0"]).default("0.0.0.0"),
  port: z.number().int("Port must be a whole number.").min(1024, "Enter a port of 1024 or higher.").max(65535, "Enter a port of 65535 or lower.").default(8787),
  connectionKey: z.string().regex(/^[a-f0-9]{64}$|^$/, "Generate a connection key using the key button.").default(""),
  publicUrl: z.string().trim().default(""),
}).superRefine((config, ctx) => {
  if (config.publicUrl) {
      const result = publicMcpUrlSchema.safeParse(config.publicUrl);
      if (!result.success) ctx.addIssue({ code: "custom", path: ["publicUrl"], message: result.error.issues[0].message });
  }
});
export type McpConfig = z.infer<typeof configSchema>;
export const preferences = defineSettings({
  id: "listener", scope: "host", version: 3, schema: configSchema,
  migrate(values, fromVersion) {
    if (![1, 2].includes(fromVersion) || !values || typeof values !== "object" || Array.isArray(values)) throw new Error("Could not migrate saved MCP settings.");
    const previous = values as Record<string, unknown>;
    return { host: previous.host, port: previous.port, publicUrl: previous.publicUrl, connectionKey: previous.token ?? "" };
  },
});
export const statusSchema = z.object({
  running: z.boolean(), host: z.string().nullable(), port: z.number().nullable(),
  upstreamUrl: z.string().nullable(), startedAt: z.string().nullable(),
});
export type McpStatus = z.infer<typeof statusSchema>;
export const getStatus = defineRpc({ name: "mcp.status", input: z.object({}), output: statusSchema });
export const startServer = defineRpc({ name: "mcp.start", input: z.object({}), output: statusSchema });
export const stopServer = defineRpc({ name: "mcp.stop", input: z.object({}), output: statusSchema });
export const generateConnectionKey = defineRpc({ name: "mcp.connection-key", input: z.object({}), output: z.object({ connectionKey: z.string() }) });
const pendingSchema = z.object({ id: z.string(), code: z.string(), clientName: z.string(), redirectUri: z.string(), scopes: z.array(z.string()), expiresAt: z.string() });
const accessId = z.string().min(1).max(200);
export const accessRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all"), id: z.literal("*") }),
  z.object({ kind: z.literal("project"), id: accessId }),
  z.object({ kind: z.literal("workspace"), id: accessId }),
  z.object({ kind: z.literal("agent"), id: accessId, workspaceId: accessId }),
]);
export type AccessRule = z.infer<typeof accessRuleSchema>;
const connectionSchema = z.object({ id: z.string(), clientName: z.string(), scopes: z.array(z.string()), workspaceIds: z.array(z.string()).nullable(), agentIds: z.array(z.string()).nullable(), accessRules: z.array(accessRuleSchema).nullable(), accessRevision: z.number().int(), createdAt: z.string(), expiresAt: z.string() });
export const connectionsSchema = z.object({
  pending: z.array(pendingSchema), connections: z.array(connectionSchema),
  events: z.array(z.object({ at: z.string(), connectionId: z.string(), tool: z.string(), outcome: z.string() })),
});
export const getConnections = defineRpc({ name: "mcp.connections", input: z.object({}), output: connectionsSchema });
export const decideConnection = defineRpc({ name: "mcp.consent", input: z.object({
  id: z.string(), allow: z.boolean(),
  // Older app bundles can still submit explicit workspace-only approvals.
  workspaceIds: z.array(accessId).max(100).nullable().optional(),
  accessRules: z.array(accessRuleSchema).min(1).max(100).optional(),
}).superRefine((input, ctx) => {
  if (input.allow && input.accessRules === undefined && (input.workspaceIds === undefined || input.workspaceIds?.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Select at least one allowed target." });
  }
}), output: connectionsSchema });
export const revokeConnection = defineRpc({ name: "mcp.revoke", input: z.object({ id: z.string() }), output: connectionsSchema });
export const updateConnectionAccess = defineRpc({ name: "mcp.access", input: z.object({
  id: z.string(), accessRevision: z.number().int().nonnegative(),
  workspaceIds: z.array(z.string().min(1).max(200)).min(1).max(100).nullable(),
  agentIds: z.array(z.string().min(1).max(200)).min(1).max(100).nullable(),
  accessRules: z.array(accessRuleSchema).min(1).max(100).optional(),
}), output: connectionsSchema });
