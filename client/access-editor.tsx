import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { updateConnectionAccess, type AccessRule } from "../shared/mcp";
import { Action, type Colors } from "./controls";
import { AccessSelector } from "./access-selector";

type Connection = { id: string; clientName: string; workspaceIds: string[] | null; agentIds: string[] | null; accessRules: AccessRule[] | null; accessRevision: number };

export function AccessEditor({ connection, colors, hostId, onSaved, onCancel }: {
  connection: Connection; colors: Colors; hostId: string; onSaved(): void; onCancel(): void;
}) {
  const saveRpc = useRpc(updateConnectionAccess);
  const [original] = useState(connection);
  const [rules, setRules] = useState<AccessRule[] | null>(() => connection.accessRules ?? (connection.agentIds !== null ? null
    : connection.workspaceIds === null ? [{ kind: "all", id: "*" }] : connection.workspaceIds.map((id) => ({ kind: "workspace", id }))));
  const [dirty, setDirty] = useState(false);
  const save = useMutation({ mutationFn: () => saveRpc({ id: original.id, accessRevision: original.accessRevision, workspaceIds: null, agentIds: null, accessRules: rules ?? [] }), onSuccess: onSaved });
  return <View style={{ gap: 12, paddingVertical: 12 }}>
    <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 14, fontWeight: "600" }}>Access · {connection.clientName}</Text>
    <AccessSelector rules={rules} onChange={(value) => { setRules(value); setDirty(true); }} colors={colors} hostId={hostId} disabled={save.isPending} legacy={original} />
    <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 }}>Changes apply immediately without reconnecting or stopping running tasks.</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Action colors={colors} primary label={save.isPending ? "Saving…" : "Save access"} disabled={save.isPending || !dirty || !rules?.length || rules.length > 100} onPress={() => save.mutate()} />
      <Action colors={colors} label="Cancel editing" disabled={save.isPending} onPress={onCancel} />
    </View>
    {save.error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 14, lineHeight: 22 }}>{save.error instanceof Error ? save.error.message : "Could not save access."}</Text> : null}
  </View>;
}
