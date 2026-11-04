import { connectionAccess } from "./access.js";

// A partial grant exposes only the parent label of a currently accessible child.
// It never grants access to siblings, project paths, or project-wide counts.
export async function accessibleProjects(api, principal) {
  const access = connectionAccess(api, principal);
  const full = new Set((principal.accessRules ?? []).filter((rule) => rule.kind === "project").map((rule) => rule.id));
  const witnesses = new Map();
  function add(projectId, check) {
    if (!projectId) return;
    if (!witnesses.has(projectId)) witnesses.set(projectId, []);
    witnesses.get(projectId).push(check);
  }
  async function child(workspaceId, agentId) {
    const workspace = api.workspaces.ref(workspaceId);
    async function currentProject() {
      if (agentId) {
        const agent = api.agents.ref(agentId);
        if (!await agent.refresh()) return null;
        const value = agent.current();
        if (!value || value.workspaceId !== workspaceId || !await access.agent(value)) return null;
      } else if (!await access.workspace(workspaceId, true)) return null;
      if (!await workspace.refresh()) return null;
      return workspace.projectId ?? workspace.current?.()?.projectId ?? null;
    }
    const projectId = await currentProject();
    add(projectId, async () => await currentProject() === projectId);
  }
  if (!access.unrestricted) {
    if (principal.accessRules) {
      for (const rule of principal.accessRules) {
        if (rule.kind === "workspace") await child(rule.id);
        if (rule.kind === "agent") await child(rule.workspaceId, rule.id);
      }
    } else if (principal.agentIds != null) {
      for (const id of principal.agentIds) {
        const agent = api.agents.ref(id);
        if (await agent.refresh() && agent.current()?.workspaceId) await child(agent.current().workspaceId, id);
      }
    } else for (const id of principal.workspaceIds ?? []) await child(id);
  }
  const { projects } = await api.projects.list();
  return projects.filter(({ projectId }) => access.unrestricted || full.has(projectId) || witnesses.has(projectId)).map((project) => ({
    value: { projectId: project.projectId, name: project.projectCustomName || project.projectDisplayName || project.projectId,
      access: access.unrestricted || full.has(project.projectId) ? "full" : "partial" },
    async check() {
      if (access.unrestricted || full.has(project.projectId)) return true;
      for (const check of witnesses.get(project.projectId) ?? []) if (await check()) return true;
      return false;
    },
  }));
}
