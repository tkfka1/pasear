import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { authorizationPage, escapeHtml as escape } from "./authorization-page.js";
import { CONTROL_SCOPES, hasControl } from "../shared/auth.js";

export const SCOPES = CONTROL_SCOPES;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const matches = (a, b) => timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));

function safeRedirect(value) {
  const url = new URL(value);
  return !url.username && !url.password && !url.hash && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
}

// A connection key admits a request; only the authenticated Paseo RPC approves it.
// Neither the connection key nor client registration is an MCP access credential.
export class OAuthStore {
  /** @param {string | null} file */
  constructor(file = null) {
    this.file = file;
    this.data = { version: 1, clients: {}, grants: {}, access: {}, refresh: {} };
    this.pending = new Map();
    this.admissions = new Map();
    this.codes = new Map();
    this.events = [];
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        if (data.version !== 1 || !data.clients || !data.grants || !data.access || !data.refresh) throw new Error("Invalid OAuth state");
        this.data = data;
      } catch (error) {
        if (error.code !== "ENOENT") throw new Error("OAuth 저장 파일을 읽지 못했습니다. 파일 권한과 형식을 확인하세요.");
      }
    }
    let changed = false;
    for (const grant of Object.values(this.data.grants)) {
      if (!grant.keyHash && !grant.revoked) { grant.revoked = true; changed = true; }
    }
    if (changed) this.persist();
  }
  persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
  }
  prune() {
    for (const kind of ["access", "refresh"]) for (const [key, entry] of Object.entries(this.data[kind])) {
      if (entry.expiresAt <= now()) delete this.data[kind][key];
    }
    for (const [key, entry] of this.pending) if (entry.expiresAt <= now()) this.pending.delete(key);
    for (const [key, entry] of this.admissions) if (entry.expiresAt <= now()) this.admissions.delete(key);
    for (const [key, entry] of this.codes) if (entry.expiresAt <= now()) this.codes.delete(key);
    for (const [key, entry] of Object.entries(this.data.grants)) if (entry.expiresAt <= now()) delete this.data.grants[key];
    const activeClients = new Set(Object.values(this.data.grants).map((g) => g.clientId));
    for (const [key, entry] of Object.entries(this.data.clients)) {
      if (!activeClients.has(key) && (entry.client_id_issued_at ?? 0) + 86400 < now()) delete this.data.clients[key];
    }
  }
  audit(connectionId, tool, outcome) {
    this.events.unshift({ at: new Date().toISOString(), connectionId, tool, outcome });
    this.events = this.events.slice(0, 50);
  }
  snapshot() {
    this.prune();
    return {
      pending: [...this.pending.values()].filter((p) => p.decision === "pending").map((p) => ({
        id: p.id, code: p.displayCode, clientName: p.clientName, redirectUri: p.params.redirectUri,
        scopes: p.params.scopes, expiresAt: new Date(p.expiresAt * 1000).toISOString(),
      })),
      connections: Object.values(this.data.grants).filter((g) => !g.revoked).map((g) => ({
        id: g.id, clientName: g.clientName, scopes: g.scopes, workspaceIds: g.workspaceIds,
        agentIds: g.agentIds ?? null, accessRules: g.accessRules ?? null, accessRevision: g.accessRevision ?? 0,
        createdAt: new Date(g.createdAt * 1000).toISOString(), expiresAt: new Date(g.expiresAt * 1000).toISOString(),
      })),
      events: this.events,
    };
  }
  decide(id, allow, workspaceIds) {
    this.prune();
    const pending = this.pending.get(id);
    if (!pending || pending.decision !== "pending") throw new Error("연결 요청이 만료되었거나 이미 처리되었습니다. 웹 채팅에서 다시 연결하세요.");
    if (!pending.keyHash) throw new Error("연결 비밀키 확인을 먼저 완료하세요.");
    if (!allow) { pending.decision = "denied"; return; }
    if (workspaceIds !== null && workspaceIds.length === 0) throw new Error("허용할 워크스페이스를 선택하세요.");
    if (Object.values(this.data.grants).filter((g) => !g.revoked && g.expiresAt > now()).length >= 100) throw new Error("연결 수가 너무 많습니다. 사용하지 않는 연결을 해제하세요.");
    const scopes = [...pending.params.scopes];
    if (!hasControl(scopes)) throw new Error("작업 제어 권한이 필요합니다. 웹 채팅에서 모든 권한을 요청해 다시 연결하세요.");
    pending.decision = "approved";
    pending.grant = {
      id: randomUUID(), clientId: pending.clientId, clientName: pending.clientName,
      scopes, workspaceIds: workspaceIds === null ? null : [...new Set(workspaceIds)], agentIds: null, accessRevision: 0,
      resource: pending.resource, createdAt: now(), expiresAt: now() + 30 * 86400, revoked: false,
      keyHash: pending.keyHash, controlPermissionVersion: 1,
    };
    this.data.grants[pending.grant.id] = pending.grant;
    this.persist();
  }
  revoke(id) {
    if (this.data.grants[id]) { this.data.grants[id].revoked = true; this.persist(); }
  }
  updateAccess(id, workspaceIds, agentIds, revision, accessRules) {
    this.prune();
    const grant = this.data.grants[id];
    if (!grant || grant.revoked) throw new Error("연결이 해제되었거나 만료되었습니다. 목록을 다시 조회하세요.");
    if ((grant.accessRevision ?? 0) !== revision) throw new Error("다른 곳에서 접근 범위를 변경했습니다. 편집을 닫고 다시 열어주세요.");
    for (const ids of [workspaceIds, agentIds]) {
      if (ids !== null && (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== "string" || !id || id.length > 200))) throw new Error("허용할 대상을 하나 이상 선택하세요. 최대 100개까지 지정할 수 있습니다.");
    }
    if (accessRules !== undefined) {
      if (!Array.isArray(accessRules) || !accessRules.length || accessRules.length > 100
        || accessRules.some((r) => !["all", "project", "workspace", "agent"].includes(r.kind) || typeof r.id !== "string" || !r.id || r.id.length > 200 || (r.kind === "all" && r.id !== "*") || (r.kind === "agent" && (typeof r.workspaceId !== "string" || !r.workspaceId || r.workspaceId.length > 200)))) throw new Error("허용할 프로젝트·워크스페이스·에이전트를 선택하세요. 최대 100개까지 지정할 수 있습니다.");
      grant.accessRules = [...new Map(accessRules.map((r) => [`${r.kind}:${r.id}`, { ...r }])).values()];
      grant.workspaceIds = null;
      grant.agentIds = null;
    } else {
      delete grant.accessRules;
      grant.workspaceIds = workspaceIds === null ? null : [...new Set(workspaceIds)];
      grant.agentIds = agentIds === null ? null : [...new Set(agentIds)];
    }
    grant.accessRevision = revision + 1;
    this.persist();
  }
  clearPending() { this.pending.clear(); this.admissions.clear(); this.codes.clear(); }
  useConnectionKey(keyHash) {
    let changed = false;
    for (const grant of Object.values(this.data.grants)) {
      if (grant.keyHash !== keyHash && !grant.revoked) { grant.revoked = true; changed = true; }
    }
    if (changed) this.persist();
  }
  useControlPermission(keyHash, resource) {
    // Owner-requested policy migration applies to every approved client equally.
    // Keep identities, workspace boundaries, token hashes and lifetimes intact.
    const knownScopes = (scopes) => Array.isArray(scopes) && scopes.length > 0 && scopes.every((scope) => SCOPES.includes(scope));
    let changed = false;
    for (const grant of Object.values(this.data.grants)) {
      if (grant.controlPermissionVersion === 1 || grant.revoked || grant.expiresAt <= now()
        || grant.keyHash !== keyHash || grant.resource !== resource || !knownScopes(grant.scopes)) continue;
      grant.scopes = [...SCOPES];
      grant.controlPermissionVersion = 1;
      for (const kind of ["access", "refresh"]) for (const entry of Object.values(this.data[kind])) {
        if (entry.grantId === grant.id && entry.expiresAt > now() && knownScopes(entry.scopes)) entry.scopes = [...SCOPES];
      }
      changed = true;
    }
    if (changed) this.persist();
  }
}

export class PaseoOAuthProvider {
  constructor(store, resource, connectionKey) {
    if (!/^[a-f0-9]{64}$/.test(connectionKey ?? "")) throw new Error("연결 비밀키가 필요합니다.");
    this.store = store;
    this.resource = new URL(resource).href;
    this.keyHash = digest(connectionKey);
    this.store.useConnectionKey(this.keyHash);
    this.store.useControlPermission(this.keyHash, this.resource);
    this.clientsStore = {
      getClient: (id) => Object.hasOwn(this.store.data.clients, id) ? this.store.data.clients[id] : undefined,
      registerClient: (client) => {
        this.store.prune();
        if (Object.keys(this.store.data.clients).length >= 200) throw new InvalidClientMetadataError("Too many registered clients; retry later.");
        if (!client.redirect_uris?.length || client.redirect_uris.length > 10 || !client.redirect_uris.every((u) => { try { return safeRedirect(u); } catch { return false; } })) {
          throw new InvalidClientMetadataError("Use HTTPS redirect URIs or local loopback redirects without credentials or fragments.");
        }
        if (!["none", "client_secret_post"].includes(client.token_endpoint_auth_method ?? "client_secret_post")) throw new InvalidClientMetadataError("Choose none or client_secret_post authentication.");
        if ((client.client_name?.length ?? 0) > 120) throw new InvalidClientMetadataError("Client name is too long.");
        if (client.scope && client.scope.split(" ").some((s) => !SCOPES.includes(s))) throw new InvalidScopeError("Unknown scope.");
        const registered = { ...client, client_id: randomUUID(), client_id_issued_at: now(), client_secret_expires_at: 0 };
        this.store.data.clients[registered.client_id] = registered;
        this.store.persist();
        return registered;
      },
    };
  }
  checkResource(resource) {
    if (resource && resource.href !== this.resource) throw new InvalidTargetError("Resource must match the configured public MCP URL.");
  }
  async authorize(client, params, res) {
    this.store.prune();
    this.checkResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError("A valid S256 code challenge is required.");
    const scopes = params.scopes?.length ? params.scopes : [...SCOPES];
    if (scopes.some((s) => !SCOPES.includes(s)) || !hasControl(scopes)) throw new InvalidScopeError("pasear requires task control. Request paseo:read paseo:write paseo:cancel together, or omit scope to use the default.");
    if (this.store.pending.size + this.store.admissions.size >= 100) throw new InvalidRequestError("Too many authorization requests.");
    const id = secret();
    this.store.admissions.set(id, {
      id, csrf: secret(), attempts: 0, clientId: client.client_id,
      clientName: client.client_name || "Unnamed MCP client", params: { ...params, scopes },
      resource: this.resource, expiresAt: now() + 300,
    });
    res.redirect(303, new URL(`/oauth/flow/${id}`, this.resource).href);
  }
  admissionPage(entry, res, error = "", status = 200) {
    return authorizationPage(res, { title: "연결 비밀키 확인", status, body: `
      <p>pasear 메인 화면의 연결에서 복사한 비밀키를 입력하세요. 키가 확인된 요청만 Paseo에 표시됩니다.</p>
      <dl><dt>요청 앱 · 등록자가 제공한 이름</dt><dd>${escape(entry.clientName)}</dd><dt>돌아갈 주소</dt><dd>${escape(entry.params.redirectUri)}</dd></dl>
      ${error ? `<p role="alert">${escape(error)}</p>` : ""}
      <form method="post" action="/oauth/flow/${escape(entry.id)}"><input type="hidden" name="csrf" value="${escape(entry.csrf)}">
      <label for="connection-key">연결 비밀키</label><input id="connection-key" type="password" name="connection_key" required maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false">
      <button type="submit">키 확인 후 승인 요청</button></form><p>키 확인 후 Paseo 메인 화면에서 허용할 워크스페이스를 선택하고 연결을 승인하세요. 승인하면 작업 요청·메시지 전송·중단이 허용됩니다. 요청은 5분 뒤 만료됩니다.</p>` });
  }
  admit(id, body, origin, res) {
    this.store.prune();
    const entry = this.store.admissions.get(id);
    if (!entry) return authorizationPage(res, { title: "연결 요청 만료", status: 410, body: "<p>웹 채팅에서 연결을 다시 시작하세요.</p>" });
    if (origin !== new URL(this.resource).origin || typeof body?.csrf !== "string" || !matches(body.csrf, entry.csrf)) {
      return authorizationPage(res, { title: "연결 요청 확인 실패", status: 403, body: "<p>웹 채팅에서 연결을 다시 시작하세요.</p>" });
    }
    entry.attempts++;
    if (typeof body.connection_key !== "string" || body.connection_key.length !== 64 || !matches(digest(body.connection_key), this.keyHash)) {
      if (entry.attempts >= 5) {
        this.store.admissions.delete(id);
        return authorizationPage(res, { title: "연결 요청 잠김", status: 429, body: "<p>비밀키 확인에 5회 실패했습니다. 웹 채팅에서 연결을 다시 시작하세요.</p>" });
      }
      return this.admissionPage(entry, res, "연결 비밀키가 일치하지 않습니다. Paseo 설정에서 키를 확인하세요.", 401);
    }
    this.store.admissions.delete(id);
    this.store.pending.set(id, {
      id, clientId: entry.clientId, clientName: entry.clientName, params: entry.params, resource: entry.resource,
      displayCode: randomBytes(4).toString("hex").toUpperCase(), decision: "pending", keyHash: this.keyHash, expiresAt: entry.expiresAt,
    });
    return res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).redirect(303, new URL(`/oauth/flow/${id}`, this.resource).href);
  }
  flow(id, res) {
    this.store.prune();
    const admission = this.store.admissions.get(id);
    if (admission) return this.admissionPage(admission, res);
    const pending = this.store.pending.get(id);
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", "X-Content-Type-Options": "nosniff" });
    if (!pending) return res.status(410).type("text").send("This connection request expired. Start again from your web chat.");
    if (pending.decision === "pending") {
      return authorizationPage(res, { title: "Paseo에서 연결 승인", refresh: true, body: `<p>비밀키 확인이 완료됐습니다. Paseo의 pasear 메인 화면에서 같은 코드와 돌아갈 주소를 확인하고 승인하세요.</p><dl><dt>확인 코드</dt><dd>${escape(pending.displayCode)}</dd><dt>요청 앱 · 등록자가 제공한 이름</dt><dd>${escape(pending.clientName)}</dd><dt>돌아갈 주소</dt><dd>${escape(pending.params.redirectUri)}</dd></dl><p>승인하면 선택한 워크스페이스의 작업 요청·메시지 전송·중단을 허용합니다. 직접 시작한 요청인지 확인하세요. 승인 후 이 창은 웹 채팅으로 돌아갑니다.</p>` });
    }
    this.store.pending.delete(id);
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
    if (pending.decision === "denied") redirect.searchParams.set("error", "access_denied");
    else {
      const code = secret();
      this.store.codes.set(digest(code), { clientId: pending.clientId, params: pending.params, grantId: pending.grant.id, resource: this.resource, expiresAt: now() + 60 });
      redirect.searchParams.set("code", code);
    }
    return res.redirect(303, redirect.href);
  }
  code(client, code) {
    this.store.prune();
    const entry = this.store.codes.get(digest(code));
    if (!entry || entry.clientId !== client.client_id || entry.resource !== this.resource) throw new InvalidGrantError("Invalid or expired authorization code.");
    return entry;
  }
  async challengeForAuthorizationCode(client, code) { return this.code(client, code).params.codeChallenge; }
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    this.checkResource(resource);
    const entry = this.code(client, code);
    if (redirectUri !== entry.params.redirectUri) throw new InvalidGrantError("redirect_uri must match the authorization request.");
    this.store.codes.delete(digest(code));
    return this.issue(entry.grantId);
  }
  issue(grantId) {
    const grant = this.store.data.grants[grantId];
    if (!grant || grant.revoked || grant.keyHash !== this.keyHash || grant.expiresAt <= now() || grant.resource !== this.resource) throw new InvalidGrantError("Connection expired or revoked.");
    if (!hasControl(grant.scopes)) throw new InvalidGrantError("Task control permission is required.");
    this.store.prune();
    if (Object.keys(this.store.data.access).length >= 2000 || Object.keys(this.store.data.refresh).length >= 5000) throw new InvalidGrantError("Too many active tokens. Reconnect later.");
    const access = secret(), refresh = secret();
    const allowed = [...SCOPES];
    this.store.data.access[digest(access)] = { grantId, scopes: allowed, expiresAt: Math.min(now() + 3600, grant.expiresAt) };
    this.store.data.refresh[digest(refresh)] = { grantId, scopes: allowed, expiresAt: grant.expiresAt, used: false };
    this.store.persist();
    return { access_token: access, token_type: "Bearer", expires_in: Math.min(3600, grant.expiresAt - now()), refresh_token: refresh, scope: allowed.join(" ") };
  }
  async exchangeRefreshToken(client, refresh, scopes, resource) {
    this.checkResource(resource);
    this.store.prune();
    const entry = this.store.data.refresh[digest(refresh)];
    const grant = entry && this.store.data.grants[entry.grantId];
    if (!entry || !grant || grant.keyHash !== this.keyHash || grant.clientId !== client.client_id || grant.resource !== this.resource || grant.revoked || grant.expiresAt <= now()) throw new InvalidGrantError("Invalid refresh token.");
    if (entry.used) { this.store.revoke(grant.id); throw new InvalidGrantError("Refresh token reuse detected. Reconnect from your web chat."); }
    // Existing clients may repeat a cached scope on refresh. All recognized
    // scopes belong to the same owner-approved permission; return its full scope.
    if (scopes && (!scopes.length || scopes.some((s) => !SCOPES.includes(s)))) throw new InvalidScopeError("Unknown task control scope.");
    if (!hasControl(entry.scopes)) throw new InvalidGrantError("Task control permission is required.");
    entry.used = true;
    return this.issue(grant.id);
  }
  async verifyAccessToken(token) {
    const entry = this.store.data.access[digest(token)];
    const grant = entry && this.store.data.grants[entry.grantId];
    if (!entry || entry.expiresAt <= now() || !grant || grant.keyHash !== this.keyHash || grant.revoked || grant.expiresAt <= now() || grant.resource !== this.resource) throw new InvalidTokenError("Invalid or expired access token.");
    if (!hasControl(grant.scopes) || !hasControl(entry.scopes)) throw new InvalidTokenError("Task control permission is required.");
    return { token, clientId: grant.clientId, scopes: entry.scopes, expiresAt: entry.expiresAt, resource: new URL(this.resource), extra: { grantId: grant.id, workspaceIds: grant.workspaceIds, agentIds: grant.agentIds ?? null, accessRules: grant.accessRules ?? null, accessRevision: grant.accessRevision ?? 0 } };
  }
  async revokeToken(client, request) {
    const entry = this.store.data.access[digest(request.token)] ?? this.store.data.refresh[digest(request.token)];
    const grant = entry && this.store.data.grants[entry.grantId];
    if (grant?.clientId === client.client_id) this.store.revoke(grant.id);
  }
}
