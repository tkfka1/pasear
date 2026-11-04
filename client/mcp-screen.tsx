import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { configSchema, preferences, getStatus, startServer, stopServer, generateConnectionKey } from "../shared/mcp";
import { Action } from "./controls";
import { ConnectionDetails } from "./connection-screen";
import { Logs } from "./logs";
import { Connections } from "./connections";

type Draft = { host: "127.0.0.1" | "0.0.0.0"; port: string; connectionKey: string; publicUrl: string; revision: string };
export function McpScreen(props: PluginScreenProps) { return <Page key={props.host.id} {...props} />; }

function Page({ theme, layout, host }: PluginScreenProps) {
  const colors = theme.colors;
  const settings = useSettings(preferences);
  const statusRpc = useRpc(getStatus), startRpc = useRpc(startServer), stopRpc = useRpc(stopServer), keyRpc = useRpc(generateConnectionKey);
  const cache = useQueryClient();
  const queryKey = ["mcp-listener-status", host.id];
  const status = useQuery({ queryKey, queryFn: () => statusRpc({}), refetchInterval: 3000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [focused, setFocused] = useState("");
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const running = status.data?.running === true;
  useEffect(() => {
    if (settings.status === "ready" && !dirty) setDraft({ ...settings.values, port: String(settings.values.port), revision: settings.revision });
  }, [settings.status === "ready" ? settings.revision : settings.status, dirty]);
  function change(patch: Partial<Draft>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true); setNotice("");
  }
  const action = useMutation({
    mutationFn: async (kind: "start" | "stop" | "save" | "key") => {
      setNotice("");
      if (kind === "stop") return stopRpc({});
      if (!draft || settings.status !== "ready") throw new Error("설정을 불러온 뒤 다시 시도하세요.");
      if (kind === "key") {
        change({ connectionKey: (await keyRpc({})).connectionKey });
        setNotice("저장 후 서버를 켜면 기존 연결이 해제됩니다."); return;
      }
      const parsed = configSchema.safeParse({ ...draft, port: Number(draft.port), publicUrl: draft.publicUrl.trim() });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "설정을 확인하세요.");
      if (kind === "start") {
        if (!parsed.data.publicUrl) { setEditing(true); throw new Error("공개 HTTPS 주소를 입력하세요."); }
        if (!parsed.data.connectionKey) parsed.data.connectionKey = (await keyRpc({})).connectionKey;
      }
      if (!await settings.save(parsed.data, draft.revision)) throw new Error("저장하지 못했습니다. 변경을 취소하고 다시 시도하세요.");
      setDirty(false); setEditing(false);
      if (kind === "start") return startRpc({});
      setNotice("저장했습니다.");
    },
    onSuccess: (result) => { if (result) cache.setQueryData(queryKey, result); },
    onSettled: () => { void cache.invalidateQueries({ queryKey }); },
  });
  const pending = action.isPending || settings.saving;
  const error = action.error instanceof Error ? action.error.message : settings.saveError;
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  const label = { ...text, fontWeight: "600" as const };
  function input(name: string, value: string, onChangeText: (value: string) => void, placeholder = "") {
    return <TextInput accessibilityLabel={name} value={value} onChangeText={onChangeText} editable={!running && !pending}
      placeholder={placeholder} placeholderTextColor={colors.foregroundMuted} autoCapitalize="none" autoCorrect={false}
      onFocus={() => setFocused(name)} onBlur={() => setFocused("")} keyboardType={name === "수신 포트" ? "number-pad" : "default"}
      style={{ ...text, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 8, borderWidth: 1,
        borderColor: focused === name ? colors.accent : colors.border, backgroundColor: colors.surface0, opacity: running ? 0.65 : 1 }} />;
  }
  if (settings.status !== "ready" || !draft) return <View style={{ flex: 1, padding: 24, backgroundColor: colors.surface0 }}>
    <Text accessibilityLiveRegion="polite" style={text}>{settings.status === "loading" ? "불러오는 중…" : "호스트 연결을 확인하세요."}</Text>
  </View>;
  const saved = settings.values;
  const revision = settings.revision;
  const firstRun = !saved.publicUrl;
  const showSettings = editing || firstRun;
  const ready = !!status.data && !status.isError;
  function cancelEdit() {
    setDraft({ ...saved, port: String(saved.port), revision });
    setDirty(false); setEditing(false); action.reset(); setNotice("");
  }
  return <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{ paddingHorizontal: layout.compact ? 20 : 40, paddingVertical: layout.compact ? 28 : 48 }}>
    <View nativeID="pasear-main" style={{ width: "100%", maxWidth: 600, alignSelf: "center", gap: 32, paddingBottom: 32 }}>
      <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 26, lineHeight: 34, fontWeight: "600", letterSpacing: -0.6 }}>pasear</Text>
        <Text style={muted}>웹 채팅에서 Paseo 제어</Text>
      </View>
      <View style={{ gap: 24, paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View accessible={false} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status.isError ? colors.statusDanger : running ? colors.statusSuccess : colors.foregroundMuted }} />
              <Text accessibilityLiveRegion="polite" style={label}>{status.isError ? "상태 확인 필요" : !status.data ? "확인 중…" : running ? "실행 중" : "중지됨"}</Text>
            </View>
            <Text style={muted}>{host.label} · {running ? status.data?.port : draft.port}</Text>
          </View>
          {!firstRun ? <Action colors={colors} primary={!running} label={pending && action.variables === "start" ? "켜는 중…" : pending && action.variables === "stop" ? "끄는 중…" : running ? "서버 끄기" : "서버 켜기"}
            disabled={pending || !ready} onPress={() => action.mutate(running ? "stop" : "start")} /> : null}
        </View>
        {status.isError ? <Action colors={colors} label="다시 확인" onPress={() => { void status.refetch(); }} /> : null}
        {showSettings ? <View nativeID="pasear-settings" style={{ gap: 12 }}>
          <Text style={label}>공개 MCP 주소</Text>
          {input("공개 MCP 주소", draft.publicUrl, (publicUrl) => change({ publicUrl }), "https://mcp.example.com")}
          <View style={{ alignItems: "flex-start" }}><Action colors={colors} quiet label={advanced ? "고급 설정 접기" : "고급 설정"} expanded={advanced} onPress={() => setAdvanced(!advanced)} /></View>
          {advanced ? <View style={{ gap: 16, paddingVertical: 8 }}>
            <View style={{ gap: 8 }}><Text style={label}>수신 포트</Text>{input("수신 포트", draft.port, (port) => change({ port }))}</View>
            <View style={{ gap: 8 }}>
              <Text style={label}>접속 범위</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel="접속 범위" style={{ gap: 8 }}>
                {([["127.0.0.1", "이 호스트만", "127.0.0.1"], ["0.0.0.0", "네트워크", "0.0.0.0"]] as const).map(([value, title, address]) => <Pressable key={value}
                  accessibilityRole="radio" accessibilityLabel={`${title} · ${address}`} aria-checked={draft.host === value} accessibilityState={{ checked: draft.host === value, disabled: running || pending }}
                  disabled={running || pending} onPress={() => change({ host: value })} style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: 14, paddingVertical: 12,
                    flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: draft.host === value ? colors.accent : colors.border,
                    borderRadius: 8, backgroundColor: pressed ? colors.surface1 : colors.surface0, opacity: running ? 0.65 : 1 })}>
                  <View accessible={false} style={{ width: 16, height: 16, borderRadius: 8, borderWidth: draft.host === value ? 5 : 1, borderColor: draft.host === value ? colors.accent : colors.foregroundMuted }} />
                  <Text style={{ ...text, flex: 1 }}>{title}</Text><Text style={muted}>{address}</Text>
                </Pressable>)}
              </View>
            </View>
            {saved.connectionKey ? <View style={{ gap: 4, alignItems: "flex-start" }}>
              <Action colors={colors} label="비밀키 교체" disabled={running || pending} onPress={() => action.mutate("key")} />
              <Text style={muted}>교체 후 저장하고 켜면 기존 연결이 해제됩니다.</Text>
            </View> : null}
          </View> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Action colors={colors} primary label={pending ? "처리 중…" : firstRun ? "저장하고 켜기" : "저장"}
              disabled={pending || running || !draft.publicUrl.trim() || (firstRun ? !ready : !dirty)} onPress={() => action.mutate(firstRun ? "start" : "save")} />
            {!firstRun || dirty ? <Action colors={colors} quiet label="취소" disabled={pending} onPress={cancelEdit} /> : null}
          </View>
        </View> : <ConnectionDetails colors={colors} values={saved} running={running} onEdit={() => { setEditing(true); action.reset(); setNotice(""); }} onNotice={setNotice} />}
        {error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{error}</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
      </View>
      <View style={{ paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Connections colors={colors} hostId={host.id} hostLabel={host.label} expanded />
      </View>
      <Logs colors={colors} hostId={host.id} />
    </View>
  </ScrollView>;
}
