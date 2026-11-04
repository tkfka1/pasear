import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { getConnections, decideConnection, revokeConnection, type RpcInput } from "../shared/mcp";
import { hasControl } from "../shared/auth.js";
import { Action, type Colors } from "./controls";
import { AccessEditor } from "./access-editor";

type Pending = { id: string; code: string; clientName: string; redirectUri: string; scopes: string[]; expiresAt: string };
type Workspace = { id: string; name: string };

function Approval({ request, workspaces, hasMore, colors, hostLabel, pending, onDecide }: {
  request: Pending; workspaces: Workspace[]; hasMore: boolean; colors: Colors; hostLabel: string; pending: boolean;
  onDecide(input: RpcInput<typeof decideConnection>): void;
}) {
  const [workspaceIds, setWorkspaceIds] = useState<string[] | null>([]);
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  function choice(name: string, checked: boolean, onPress: () => void) {
    return <Pressable accessibilityRole="checkbox" accessibilityLabel={name} aria-checked={checked}
      accessibilityState={{ checked, disabled: pending }} disabled={pending} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8,
        borderWidth: 1, borderColor: checked ? colors.accent : colors.border, backgroundColor: checked || pressed ? colors.surface1 : colors.surface0 })}>
      <Text style={text}>{name}{checked ? " · 선택됨" : ""}</Text>
    </Pressable>;
  }
  return <View style={{ gap: 12, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Text style={{ ...text, fontWeight: "600" }}>{request.clientName}</Text>
    <Text selectable style={text}>확인 코드 {request.code}</Text>
    <Text selectable style={muted}>돌아갈 주소: {request.redirectUri}</Text>
    <Text style={muted}>인증 창의 코드·주소와 비교하세요. 앱 이름은 요청자가 입력한 값입니다.</Text>
    <Text style={text}>승인하면 {hostLabel}의 선택한 워크스페이스에서 작업 요청·메시지 전송·중단을 허용합니다.</Text>
    <Text style={{ ...text, fontWeight: "600" }}>허용할 워크스페이스</Text>
    {choice("전체 워크스페이스", workspaceIds === null, () => setWorkspaceIds(workspaceIds === null ? [] : null))}
    {workspaceIds === null ? <Text style={muted}>앞으로 만드는 워크스페이스도 포함합니다.</Text> : workspaces.map((workspace) => <View key={workspace.id}>
      {choice(workspace.name, workspaceIds.includes(workspace.id), () => setWorkspaceIds((current) => current?.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : [...(current ?? []), workspace.id]))}
    </View>)}
    {workspaceIds !== null && !workspaces.length ? <Text style={muted}>워크스페이스를 불러오는 중입니다. 목록이 없으면 아래에서 다시 조회하세요.</Text> : null}
    {hasMore && workspaceIds !== null ? <Text style={muted}>아래에서 워크스페이스를 더 불러올 수 있습니다.</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action colors={colors} primary label="연결 승인" disabled={pending || !hasControl(request.scopes) || (workspaceIds !== null && !workspaceIds.length)} onPress={() => onDecide({ id: request.id, allow: true, workspaceIds })} />
      <Action colors={colors} label="거절" disabled={pending} onPress={() => onDecide({ id: request.id, allow: false, workspaceIds: [] })} />
    </View>
  </View>;
}

// Requests stay on the main page even while another disclosure is open.
export function Connections({ colors, hostId, hostLabel, expanded }: { colors: Colors; hostId: string; hostLabel: string; expanded: boolean }) {
  const paseo = usePaseo();
  const [showEvents, setShowEvents] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const statusRpc = useRpc(getConnections), decideRpc = useRpc(decideConnection), revokeRpc = useRpc(revokeConnection);
  const state = useQuery({ queryKey: ["dar-connections", hostId], queryFn: () => statusRpc({}), refetchInterval: 3000 });
  const workspaces = useInfiniteQuery({ queryKey: ["dar-consent-workspaces", hostId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => paseo.workspaces.list({ page: { limit: 100, cursor: pageParam } }),
    getNextPageParam: (last) => last.pageInfo.nextCursor ?? undefined, enabled: !!state.data?.pending.length });
  const action = useMutation({
    mutationFn: async (input: { kind: "revoke"; id: string } | { kind: "decide"; input: RpcInput<typeof decideConnection> }) => {
      if (input.kind === "revoke") await revokeRpc({ id: input.id }); else await decideRpc(input.input);
    }, onSettled: () => { void state.refetch(); },
  });
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  const requests = state.data?.pending ?? [];
  if (!expanded && !requests.length && !action.error) return null;
  return <View style={{ gap: 12 }}>
    {requests.length ? <View>
      <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={{ ...text, fontWeight: "600", fontSize: 17 }}>연결 승인 요청 · {requests.length}</Text>
      {requests.map((request) => <Approval key={request.id} request={request} colors={colors} hostLabel={hostLabel} pending={action.isPending}
        workspaces={workspaces.data?.pages.flatMap((page) => page.entries.map((w) => ({ id: w.id, name: w.name || w.id }))) ?? []}
        hasMore={workspaces.hasNextPage} onDecide={(input) => action.mutate({ kind: "decide", input })} />)}
      {workspaces.hasNextPage ? <Action colors={colors} label="워크스페이스 더 불러오기" disabled={workspaces.isFetchingNextPage} onPress={() => { void workspaces.fetchNextPage(); }} /> : null}
      {workspaces.isError ? <Text accessibilityRole="alert" style={{ ...muted, color: colors.statusDanger }}>워크스페이스를 불러오지 못했습니다. 목록을 다시 조회하세요.</Text> : null}
    </View> : null}
    {action.error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{action.error instanceof Error ? action.error.message : "요청을 처리하지 못했습니다."}</Text> : null}
    {expanded ? <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...text, fontSize: 17, fontWeight: "600" }}>연결된 채팅</Text>
      <Text style={muted}>{hostLabel}에 연결된 채팅과 접근 범위입니다.</Text>
      {state.isError ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>연결 목록을 불러오지 못했습니다. 다시 조회하세요.</Text> : !state.data ? <Text style={muted}>연결을 불러오는 중…</Text> : null}
      {state.data && !state.data.connections.length ? <Text style={muted}>아직 연결된 채팅이 없습니다. 아래 주소로 연결하세요.</Text> : null}
      {state.data?.connections.map((connection) => <View key={connection.id} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ ...text, fontWeight: "600" }}>{connection.clientName}</Text>
            {connection.accessRules ? <Text style={muted}>{connection.accessRules.some((r) => r.kind === "all") ? "모든 프로젝트와 에이전트"
              : ["project", "workspace", "agent"].map((kind, index) => { const count = connection.accessRules!.filter((r) => r.kind === kind).length; return count ? `${count}개 ${["프로젝트", "워크스페이스", "에이전트"][index]}` : null; }).filter(Boolean).join(" · ")}</Text>
              : <><Text style={muted}>{connection.workspaceIds === null ? "전체 워크스페이스" : `${connection.workspaceIds.length}개 워크스페이스`}</Text>
                <Text style={muted}>{connection.agentIds === null ? "모든 에이전트" : `${connection.agentIds.length}개 에이전트`}</Text></>}
          </View>
          <Action colors={colors} label={`${connection.clientName} 연결 해제`} disabled={action.isPending} onPress={() => action.mutate({ kind: "revoke", id: connection.id })} />
        </View>
        {editing === connection.id ? <AccessEditor key={connection.id} connection={connection} colors={colors} hostId={hostId}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice("접근 범위를 저장했습니다. 연결에 바로 적용됩니다."); void state.refetch(); }} />
          : <View style={{ alignItems: "flex-start" }}><Action colors={colors} label={`${connection.clientName} 접근 범위`} disabled={action.isPending}
            onPress={() => { setNotice(""); setEditing(connection.id); }} /></View>}
      </View>)}
    </View> : null}
    {notice && expanded ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action colors={colors} label="목록 다시 조회" disabled={action.isPending} onPress={() => { void state.refetch(); void workspaces.refetch(); }} />
      {expanded && state.data?.events.length ? <Action colors={colors} label={showEvents ? "최근 활동 접기" : "최근 활동"} onPress={() => setShowEvents(!showEvents)} /> : null}
    </View>
    {expanded && showEvents ? <View style={{ gap: 8 }}>
      {state.data?.events.slice(0, 5).map((event, index) => <Text key={`${event.at}-${index}`} style={muted}>{new Date(event.at).toLocaleTimeString()} · {event.tool} · {event.outcome === "ok" ? "성공" : "오류"}</Text>)}
      <Text style={muted}>토큰·메시지·결과 본문은 기록하지 않습니다.</Text>
    </View> : null}
  </View>;
}
