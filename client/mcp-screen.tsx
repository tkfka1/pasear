import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { configSchema, preferences, getStatus, startServer, stopServer, generateConnectionKey } from "../shared/mcp";
import { Action } from "./controls";
import { ConnectionDetails } from "./connection-screen";
import { Connections } from "./connections";
import { Usage } from "./usage";
import { WalkScene } from "./walk-scene";

type Draft = { host: "127.0.0.1" | "0.0.0.0"; port: string; connectionKey: string; publicUrl: string; revision: string };
type Panel = "settings" | "connections" | "usage" | null;
export function McpScreen(props: PluginScreenProps) { return <Page key={props.host.id} {...props} />; }

function Page({ theme, layout, host }: PluginScreenProps) {
  const colors = theme.colors;
  const [panel, setPanel] = useState<Panel>(null);
  const settings = useSettings(preferences);
  const statusRpc = useRpc(getStatus), startRpc = useRpc(startServer), stopRpc = useRpc(stopServer), keyRpc = useRpc(generateConnectionKey);
  const cache = useQueryClient();
  const queryKey = ["mcp-listener-status", host.id];
  const status = useQuery({ queryKey, queryFn: () => statusRpc({}), refetchInterval: 3000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [focused, setFocused] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const viewportRef = useRef<View>(null);
  const dogRef = useRef<View>(null);
  const [dogVisible, setDogVisible] = useState(false);
  const checkDogVisibility = useCallback(() => {
    viewportRef.current?.measureInWindow((x, y, width, height) => {
      dogRef.current?.measureInWindow((dogX, dogY, dogWidth, dogHeight) => {
        setDogVisible(width > 0 && height > 0 && dogWidth > 0 && dogHeight > 0
          && dogY + dogHeight > y && dogY < y + height && dogX + dogWidth > x && dogX < x + width);
      });
    });
  }, []);
  const running = status.data?.running === true;
  useEffect(() => {
    if (settings.status === "ready" && !dirty) setDraft({ ...settings.values, port: String(settings.values.port), revision: settings.revision });
  }, [settings.status === "ready" ? settings.revision : settings.status, dirty]);
  function change(patch: Partial<Draft>) { setDraft((current) => current ? { ...current, ...patch } : current); setDirty(true); setNotice(""); }
  function toggle(next: Panel) { setPanel((current) => current === next ? null : next); }
  const action = useMutation({
    mutationFn: async (kind: "start" | "stop" | "save" | "key") => {
      setNotice("");
      if (kind === "stop") return stopRpc({});
      if (!draft || settings.status !== "ready") throw new Error("설정을 불러온 뒤 다시 시도하세요.");
      if (kind === "key") { change({ connectionKey: (await keyRpc({})).connectionKey }); setNotice("새 비밀키를 만들었습니다. 저장 후 서버를 켜면 기존 연결이 해제됩니다."); return; }
      const parsed = configSchema.safeParse({ ...draft, port: Number(draft.port), publicUrl: draft.publicUrl.trim() });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "설정을 확인하세요.");
      if (kind === "start") {
        if (!parsed.data.publicUrl) { setPanel("settings"); throw new Error("공개 HTTPS MCP 주소를 입력하세요."); }
        if (!parsed.data.connectionKey) parsed.data.connectionKey = (await keyRpc({})).connectionKey;
      }
      if (!await settings.save(parsed.data, draft.revision)) throw new Error("설정을 저장하지 못했습니다. 저장된 설정을 다시 불러온 뒤 시도하세요.");
      setDirty(false);
      if (kind === "start") return startRpc({});
      setNotice("설정을 저장했습니다.");
    },
    onSuccess: (result) => { if (result) cache.setQueryData(queryKey, result); },
    onSettled: () => { void cache.invalidateQueries({ queryKey }); },
  });
  const pending = action.isPending || settings.saving;
  const error = action.error instanceof Error ? action.error.message : settings.saveError;
  const settingsError = error && panel === "settings" && (action.variables === "save" || action.variables === "key");
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  const label = { ...text, fontWeight: "600" as const };
  function input(name: string, value: string, onChangeText: (value: string) => void, placeholder = "") {
    return <TextInput accessibilityLabel={name} value={value} onChangeText={onChangeText} editable={!running && !pending}
      placeholder={placeholder} placeholderTextColor={colors.foregroundMuted} autoCapitalize="none" autoCorrect={false}
      onFocus={() => setFocused(name)} onBlur={() => setFocused("")} keyboardType={name === "수신 포트" ? "number-pad" : "default"}
      style={{ ...text, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, borderWidth: 1,
        borderColor: focused === name ? colors.accent : colors.border, backgroundColor: colors.surface0, opacity: running ? 0.65 : 1 }} />;
  }
  if (settings.status !== "ready" || !draft) return <View style={{ flex: 1, padding: 24, backgroundColor: colors.surface0 }}>
    <Text style={text}>{settings.status === "loading" ? "설정을 불러오는 중…" : "설정을 불러오지 못했습니다. 호스트 연결을 확인하세요."}</Text>
  </View>;
  const saved = settings.values;
  return <View ref={viewportRef} onLayout={checkDogVisibility} style={{ flex: 1 }}><ScrollView onScroll={checkDogVisibility}
    onContentSizeChange={checkDogVisibility} scrollEventThrottle={32}
    style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 28 }}>
    <View style={{ width: "100%", maxWidth: 680, alignSelf: "center", paddingBottom: 32 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Text accessibilityRole="header" style={{ ...label, fontSize: 16 }}>{host.label}</Text>
          <Text accessibilityLiveRegion="polite" style={muted}>{status.isError ? "서버 상태 확인 필요" : !status.data ? "서버 확인 중…" : running ? "서버 켜짐" : "서버 꺼짐"} · {running ? status.data?.port : draft.port}</Text>
        </View>
        <Action colors={colors} primary={!running} label={pending && action.variables === "start" ? "켜는 중…" : pending && action.variables === "stop" ? "끄는 중…" : running ? "서버 끄기" : "서버 켜기"}
          disabled={pending || !status.data || status.isError} onPress={() => action.mutate(running ? "stop" : "start")} />
      </View>
      <Text style={{ ...muted, marginTop: 8 }}>이 호스트 안에서 MCP 서버를 실행합니다.</Text>
      {error && !settingsError ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger, marginTop: 12 }}>{error}</Text> : null}
      {status.isError ? <Action colors={colors} label="상태 다시 확인" onPress={() => { void status.refetch(); }} /> : null}
      <WalkScene colors={colors} compact={layout.compact} active={dogVisible} dogRef={dogRef} onDogLayout={checkDogVisibility} panel={panel} onPanel={toggle} />
      <View style={{ alignItems: "center", marginBottom: 16 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="사용법 열기" accessibilityState={{ expanded: panel === "usage" }}
          onPress={() => toggle("usage")} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 16, paddingVertical: 10, opacity: pressed ? 0.6 : 1 })}>
          <Text style={{ ...muted, textDecorationLine: "underline" }}>사용법</Text>
        </Pressable>
      </View>
      {notice && panel === null ? <Text accessibilityLiveRegion="polite" style={{ ...muted, marginBottom: 12 }}>{notice}</Text> : null}
      <Connections colors={colors} hostId={host.id} hostLabel={host.label} expanded={panel === "connections"} />
      <View nativeID="pasear-panel-settings" style={{ display: panel === "settings" ? "flex" : "none", gap: 14, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Text accessibilityRole="header" style={{ ...label, fontSize: 17 }}>설정</Text><Action colors={colors} label="설정 닫기" onPress={() => setPanel(null)} />
        </View>
        <Text style={muted}>{host.label}의 서버 설정입니다.</Text>
        <Text style={label}>공개 MCP 주소</Text>
        {input("공개 MCP 주소", draft.publicUrl, (publicUrl) => change({ publicUrl }), "https://mcp.example.com/mcp")}
        <Text style={muted}>LB에 연결한 HTTPS 주소에 /mcp까지 입력하세요.{running ? " 변경하려면 서버를 끄세요." : ""}</Text>
        <Action colors={colors} label={advanced ? "고급 설정 접기" : "고급 설정"} onPress={() => setAdvanced(!advanced)} />
        {advanced ? <View style={{ gap: 12 }}>
          <Text style={label}>수신 포트</Text>{input("수신 포트", draft.port, (port) => change({ port }))}
          <Text style={label}>접속 범위</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="접속 범위" style={{ gap: 8 }}>
            {([["127.0.0.1", "이 호스트에서만 · 127.0.0.1"], ["0.0.0.0", "네트워크에서 연결 · 0.0.0.0"]] as const).map(([value, title]) => <Pressable key={value}
              accessibilityRole="radio" accessibilityLabel={title} aria-checked={draft.host === value} accessibilityState={{ checked: draft.host === value, disabled: running || pending }}
              disabled={running || pending} onPress={() => change({ host: value })} style={{ minHeight: 44, padding: 12, borderWidth: 1, borderColor: draft.host === value ? colors.accent : colors.border, borderRadius: 8, backgroundColor: draft.host === value ? colors.surface1 : colors.surface0 }}>
              <Text style={text}>{title}</Text>
            </Pressable>)}
          </View>
          <Text style={muted}>같은 호스트의 프록시는 127.0.0.1로 연결할 수 있습니다. 다른 호스트에서 접속하면 네트워크 연결을 선택하세요.</Text>
          <Action colors={colors} label="연결 비밀키 교체" disabled={running || pending} onPress={() => action.mutate("key")} />
          <Text style={muted}>교체한 키를 저장하고 서버를 켜면 기존 연결은 해제됩니다.</Text>
        </View> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Action colors={colors} primary label="설정 저장" disabled={pending || !dirty || running} onPress={() => action.mutate("save")} />
          {dirty ? <Action colors={colors} label="변경 취소" disabled={pending} onPress={() => { setDraft({ ...saved, port: String(saved.port), revision: settings.revision }); setDirty(false); action.reset(); setNotice(""); }} /> : null}
        </View>
        {dirty ? <Text style={muted}>저장하지 않은 변경사항이 있습니다.</Text> : null}
        {settingsError ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{error}</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
      </View>
      <View nativeID="pasear-panel-connections" style={{ display: panel === "connections" ? "flex" : "none", paddingTop: 24, gap: 12 }}>
        <ConnectionDetails colors={colors} hostLabel={host.label} values={saved} status={status.data} active={panel === "connections"} notice={notice} onNotice={setNotice} />
        <Action colors={colors} label="연결 접기" onPress={() => setPanel(null)} />
      </View>
      <View nativeID="pasear-panel-usage" style={{ display: panel === "usage" ? "flex" : "none", paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Usage theme={theme} layout={layout} host={host} />
        <Action colors={colors} label="사용법 접기" onPress={() => setPanel(null)} />
      </View>
    </View>
  </ScrollView></View>;
}
