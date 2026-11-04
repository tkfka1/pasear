// Workspace membership is read from the daemon, never inferred from names or paths.
export function connectionAccess(api, principal) {
  const rules = principal.accessRules;
  const unrestricted = rules ? rules.some((r) => r.kind === "all") : principal.workspaceIds === null && principal.agentIds == null;
  const legacyWorkspace = (id) => principal.workspaceIds === null || principal.workspaceIds.includes(id);
  async function workspace(id, create = false) {
    if (!rules) return legacyWorkspace(id) && (!create || principal.agentIds == null);
    if (unrestricted || rules.some((r) => r.kind === "workspace" && r.id === id)) return true;
    if (!create && rules.some((r) => r.kind === "agent" && r.workspaceId === id)) return true;
    if (!id || !rules.some((r) => r.kind === "project")) return false;
    const ref = api.workspaces.ref(id);
    if (!await ref.refresh()) return false;
    const projectId = ref.projectId ?? ref.current?.()?.projectId;
    return !!projectId && rules.some((r) => r.kind === "project" && r.id === projectId);
  }
  async function agent(value) {
    if (!rules) return legacyWorkspace(value.workspaceId) && (principal.agentIds == null || principal.agentIds.includes(value.id));
    if (unrestricted || rules.some((r) => r.kind === "agent" && r.id === value.id && r.workspaceId === value.workspaceId)) return true;
    return workspace(value.workspaceId, true);
  }
  return { unrestricted, workspace, agent };
}
