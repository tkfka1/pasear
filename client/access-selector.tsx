import { usePaseo } from "@getpaseo/plugin/client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type AccessRule } from "../shared/mcp";
import { Action, type Colors } from "./controls";

const same = (a: AccessRule, b: AccessRule) => a.kind === b.kind && a.id === b.id;

export function AccessSelector({ rules, onChange, colors, hostId, disabled = false, legacy }: {
  rules: AccessRule[] | null; onChange(rules: AccessRule[]): void; colors: Colors; hostId: string; disabled?: boolean;
  legacy?: { workspaceIds: string[] | null; agentIds: string[] | null };
}) {
  const paseo = usePaseo();
  const [openProjects, setOpenProjects] = useState<string[]>([]);
  const [openWorkspaces, setOpenWorkspaces] = useState<string[]>([]);
  const [legacyIds, setLegacyIds] = useState(legacy?.agentIds ?? []);
  const projects = useQuery({ queryKey: ["pasear-access-projects", hostId], queryFn: () => paseo.projects.list() });
  const workspaces = useInfiniteQuery({ queryKey: ["pasear-access-workspaces", hostId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => paseo.workspaces.list({ page: { limit: 100, cursor: pageParam } }),
    getNextPageParam: (page) => page.pageInfo.nextCursor ?? undefined });
  const agents = useInfiniteQuery({ queryKey: ["pasear-access-agents", hostId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 100, cursor: pageParam } }),
    getNextPageParam: (page) => page.pageInfo.nextCursor ?? undefined, enabled: rules === null || openWorkspaces.length > 0 });
  const workspaceList = workspaces.data?.pages.flatMap((page) => page.entries) ?? [];
  const agentList = agents.data?.pages.flatMap((page) => page.entries.map(({ agent }) => agent)) ?? [];
  useEffect(() => {
    if (rules !== null || !legacyIds.every((id) => agentList.some((a) => a.id === id))) return;
    onChange(legacyIds.flatMap((id): AccessRule[] => {
      const agent = agentList.find((a) => a.id === id)!;
      return agent.workspaceId && (legacy!.workspaceIds === null || legacy!.workspaceIds.includes(agent.workspaceId))
        ? [{ kind: "agent", id, workspaceId: agent.workspaceId }] : [];
    }));
  }, [rules, legacyIds.join("\0"), agentList.map((a) => `${a.id}:${a.workspaceId}`).join("\0")]);
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  const selected = (rule: AccessRule) => rules?.some((r) => same(r, rule)) ?? false;
  const all = selected({ kind: "all", id: "*" });
  function toggle(rule: AccessRule) { onChange(rules?.some((r) => same(r, rule)) ? rules.filter((r) => !same(r, rule)) : [...(rules ?? []), rule]); }
  function expand(id: string, list: string[], set: (value: string[]) => void) { set(list.includes(id) ? list.filter((v) => v !== id) : [...list, id]); }
  function choice(rule: AccessRule, label: string, inherited = false, detail?: string) {
    const checked = inherited || selected(rule);
    return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} aria-checked={checked}
      accessibilityState={{ checked, disabled: disabled || inherited }} disabled={disabled || inherited} onPress={() => toggle(rule)}
      style={({ pressed }) => ({ minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1,
        borderColor: checked ? colors.accent : colors.border, backgroundColor: checked || pressed ? colors.surface1 : colors.surface0, gap: 2 })}>
      <Text style={text}>{label}{inherited ? " · Allowed by parent" : checked ? " · Selected" : ""}</Text>
      {detail ? <Text selectable style={muted}>{detail}</Text> : null}
    </Pressable>;
  }
  const projectList = projects.data?.projects ?? [];
  const projectIds = [...new Set([...projectList.map((p) => p.projectId), ...workspaceList.map((w) => w.projectId)])];
  const projectName = (id: string) => {
    const project = projectList.find((p) => p.projectId === id), workspace = workspaceList.find((w) => w.projectId === id);
    return project?.projectCustomName || project?.projectDisplayName || workspace?.projectCustomName || workspace?.projectDisplayName || id;
  };
  const missing = rules?.filter((r) => r.kind === "project" ? !projectIds.includes(r.id) : r.kind === "workspace" ? !workspaceList.some((w) => w.id === r.id)
    : r.kind === "agent" ? !workspaceList.some((w) => w.id === r.workspaceId) || (agents.isSuccess && !agentList.some((a) => a.id === r.id && a.workspaceId === r.workspaceId)) : false) ?? [];
  return <View style={{ gap: 12, paddingVertical: 12 }}>
    <Text style={muted}>Select projects, then workspaces or agents. Allowing a parent includes future children.</Text>
    <Text style={muted}>Project or workspace access allows new tasks. Agent-only access controls existing selected tasks.</Text>
    {choice({ kind: "all", id: "*" }, "All projects and agents")}
    {all ? <Text style={muted}>Allow all projects, workspaces and agents on this host.</Text> : rules === null ? <View style={{ gap: 8 }}>
      <Text style={muted}>Loading existing agent selections. Load more or remove any missing selections.</Text>
      {legacyIds.filter((id) => !agentList.some((a) => a.id === id)).map((id) => <Action key={id} colors={colors} label={`Remove missing agent selection: ${id}`} onPress={() => { setLegacyIds(legacyIds.filter((v) => v !== id)); }} />)}
    </View> : <View style={{ gap: 16 }}>
      {projectIds.map((projectId) => {
        const opened = openProjects.includes(projectId), projectRule: AccessRule = { kind: "project", id: projectId };
        return <View key={projectId} style={{ gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${opened ? "Collapse" : "Expand"} project ${projectName(projectId)}`} accessibilityState={{ expanded: opened }} aria-expanded={opened}
            onPress={() => expand(projectId, openProjects, setOpenProjects)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ ...text, fontWeight: "600" }}>{projectName(projectId)} · {opened ? "Collapse" : "Expand"}</Text>
          </Pressable>
          {!opened ? <Text style={muted}>{selected(projectRule) ? "Allow entire project" : `${(rules ?? []).filter((r) => r.kind === "workspace" ? workspaceList.some((w) => w.id === r.id && w.projectId === projectId) : r.kind === "agent" ? workspaceList.some((w) => w.id === r.workspaceId && w.projectId === projectId) : false).length} child targets selected`}</Text> : null}
          {opened ? <View style={{ gap: 10 }}>
            <Text selectable style={muted}>{projectId}</Text>
            {choice(projectRule, `Allow project: ${projectName(projectId)}`, false, "Includes existing and future workspaces and their agents")}
            {workspaceList.filter((w) => w.projectId === projectId).map((workspace) => {
              const inherited = selected(projectRule), workspaceRule: AccessRule = { kind: "workspace", id: workspace.id }, expanded = openWorkspaces.includes(workspace.id);
              return <View key={workspace.id} style={{ paddingLeft: 12, gap: 8 }}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} workspace ${workspace.name || workspace.id}`} accessibilityState={{ expanded }} aria-expanded={expanded}
                  onPress={() => expand(workspace.id, openWorkspaces, setOpenWorkspaces)} style={{ minHeight: 44, justifyContent: "center" }}>
                  <Text style={{ ...text, fontWeight: "600" }}>{workspace.name || workspace.id} · {expanded ? "Collapse" : "Expand"}</Text>
                </Pressable>
                {expanded ? <View style={{ gap: 8 }}>
                  {choice(workspaceRule, `Allow workspace: ${workspace.name || workspace.id}`, inherited, "Includes existing and future agents")}
                  <View style={{ paddingLeft: 12, gap: 8 }}>
                    {agentList.filter((a) => a.workspaceId === workspace.id).map((a) => <View key={a.id}>{choice({ kind: "agent", id: a.id, workspaceId: workspace.id }, a.title || a.id, inherited || selected(workspaceRule), a.id)}</View>)}
                    {agents.isPending ? <Text style={muted}>Loading agents…</Text> : !agentList.some((a) => a.workspaceId === workspace.id) ? <Text style={muted}>No agents loaded.</Text> : null}
                  </View>
                </View> : null}
              </View>;
            })}
            {!workspaceList.some((w) => w.projectId === projectId) ? <Text style={muted}>No workspaces loaded. Whole-project access includes future workspaces.</Text> : null}
          </View> : null}
        </View>;
      })}
      {!projectIds.length && !projects.isPending && !workspaces.isPending ? <Text style={muted}>No projects loaded.</Text> : null}
    </View>}
    {projects.isPending || workspaces.isPending ? <Text style={muted}>Loading projects and workspaces…</Text> : null}
    {missing.length ? <View style={{ gap: 8 }}><Text style={muted}>Some selections are missing from the current list. Load more to find them or remove them.</Text>
      {missing.map((r) => <View key={`${r.kind}:${r.id}`}>{choice(r, `Missing ${r.kind === "project" ? "Project" : r.kind === "workspace" ? "Workspace" : "Agent"}: ${r.id}`)}</View>)}
    </View> : null}
    {workspaces.hasNextPage ? <Action colors={colors} label="Load more workspaces" disabled={workspaces.isFetchingNextPage} onPress={() => { void workspaces.fetchNextPage(); }} /> : null}
    {agents.hasNextPage && (openWorkspaces.length > 0 || rules === null) ? <Action colors={colors} label="Load more agents" disabled={agents.isFetchingNextPage} onPress={() => { void agents.fetchNextPage(); }} /> : null}
    {projects.isError || workspaces.isError || agents.isError ? <View style={{ gap: 8 }}>
      <Text accessibilityRole="alert" style={{ ...muted, color: colors.statusDanger }}>Could not load targets. Try again.</Text>
      <Action colors={colors} label="Reload targets" onPress={() => { void projects.refetch(); void workspaces.refetch(); if (agents.isEnabled) void agents.refetch(); }} />
    </View> : null}
    <Text style={muted}>{rules?.length ?? legacyIds.length} selected · Maximum 100.</Text>
    {!rules?.length && rules !== null ? <Text style={muted}>Select at least one allowed target.</Text> : null}
  </View>;
}
