import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { getConnections, decideConnection, revokeConnection, type AccessRule, type RpcInput } from "../shared/mcp";
import { hasControl } from "../shared/auth.js";
import { Action, type Colors } from "./controls";
import { AccessEditor } from "./access-editor";
import { AccessSelector } from "./access-selector";

type Pending = { id: string; code: string; clientName: string; redirectUri: string; scopes: string[]; expiresAt: string };

function Approval({ request, colors, hostLabel, hostId, pending, onDecide }: {
  request: Pending; colors: Colors; hostLabel: string; hostId: string; pending: boolean;
  onDecide(input: RpcInput<typeof decideConnection>): void;
}) {
  const [rules, setRules] = useState<AccessRule[]>([]);
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  return <View style={{ gap: 12, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    <Text style={{ ...text, fontWeight: "600" }}>{request.clientName}</Text>
    <Text selectable style={text}>확인 코드 {request.code}</Text>
    <Text selectable style={muted}>돌아갈 주소: {request.redirectUri}</Text>
    <Text style={muted}>인증 창의 코드·주소를 확인하세요. 앱 이름만으로 신뢰하지 마세요.</Text>
    <Text style={text}>{hostLabel} · 선택한 범위의 작업 제어를 허용합니다.</Text>
    <Text style={{ ...text, fontWeight: "600" }}>접근 범위</Text>
    <AccessSelector rules={rules} onChange={setRules} colors={colors} hostId={hostId} disabled={pending} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action colors={colors} primary label="연결 승인" disabled={pending || !hasControl(request.scopes) || !rules.length || rules.length > 100} onPress={() => onDecide({ id: request.id, allow: true, accessRules: rules })} />
      <Action colors={colors} label="거절" disabled={pending} onPress={() => onDecide({ id: request.id, allow: false, workspaceIds: [] })} />
    </View>
  </View>;
}

// Keep polling while the connection panel is hidden so its tab can show pending approvals.
export function Connections({ colors, hostId, hostLabel, expanded, onPendingChange }: { colors: Colors; hostId: string; hostLabel: string; expanded: boolean; onPendingChange?(count: number): void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const statusRpc = useRpc(getConnections), decideRpc = useRpc(decideConnection), revokeRpc = useRpc(revokeConnection);
  const state = useQuery({ queryKey: ["dar-connections", hostId], queryFn: () => statusRpc({}), refetchInterval: 3000 });
  const action = useMutation({
    mutationFn: async (input: { kind: "revoke"; id: string } | { kind: "decide"; input: RpcInput<typeof decideConnection> }) => {
      if (input.kind === "revoke") await revokeRpc({ id: input.id }); else await decideRpc(input.input);
    }, onSettled: () => { void state.refetch(); },
  });
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  const requests = state.data?.pending ?? [];
  useEffect(() => { onPendingChange?.(requests.length); }, [requests.length, onPendingChange]);
  if (!expanded && !requests.length && !action.error) return null;
  return <View style={{ gap: 12 }}>
    {requests.length ? <View>
      <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={{ ...text, fontWeight: "600", fontSize: 17 }}>연결 승인 요청 · {requests.length}</Text>
      {requests.map((request) => <Approval key={request.id} request={request} colors={colors} hostLabel={hostLabel} hostId={hostId} pending={action.isPending}
        onDecide={(input) => action.mutate({ kind: "decide", input })} />)}
    </View> : null}
    {action.error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{action.error instanceof Error ? action.error.message : "요청을 처리하지 못했습니다."}</Text> : null}
    {expanded ? <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...text, fontSize: 15, fontWeight: "600" }}>연결{state.data ? ` · ${state.data.connections.length}` : ""}</Text>
      {state.isError ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>연결 목록을 불러오지 못했습니다. 다시 조회하세요.</Text> : !state.data ? <Text style={muted}>연결을 불러오는 중…</Text> : null}
      {state.data && !state.data.connections.length ? <Text style={muted}>연결된 채팅이 없습니다.</Text> : null}
      {state.data?.connections.map((connection) => <View key={connection.id} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ ...text, fontWeight: "600" }}>{connection.clientName}</Text>
            {connection.accessRules ? <Text style={muted}>{connection.accessRules.some((r) => r.kind === "all") ? "모든 프로젝트와 에이전트"
              : ["project", "workspace", "agent"].map((kind, index) => { const count = connection.accessRules!.filter((r) => r.kind === kind).length; return count ? `${count}개 ${["프로젝트", "워크스페이스", "에이전트"][index]}` : null; }).filter(Boolean).join(" · ")}</Text>
              : <><Text style={muted}>{connection.workspaceIds === null ? "전체 워크스페이스" : `${connection.workspaceIds.length}개 워크스페이스`}</Text>
                <Text style={muted}>{connection.agentIds === null ? "모든 에이전트" : `${connection.agentIds.length}개 에이전트`}</Text></>}
          </View>
          <Action colors={colors} label="연결 해제" disabled={action.isPending} onPress={() => action.mutate({ kind: "revoke", id: connection.id })} />
        </View>
        {editing === connection.id ? <AccessEditor key={connection.id} connection={connection} colors={colors} hostId={hostId}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice("접근 범위를 저장했습니다."); void state.refetch(); }} />
          : <View style={{ alignItems: "flex-start" }}><Action colors={colors} label="접근 범위" disabled={action.isPending}
            onPress={() => { setNotice(""); setEditing(connection.id); }} /></View>}
      </View>)}
    </View> : null}
    {notice && expanded ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
    {state.isError ? <View style={{ alignItems: "flex-start" }}><Action colors={colors} label="다시 불러오기" disabled={action.isPending} onPress={() => { void state.refetch(); }} /></View> : null}
  </View>;
}
