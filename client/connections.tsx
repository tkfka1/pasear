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
    <Text selectable style={text}>Verification code {request.code}</Text>
    <Text selectable style={muted}>Callback URL: {request.redirectUri}</Text>
    <Text style={muted}>Check the code and callback URL in the sign-in window. The app name alone does not verify its identity.</Text>
    <Text style={text}>{hostLabel} · Allow task control within the selected targets.</Text>
    <Text style={{ ...text, fontWeight: "600" }}>Access</Text>
    <AccessSelector rules={rules} onChange={setRules} colors={colors} hostId={hostId} disabled={pending} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action colors={colors} primary label="Approve connection" disabled={pending || !hasControl(request.scopes) || !rules.length || rules.length > 100} onPress={() => onDecide({ id: request.id, allow: true, accessRules: rules })} />
      <Action colors={colors} label="Deny" disabled={pending} onPress={() => onDecide({ id: request.id, allow: false, workspaceIds: [] })} />
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
      <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={{ ...text, fontWeight: "600", fontSize: 17 }}>Connection requests · {requests.length}</Text>
      {requests.map((request) => <Approval key={request.id} request={request} colors={colors} hostLabel={hostLabel} hostId={hostId} pending={action.isPending}
        onDecide={(input) => action.mutate({ kind: "decide", input })} />)}
    </View> : null}
    {action.error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{action.error instanceof Error ? action.error.message : "Could not process the request."}</Text> : null}
    {expanded ? <View style={{ gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...text, fontSize: 15, fontWeight: "600" }}>Connections{state.data ? ` · ${state.data.connections.length}` : ""}</Text>
      {state.isError ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>Could not load connections. Refresh the list.</Text> : !state.data ? <Text style={muted}>Loading connections…</Text> : null}
      {state.data && !state.data.connections.length ? <Text style={muted}>No chats connected.</Text> : null}
      {state.data?.connections.map((connection) => <View key={connection.id} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ ...text, fontWeight: "600" }}>{connection.clientName}</Text>
            {connection.accessRules ? <Text style={muted}>{connection.accessRules.some((r) => r.kind === "all") ? "All projects and agents"
              : ["project", "workspace", "agent"].map((kind) => { const count = connection.accessRules!.filter((r) => r.kind === kind).length; return count ? `${count} ${kind}${count === 1 ? "" : "s"}` : null; }).filter(Boolean).join(" · ")}</Text>
              : <><Text style={muted}>{connection.workspaceIds === null ? "All workspaces" : `${connection.workspaceIds.length} workspace${connection.workspaceIds.length === 1 ? "" : "s"}`}</Text>
                <Text style={muted}>{connection.agentIds === null ? "All agents" : `${connection.agentIds.length} agent${connection.agentIds.length === 1 ? "" : "s"}`}</Text></>}
          </View>
          <Action colors={colors} label="Disconnect" disabled={action.isPending} onPress={() => action.mutate({ kind: "revoke", id: connection.id })} />
        </View>
        {editing === connection.id ? <AccessEditor key={connection.id} connection={connection} colors={colors} hostId={hostId}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice("Access saved."); void state.refetch(); }} />
          : <View style={{ alignItems: "flex-start" }}><Action colors={colors} label="Access" disabled={action.isPending}
            onPress={() => { setNotice(""); setEditing(connection.id); }} /></View>}
      </View>)}
    </View> : null}
    {notice && expanded ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
    {state.isError ? <View style={{ alignItems: "flex-start" }}><Action colors={colors} label="Reload" disabled={action.isPending} onPress={() => { void state.refetch(); }} /></View> : null}
  </View>;
}
