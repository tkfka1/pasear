import type { PluginServerContext } from "@getpaseo/plugin/server";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServerManager } from "./server/manager";
import { OAuthStore } from "./server/oauth.js";
import { preferences, getStatus, startServer, stopServer, generateConnectionKey, getConnections, decideConnection, revokeConnection, updateConnectionAccess } from "./shared/mcp";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const oauth = new OAuthStore(join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "paseo-mcp-plugin", "oauth.json"));
  const manager = new McpServerManager(oauth);
  server.handle(getStatus, () => manager.status());
  server.handle(generateConnectionKey, () => ({ connectionKey: randomBytes(32).toString("hex") }));
  server.handle(startServer, async (_input, { paseo }) => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error("설정을 확인하고 저장한 뒤 다시 시작하세요.");
    return manager.start(state.values, paseo);
  });
  server.handle(stopServer, () => manager.stop());
  server.handle(getConnections, () => oauth.snapshot());
  server.handle(decideConnection, async ({ id, allow, workspaceIds }, { paseo }) => {
    if (!manager.status().running) throw new Error("서버를 시작한 뒤 다시 연결하세요.");
    if (allow && workspaceIds) {
      for (const workspaceId of workspaceIds) {
        if (!await paseo.workspaces.ref(workspaceId).refresh()) throw new Error("워크스페이스를 찾지 못했습니다. 목록을 새로 불러오세요.");
      }
    }
    oauth.decide(id, allow, workspaceIds);
    return oauth.snapshot();
  });
  server.handle(revokeConnection, ({ id }) => { oauth.revoke(id); return oauth.snapshot(); });
  server.handle(updateConnectionAccess, async ({ id, workspaceIds, agentIds, accessRevision, accessRules }, { paseo }) => {
    if (accessRules) {
      const projects = accessRules.some((r) => r.kind === "project") ? (await paseo.projects.list()).projects : [];
      for (const rule of accessRules) {
        if (rule.kind === "project" && !projects.some((p) => p.projectId === rule.id)) throw new Error("프로젝트를 찾지 못했습니다. 목록을 다시 조회하세요.");
        if (rule.kind === "workspace" && !await paseo.workspaces.ref(rule.id).refresh()) throw new Error("워크스페이스를 찾지 못했습니다. 목록을 다시 조회하세요.");
        if (rule.kind === "agent") {
          const agent = paseo.agents.ref(rule.id);
          if (!await agent.refresh() || agent.current()?.workspaceId !== rule.workspaceId || !await paseo.workspaces.ref(rule.workspaceId).refresh()) throw new Error("에이전트의 워크스페이스가 바뀌었거나 대상을 찾지 못했습니다. 목록을 다시 조회하세요.");
        }
      }
      oauth.updateAccess(id, null, null, accessRevision, accessRules);
      return oauth.snapshot();
    }
    if (workspaceIds) for (const workspaceId of workspaceIds) {
      if (!await paseo.workspaces.ref(workspaceId).refresh()) throw new Error("워크스페이스를 찾지 못했습니다. 목록을 다시 조회하세요.");
    }
    if (agentIds) for (const agentId of agentIds) {
      const agent = paseo.agents.ref(agentId);
      if (!await agent.refresh()) throw new Error("에이전트를 찾지 못했습니다. 목록을 다시 조회하세요.");
      if (workspaceIds && !workspaceIds.includes(agent.current()?.workspaceId ?? "")) throw new Error("선택한 워크스페이스에 속한 에이전트만 허용할 수 있습니다.");
    }
    oauth.updateAccess(id, workspaceIds, agentIds, accessRevision);
    return oauth.snapshot();
  });
  const unsubscribe = settings.subscribe((state) => manager.reconcile(state.status === "ready" ? state.values : null));
  // Loading a plugin never opens a network port. Only mcp.start does.
  return async () => { unsubscribe(); await manager.stop(); };
}
