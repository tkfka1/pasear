import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./tools.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { PaseoOAuthProvider, SCOPES } from "./oauth.js";

export function createApp({ connectionKey, connection, oauthStore, publicUrl, cancelAgent, importAgent }) {
  const app = express();
  // Serialize the entire native preflight/import/receipt flow across HTTP
  // requests for this installation, including calls from different chats.
  const imports = new Map();
  async function serializeImport(key, work) {
    const previous = imports.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    imports.set(key, next);
    try { return await next; }
    finally { if (imports.get(key) === next) imports.delete(key); }
  }
  app.disable("x-powered-by");
  if (!publicUrl || !connectionKey || !oauthStore) throw new Error("OAuth 공개 주소와 연결 비밀키가 필요합니다.");
  const resourceUrl = new URL(publicUrl);
  const mcpPaths = ["/", "/mcp"];
  const oauth = new PaseoOAuthProvider(oauthStore, publicUrl, connectionKey);
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  app.get("/oauth/flow/:id", (req, res) => oauth.flow(req.params.id, res));
  app.post("/oauth/flow/:id", express.urlencoded({ extended: false, limit: "2kb", parameterLimit: 3 }), (req, res) => {
    oauth.admit(req.params.id, req.body, req.get("origin"), res);
  });
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => res.json({
    resource: resourceUrl.href, authorization_servers: [resourceUrl.origin + "/"], scopes_supported: SCOPES, resource_name: "pasear",
  }));
  app.use(mcpAuthRouter({
    provider: oauth, issuerUrl: new URL(new URL(publicUrl).origin),
    resourceServerUrl: new URL(publicUrl), resourceName: "pasear", scopesSupported: SCOPES,
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
  }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  // Match only the two MCP endpoints: a root-mounted middleware would also
  // intercept OAuth routes and unrelated paths.
  app.all(mcpPaths, async (req, res, next) => {
    const authorization = req.get("authorization") ?? "";
    const principal = async () => {
      if (/^Bearer [A-Za-z0-9_-]+$/.test(authorization)) {
        const info = await oauth.verifyAccessToken(authorization.slice(7));
        return { connectionId: info.extra.grantId, scopes: info.scopes, workspaceIds: info.extra.workspaceIds, agentIds: info.extra.agentIds, accessRules: info.extra.accessRules, accessRevision: info.extra.accessRevision };
      }
      throw new Error("Unauthorized");
    };
    try { req.principal = await principal(); req.getPrincipal = principal; }
    catch {
      res.set("WWW-Authenticate", `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(resourceUrl)}", scope="${SCOPES.join(" ")}"`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.post(mcpPaths, express.json({ limit: "256kb" }), async (req, res) => {
    // Stateless MCP supports separate web chat HTTP requests without pinning an
    // MCP session to one process. The plugin Paseo SDK connection is shared, not the MCP server.
    const server = createMcpServer(connection, { principal: req.principal, getPrincipal: req.getPrincipal, audit: oauthStore.audit.bind(oauthStore), cancelAgent, importAgent, serializeImport });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
    }
  });
  app.all(mcpPaths, (_req, res) => res.set("Allow", "POST").status(405).end());
  app.use((error, _req, res, _next) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid request body" });
  });
  return app;
}
