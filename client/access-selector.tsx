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
      <Text style={text}>{label}{inherited ? " · 상위에서 허용" : checked ? " · 선택됨" : ""}</Text>
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
    <Text style={muted}>프로젝트 → 워크스페이스 → 에이전트 순서로 선택하세요. 상위를 허용하면 앞으로 만드는 하위 항목도 포함합니다.</Text>
    <Text style={muted}>프로젝트·워크스페이스 전체를 허용한 곳에서는 새 작업도 만들 수 있습니다. 에이전트만 선택한 곳에서는 선택한 기존 작업만 제어합니다.</Text>
    {choice({ kind: "all", id: "*" }, "모든 프로젝트와 에이전트")}
    {all ? <Text style={muted}>이 호스트의 모든 프로젝트·워크스페이스·에이전트를 허용합니다.</Text> : rules === null ? <View style={{ gap: 8 }}>
      <Text style={muted}>기존 에이전트 선택을 불러오는 중입니다. 항목이 없으면 더 불러오거나 해당 선택을 제거하세요.</Text>
      {legacyIds.filter((id) => !agentList.some((a) => a.id === id)).map((id) => <Action key={id} colors={colors} label={`목록에 없는 에이전트 선택 제거: ${id}`} onPress={() => { setLegacyIds(legacyIds.filter((v) => v !== id)); }} />)}
    </View> : <View style={{ gap: 16 }}>
      {projectIds.map((projectId) => {
        const opened = openProjects.includes(projectId), projectRule: AccessRule = { kind: "project", id: projectId };
        return <View key={projectId} style={{ gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${projectName(projectId)} 프로젝트 ${opened ? "접기" : "펼치기"}`} accessibilityState={{ expanded: opened }} aria-expanded={opened}
            onPress={() => expand(projectId, openProjects, setOpenProjects)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ ...text, fontWeight: "600" }}>{projectName(projectId)} · {opened ? "접기" : "펼치기"}</Text>
          </Pressable>
          {!opened ? <Text style={muted}>{selected(projectRule) ? "프로젝트 전체 허용" : `${(rules ?? []).filter((r) => r.kind === "workspace" ? workspaceList.some((w) => w.id === r.id && w.projectId === projectId) : r.kind === "agent" ? workspaceList.some((w) => w.id === r.workspaceId && w.projectId === projectId) : false).length}개 하위 항목 선택`}</Text> : null}
          {opened ? <View style={{ gap: 10 }}>
            <Text selectable style={muted}>{projectId}</Text>
            {choice(projectRule, `${projectName(projectId)} 프로젝트 전체 허용`, false, "현재·새 워크스페이스와 그 안의 모든 에이전트 포함")}
            {workspaceList.filter((w) => w.projectId === projectId).map((workspace) => {
              const inherited = selected(projectRule), workspaceRule: AccessRule = { kind: "workspace", id: workspace.id }, expanded = openWorkspaces.includes(workspace.id);
              return <View key={workspace.id} style={{ paddingLeft: 12, gap: 8 }}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${workspace.name || workspace.id} 워크스페이스 ${expanded ? "접기" : "펼치기"}`} accessibilityState={{ expanded }} aria-expanded={expanded}
                  onPress={() => expand(workspace.id, openWorkspaces, setOpenWorkspaces)} style={{ minHeight: 44, justifyContent: "center" }}>
                  <Text style={{ ...text, fontWeight: "600" }}>{workspace.name || workspace.id} · {expanded ? "접기" : "펼치기"}</Text>
                </Pressable>
                {expanded ? <View style={{ gap: 8 }}>
                  {choice(workspaceRule, `${workspace.name || workspace.id} 워크스페이스 전체 허용`, inherited, "현재·새 에이전트 포함")}
                  <View style={{ paddingLeft: 12, gap: 8 }}>
                    {agentList.filter((a) => a.workspaceId === workspace.id).map((a) => <View key={a.id}>{choice({ kind: "agent", id: a.id, workspaceId: workspace.id }, a.title || a.id, inherited || selected(workspaceRule), a.id)}</View>)}
                    {agents.isPending ? <Text style={muted}>에이전트를 불러오는 중…</Text> : !agentList.some((a) => a.workspaceId === workspace.id) ? <Text style={muted}>불러온 에이전트가 없습니다.</Text> : null}
                  </View>
                </View> : null}
              </View>;
            })}
            {!workspaceList.some((w) => w.projectId === projectId) ? <Text style={muted}>불러온 워크스페이스가 없습니다. 전체 허용 시 이후 생기는 항목도 포함됩니다.</Text> : null}
          </View> : null}
        </View>;
      })}
      {!projectIds.length && !projects.isPending && !workspaces.isPending ? <Text style={muted}>불러온 프로젝트가 없습니다.</Text> : null}
    </View>}
    {projects.isPending || workspaces.isPending ? <Text style={muted}>프로젝트·워크스페이스를 불러오는 중…</Text> : null}
    {missing.length ? <View style={{ gap: 8 }}><Text style={muted}>현재 목록에서 찾지 못한 선택입니다. 더 불러와 확인하거나 선택을 제거하세요.</Text>
      {missing.map((r) => <View key={`${r.kind}:${r.id}`}>{choice(r, `목록에 없는 ${r.kind === "project" ? "프로젝트" : r.kind === "workspace" ? "워크스페이스" : "에이전트"}: ${r.id}`)}</View>)}
    </View> : null}
    {workspaces.hasNextPage ? <Action colors={colors} label="워크스페이스 더 보기" disabled={workspaces.isFetchingNextPage} onPress={() => { void workspaces.fetchNextPage(); }} /> : null}
    {agents.hasNextPage && (openWorkspaces.length > 0 || rules === null) ? <Action colors={colors} label="에이전트 더 보기" disabled={agents.isFetchingNextPage} onPress={() => { void agents.fetchNextPage(); }} /> : null}
    {projects.isError || workspaces.isError || agents.isError ? <View style={{ gap: 8 }}>
      <Text accessibilityRole="alert" style={{ ...muted, color: colors.statusDanger }}>선택 목록을 불러오지 못했습니다. 다시 불러오세요.</Text>
      <Action colors={colors} label="선택 목록 다시 불러오기" onPress={() => { void projects.refetch(); void workspaces.refetch(); if (agents.isEnabled) void agents.refetch(); }} />
    </View> : null}
    <Text style={muted}>{rules?.length ?? legacyIds.length}개 선택 · 최대 100개.</Text>
    {!rules?.length && rules !== null ? <Text style={muted}>허용할 항목을 하나 이상 선택하세요.</Text> : null}
  </View>;
}
