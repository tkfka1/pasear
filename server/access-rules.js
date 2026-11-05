// Shared by initial consent and later edits: neither path may fall back to full-host access.
export function normalizeAccessRules(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.length > 100
    || rules.some((r) => !r || !["all", "project", "workspace", "agent"].includes(r.kind)
      || typeof r.id !== "string" || !r.id || r.id.length > 200
      || (r.kind === "all" && r.id !== "*")
      || (r.kind === "agent" && (typeof r.workspaceId !== "string" || !r.workspaceId || r.workspaceId.length > 200)))) {
    throw new Error("Select allowed projects, workspaces or agents. You can select up to 100 targets.");
  }
  return [...new Map(rules.map((r) => [`${r.kind}:${r.id}`, r.kind === "agent"
    ? { kind: r.kind, id: r.id, workspaceId: r.workspaceId } : { kind: r.kind, id: r.id }])).values()];
}
