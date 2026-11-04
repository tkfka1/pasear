import { useRpc } from "@getpaseo/plugin/client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Share, Text, TextInput, View } from "react-native";
import { clearLogs, configureLogs, exportLogs, getLogDetail, getLogStatus, listLogs } from "../shared/logs";
import { Action, type Colors } from "./controls";
import { downloadText } from "./web";

const outcomes = { ok: "정상", error: "오류", unauthorized: "인증 거부", aborted: "연결 중단" };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Detail({ id, hostId, colors }: { id: string; hostId: string; colors: Colors }) {
  const rpc = useRpc(getLogDetail);
  const detail = useQuery({ queryKey: ["pasear-log-detail", hostId, id], queryFn: () => rpc({ id }), retry: false });
  const [notice, setNotice] = useState("");
  const text = { color: colors.foreground, fontSize: 13, lineHeight: 21 };
  if (detail.isPending) return <Text style={text}>상세 기록을 불러오는 중…</Text>;
  if (detail.error) return <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>기록을 불러오지 못했습니다. 삭제되었거나 호스트 연결이 끊겼을 수 있습니다.</Text><Action colors={colors} label="상세 기록 다시 불러오기" onPress={() => { void detail.refetch(); }} /></View>;
  const row = detail.data!;
  const content = JSON.stringify(row, null, 2);
  return <View style={{ gap: 12 }}>
    <Text selectable style={text}>연결 ID · {row.connectionId ?? "미인증"}</Text>
    <Text style={text}>{row.httpMethod} {row.path} · HTTP {row.status}</Text>
    {([['요청', row.request], ['응답', row.response]] as const).map(([label, body]) => {
      const value = JSON.stringify(body, null, 2) ?? "null";
      return <View key={label} style={{ gap: 6 }}>
        <Text style={{ ...text, fontWeight: "600" }}>{label}</Text>
        <ScrollView style={{ maxHeight: 300, backgroundColor: colors.surface1, borderRadius: 8 }} nestedScrollEnabled>
          <ScrollView horizontal contentContainerStyle={{ padding: 12 }}><Text selectable style={{ ...text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>{value.slice(0, 32000)}</Text></ScrollView>
        </ScrollView>
        {value.length > 32000 ? <Text style={text}>화면에는 앞부분만 표시합니다. 저장된 전체 내용은 내려받기·공유로 확인하세요.</Text> : null}
      </View>;
    })}
    <Action colors={colors} label={Platform.OS === "web" ? "이 기록 내려받기" : "이 기록 공유"} onPress={() => {
      if (Platform.OS === "web") setNotice(downloadText([JSON.stringify(row) + "\n"], `pasear-${id}.jsonl`) ? "기록을 내려받았습니다." : "내려받지 못했습니다. 브라우저의 다운로드 설정을 확인하세요.");
      else void Share.share({ message: content, title: "pasear 통신 기록" }).catch(() => setNotice("공유하지 못했습니다. 텍스트를 길게 눌러 복사하세요."));
    }} />
    {notice ? <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text> : null}
  </View>;
}

export function Logs({ colors, hostId }: { colors: Colors; hostId: string }) {
  const [expanded, setExpanded] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const [connection, setConnection] = useState(""), [tool, setTool] = useState(""), [filters, setFilters] = useState({ connection: "", tool: "" });
  const [confirmDelete, setConfirmDelete] = useState(false), [notice, setNotice] = useState("");
  const [focused, setFocused] = useState("");
  const statusRpc = useRpc(getLogStatus), configureRpc = useRpc(configureLogs), clearRpc = useRpc(clearLogs), listRpc = useRpc(listLogs), exportRpc = useRpc(exportLogs);
  const cache = useQueryClient();
  const stateKey = ["pasear-log-status", hostId];
  const state = useQuery({ queryKey: stateKey, queryFn: () => statusRpc({}), refetchInterval: 5000 });
  const applied = { connection: filters.connection || undefined, tool: filters.tool || undefined };
  const rows = useInfiniteQuery({ queryKey: ["pasear-logs", hostId, filters], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listRpc({ ...applied, before: pageParam, limit: 25 }), getNextPageParam: (page) => page.nextCursor ?? undefined, enabled: expanded, retry: false });
  useEffect(() => {
    const next = { connection: connection.trim(), tool: tool.trim() };
    if (next.connection === filters.connection && next.tool === filters.tool) return;
    const timer = setTimeout(() => { setFilters(next); setSelected(null); }, 300);
    return () => clearTimeout(timer);
  }, [connection, tool, filters]);
  const action = useMutation({ mutationFn: async (kind: "collect" | "skip" | "clear" | "export") => {
    setNotice("");
    if (kind === "collect" || kind === "skip") return configureRpc({ enabled: kind === "collect" });
    if (kind === "clear") {
      const result = await clearRpc({}); setSelected(null); setConfirmDelete(false);
      cache.removeQueries({ queryKey: ["pasear-log-detail", hostId] });
      await cache.resetQueries({ queryKey: ["pasear-logs", hostId] }); setNotice("저장된 로그를 삭제했습니다."); return result;
    }
    const parts: string[] = []; let cursor: string | undefined;
    do { const page = await exportRpc({ ...applied, cursor }); parts.push(page.content); cursor = page.nextCursor ?? undefined; } while (cursor);
    if (!downloadText(parts, `pasear-logs-${new Date().toISOString().slice(0, 10)}.jsonl`)) throw Error("내려받지 못했습니다. 브라우저의 다운로드 설정을 확인하세요.");
    setNotice("조회 조건에 맞는 로그를 내려받았습니다.");
  }, onSuccess: (result) => { if (result) cache.setQueryData(stateKey, result); }, onSettled: () => { void state.refetch(); } });
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  const pending = action.isPending;
  const entries = rows.data?.pages.flatMap((p) => p.entries) ?? [];
  function input(label: string, value: string, set: (v: string) => void) {
    return <TextInput accessibilityLabel={label} placeholder={label} placeholderTextColor={colors.foregroundMuted} value={value} onChangeText={set} maxLength={200} autoCapitalize="none" autoCorrect={false}
      onFocus={() => setFocused(label)} onBlur={() => setFocused("")} style={{ ...text, fontSize: 16, minHeight: 44, padding: 12, borderWidth: 1, borderColor: focused === label ? colors.accent : colors.border, borderRadius: 8 }} />;
  }
  return <View style={{ gap: 12, paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.border }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>통신 로그</Text>
      <Action colors={colors} quiet expanded={expanded} label={expanded ? "로그 접기" : "로그 열기"} onPress={() => setExpanded(!expanded)} />
    </View>
    <Text accessibilityLiveRegion="polite" style={muted}>{state.data ? `${state.data.enabled ? "수집 중" : "수집 안 함"} · ${size(state.data.storedBytes)} · 최근 ${state.data.retentionDays}일, 최대 ${size(state.data.maxBytes)}` : state.isError ? "기록 상태를 확인하지 못했습니다." : "기록 상태를 불러오는 중…"}</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel="로그 수집" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {([[true, "수집함"], [false, "수집 안 함"]] as const).map(([enabled, label]) => {
        const checked = state.data?.enabled === enabled;
        return <Pressable key={label} accessibilityRole="radio" accessibilityLabel={label} aria-checked={checked}
          accessibilityState={{ checked, disabled: pending || !state.data || state.isError }} disabled={pending || !state.data || state.isError}
          onPress={() => { if (!checked) action.mutate(enabled ? "collect" : "skip"); }}
          style={({ pressed }) => ({ minHeight: 44, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, borderWidth: 1,
            borderColor: checked || focused === label ? colors.accent : colors.border, backgroundColor: checked || pressed ? colors.surface1 : colors.surface0,
            opacity: pending || !state.data || state.isError ? 0.45 : 1 })} onFocus={() => setFocused(label)} onBlur={() => setFocused("")}>
          <Text style={{ ...text, fontWeight: checked ? "600" : "400" }}>{label}</Text>
        </Pressable>;
      })}
    </View>
    {state.data?.enabled === false ? <Text style={muted}>새 요청·응답과 호출 이력을 수집하지 않습니다. 기존 로그는 유지되며 전체 로그 삭제로 지울 수 있습니다.</Text> : null}
    {state.data?.error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{state.data.error}</Text> : null}
    {state.data?.dropped ? <Text style={{ ...muted, color: colors.statusDanger }}>이번 실행에서 {state.data.dropped}건을 저장하지 못했습니다. 저장 오류 또는 기록량 제한을 확인하세요.</Text> : null}
    {expanded ? <View style={{ gap: 16 }}>
      <Text style={muted}>MCP 요청·응답을 이 호스트에 저장합니다. 인증 헤더·OAuth 본문은 기록하지 않으며, 알려진 인증 값과 비밀키 필드를 가립니다. 본문에는 작업 내용이 포함됩니다. 응답이 1MB를 넘으면 본문 생략 표시를 남깁니다.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action colors={colors} label="로그 새로고침" disabled={pending || rows.isFetching} onPress={() => { setSelected(null); void cache.resetQueries({ queryKey: ["pasear-logs", hostId] }); void state.refetch(); }} />
      </View>
      <View style={{ gap: 8 }}>{input("연결 이름 또는 ID로 필터", connection, setConnection)}{input("도구 이름으로 필터", tool, setTool)}</View>
      {rows.isPending ? <Text style={muted}>로그를 불러오는 중…</Text> : rows.isError ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>로그를 불러오지 못했습니다. 로그 새로고침으로 다시 시도하세요.</Text></View>
        : !entries.length ? <Text style={muted}>{filters.connection || filters.tool ? "조건에 맞는 로그가 없습니다." : "저장된 MCP 통신 기록이 없습니다."}</Text> : null}
      {entries.map((row) => <View key={row.id} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ ...text, fontWeight: "600" }}>{row.tool || row.method || `${row.httpMethod} ${row.path}`} · {outcomes[row.outcome]}</Text>
        <Text style={muted}>{new Date(row.at).toLocaleString()} · {row.durationMs}ms</Text>
        <Text style={muted}>{row.clientName || (row.connectionId ? "연결 이름 없음" : "미인증 요청")}</Text>
        <View style={{ alignItems: "flex-start" }}><Action colors={colors} quiet label={selected === row.id ? "상세 닫기" : `상세 보기 ${row.id.slice(0, 8)}`} expanded={selected === row.id} onPress={() => setSelected(selected === row.id ? null : row.id)} /></View>
        {selected === row.id ? <Detail key={row.id} id={row.id} hostId={hostId} colors={colors} /> : null}
      </View>)}
      {rows.hasNextPage ? <Action colors={colors} label={rows.isFetchingNextPage ? "불러오는 중…" : "이전 로그 더 보기"} disabled={pending || rows.isFetchingNextPage} onPress={() => { void rows.fetchNextPage(); }} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {Platform.OS === "web" ? <Action colors={colors} label={pending && action.variables === "export" ? "내려받는 중…" : "조회한 로그 내려받기"} disabled={pending || !entries.length} onPress={() => action.mutate("export")} /> : null}
        <Action colors={colors} label="전체 로그 삭제" disabled={pending || !state.data?.storedBytes} onPress={() => setConfirmDelete(true)} />
      </View>
      {Platform.OS !== "web" ? <Text style={muted}>각 기록은 펼쳐서 공유할 수 있습니다. 전체 파일 내려받기는 웹에서 지원합니다.</Text> : null}
      {confirmDelete ? <View style={{ gap: 8 }}><Text style={text}>이 호스트에 저장된 모든 로그를 삭제합니다. 현재 필터와 관계없이 삭제하며 복구할 수 없습니다.</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action colors={colors} label="모든 로그 삭제 확인" disabled={pending} onPress={() => action.mutate("clear")} /><Action colors={colors} label="삭제 취소" disabled={pending} onPress={() => setConfirmDelete(false)} />
      </View></View> : null}
    </View> : null}
    {state.isError ? <Action colors={colors} label="로그 상태 다시 불러오기" onPress={() => { void state.refetch(); }} /> : null}
    {action.error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{action.error instanceof Error ? action.error.message : "처리하지 못했습니다. 다시 시도하세요."}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
  </View>;
}
