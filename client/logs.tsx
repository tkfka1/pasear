import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, Share, Text, TextInput, View } from "react-native";
import { clearLogs, configureLogs, exportLogs, getLogDetail, getLogStatus, listLogs } from "../shared/logs";
import { Action, type Colors } from "./controls";
import { downloadText } from "./web";

const outcomes = { ok: "Success", error: "Error", unauthorized: "Unauthorized", aborted: "Aborted" };
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function Detail({ id, hostId, colors }: { id: string; hostId: string; colors: Colors }) {
  const rpc = useRpc(getLogDetail);
  const detail = useQuery({ queryKey: ["pasear-log-detail", hostId, id], queryFn: () => rpc({ id }), retry: false });
  const [notice, setNotice] = useState("");
  const text = { color: colors.foreground, fontSize: 13, lineHeight: 21 };
  if (detail.isPending) return <Text style={text}>Loading log details…</Text>;
  if (detail.error) return <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>Could not load this record. It may have been deleted or the host disconnected.</Text><Action colors={colors} label="Reload details" onPress={() => { void detail.refetch(); }} /></View>;
  const row = detail.data!;
  const content = JSON.stringify(row, null, 2);
  return <View style={{ gap: 12 }}>
    <Text selectable style={text}>Connection ID · {row.connectionId ?? "Unauthenticated"}</Text>
    <Text style={text}>{row.httpMethod} {row.path} · HTTP {row.status}</Text>
    {([['Request', row.request], ['Response', row.response]] as const).map(([label, body]) => {
      const value = JSON.stringify(body, null, 2) ?? "null";
      return <View key={label} style={{ gap: 6 }}>
        <Text style={{ ...text, fontWeight: "600" }}>{label}</Text>
        <ScrollView style={{ maxHeight: 300, backgroundColor: colors.surface1, borderRadius: 8 }} nestedScrollEnabled>
          <ScrollView horizontal contentContainerStyle={{ padding: 12 }}><Text selectable style={{ ...text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>{value.slice(0, 32000)}</Text></ScrollView>
        </ScrollView>
        {value.length > 32000 ? <Text style={text}>Showing a preview. Download or share the record to view the full stored content.</Text> : null}
      </View>;
    })}
    <Action colors={colors} label={Platform.OS === "web" ? "Download record" : "Share record"} onPress={() => {
      if (Platform.OS === "web") setNotice(downloadText([JSON.stringify(row) + "\n"], `pasear-${id}.jsonl`) ? "Record downloaded." : "Download failed. Check your browser download settings.");
      else void Share.share({ message: content, title: "pasear traffic log" }).catch(() => setNotice("Could not share. Press and hold the text to copy it."));
    }} />
    {notice ? <Text accessibilityLiveRegion="polite" style={text}>{notice}</Text> : null}
  </View>;
}

export function Logs({ colors, hostId, active, onNavigate }: { colors: Colors; hostId: string; active: boolean; onNavigate(): void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [connection, setConnection] = useState(""), [tool, setTool] = useState(""), [filters, setFilters] = useState({ connection: "", tool: "" });
  const [confirmDelete, setConfirmDelete] = useState(false), [notice, setNotice] = useState("");
  const [focused, setFocused] = useState("");
  const statusRpc = useRpc(getLogStatus), configureRpc = useRpc(configureLogs), clearRpc = useRpc(clearLogs), listRpc = useRpc(listLogs), exportRpc = useRpc(exportLogs);
  const cache = useQueryClient();
  const stateKey = ["pasear-log-status", hostId];
  const state = useQuery({ queryKey: stateKey, queryFn: () => statusRpc({}), enabled: active, refetchInterval: active ? 5000 : false });
  const applied = { connection: filters.connection || undefined, tool: filters.tool || undefined };
  const before = cursors[cursors.length - 1];
  const rows = useQuery({ queryKey: ["pasear-logs", hostId, filters, before],
    queryFn: () => listRpc({ ...applied, before, limit: 25 }), enabled: active, retry: false });
  useEffect(() => {
    const next = { connection: connection.trim(), tool: tool.trim() };
    if (next.connection === filters.connection && next.tool === filters.tool) return;
    const timer = setTimeout(() => { setFilters(next); setCursors([undefined]); setSelected(null); }, 300);
    return () => clearTimeout(timer);
  }, [connection, tool, filters]);
  const action = useMutation({ mutationFn: async (kind: "collect" | "skip" | "clear" | "export") => {
    setNotice("");
    if (kind === "collect" || kind === "skip") return configureRpc({ enabled: kind === "collect" });
    if (kind === "clear") {
      const result = await clearRpc({}); setCursors([undefined]); setSelected(null); setConfirmDelete(false);
      cache.removeQueries({ queryKey: ["pasear-log-detail", hostId] });
      await cache.resetQueries({ queryKey: ["pasear-logs", hostId] }); setNotice("Saved logs deleted."); return result;
    }
    const parts: string[] = []; let cursor: string | undefined;
    do { const page = await exportRpc({ ...applied, cursor }); parts.push(page.content); cursor = page.nextCursor ?? undefined; } while (cursor);
    if (!downloadText(parts, `pasear-logs-${new Date().toISOString().slice(0, 10)}.jsonl`)) throw Error("Download failed. Check your browser download settings.");
    setNotice("Matching logs downloaded.");
  }, onSuccess: (result) => { if (result) cache.setQueryData(stateKey, result); }, onSettled: () => { void state.refetch(); } });
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  const pending = action.isPending;
  const entries = rows.data?.entries ?? [];
  function navigate(next: (string | undefined)[]) { setCursors(next); setSelected(null); onNavigate(); }
  function refresh() {
    setCursors([undefined]); setSelected(null);
    void cache.resetQueries({ queryKey: ["pasear-logs", hostId] }); void state.refetch(); onNavigate();
  }
  function pager(position: string) {
    return <View accessibilityLabel={`Log pagination ${position}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Action colors={colors} label="Previous page" disabled={pending || rows.isFetching || cursors.length === 1} onPress={() => navigate(cursors.slice(0, -1))} />
      <Text accessibilityLiveRegion="polite" style={muted}>Page {cursors.length} · {entries.length} records</Text>
      <Action colors={colors} label="Next page" disabled={pending || rows.isFetching || !rows.data?.nextCursor || rows.isError} onPress={() => { if (rows.data?.nextCursor) navigate([...cursors, rows.data.nextCursor]); }} />
    </View>;
  }
  function input(label: string, value: string, set: (v: string) => void) {
    return <TextInput accessibilityLabel={label} placeholder={label} placeholderTextColor={colors.foregroundMuted} value={value} onChangeText={set} maxLength={200} autoCapitalize="none" autoCorrect={false}
      onFocus={() => setFocused(label)} onBlur={() => setFocused("")} style={{ ...text, fontSize: 16, minHeight: 44, padding: 12, borderWidth: 1, borderColor: focused === label ? colors.accent : colors.border, borderRadius: 8 }} />;
  }
  return <View nativeID="pasear-logs-panel" style={{ display: active ? "flex" : "none", gap: 16 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>Traffic logs</Text>
    </View>
    <Text accessibilityLiveRegion="polite" style={muted}>{state.data ? `${state.data.enabled ? "Collecting" : "Collection off"} · ${size(state.data.storedBytes)} · ${state.data.retentionDays} days, up to ${size(state.data.maxBytes)}` : state.isError ? "Could not load logging status." : "Loading logging status…"}</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel="Log collection" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {([[true, "Collection on"], [false, "Collection off"]] as const).map(([enabled, label]) => {
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
    {state.data?.enabled === false ? <Text style={muted}>New traffic and tool activity are not collected. Existing logs remain until you delete them.</Text> : null}
    {state.data?.error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{state.data.error}</Text> : null}
    {state.data?.dropped ? <Text style={{ ...muted, color: colors.statusDanger }}>{state.data.dropped} records could not be saved during this run. Check storage errors or recording limits.</Text> : null}
    <View style={{ gap: 16 }}>
      <Text style={muted}>MCP requests and responses are stored on this host. Auth headers and OAuth bodies are excluded; known credentials are redacted. Bodies may contain task content. Response bodies over 1 MiB are marked as omitted.</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action colors={colors} label="Refresh logs" disabled={pending || rows.isFetching} onPress={refresh} />
      </View>
      <View style={{ gap: 8 }}>{input("Filter by connection name or ID", connection, setConnection)}{input("Filter by tool name", tool, setTool)}</View>
      {rows.isPending ? <Text style={muted}>Loading logs…</Text> : rows.isError ? <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>Could not load logs. Select Refresh logs to try again.</Text></View>
        : !entries.length ? <Text style={muted}>{filters.connection || filters.tool ? "No matching logs." : "No MCP traffic recorded."}</Text> : null}
      {pager("Top")}
      {entries.map((row) => <View key={row.id} style={{ gap: 8, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ ...text, fontWeight: "600" }}>{row.tool || row.method || `${row.httpMethod} ${row.path}`} · {outcomes[row.outcome]}</Text>
        <Text style={muted}>{new Date(row.at).toLocaleString()} · {row.durationMs}ms</Text>
        <Text style={muted}>{row.clientName || (row.connectionId ? "Unnamed connection" : "Unauthenticated request")}</Text>
        <View style={{ alignItems: "flex-start" }}><Action colors={colors} quiet label={selected === row.id ? "Hide details" : `View details ${row.id.slice(0, 8)}`} expanded={selected === row.id} onPress={() => setSelected(selected === row.id ? null : row.id)} /></View>
        {selected === row.id ? <Detail key={row.id} id={row.id} hostId={hostId} colors={colors} /> : null}
      </View>)}
      {entries.length > 5 ? pager("Bottom") : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {Platform.OS === "web" ? <Action colors={colors} label={pending && action.variables === "export" ? "Downloading…" : "Download matching logs"} disabled={pending || !entries.length} onPress={() => action.mutate("export")} /> : null}
        <Action colors={colors} label="Delete all logs" disabled={pending || !state.data?.storedBytes} onPress={() => setConfirmDelete(true)} />
      </View>
      {Platform.OS !== "web" ? <Text style={muted}>Expand a record to share it. Full log downloads are available on the web.</Text> : null}
      {confirmDelete ? <View style={{ gap: 8 }}><Text style={text}>Delete all logs stored on this host, including records outside the current filter. This cannot be undone.</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Action colors={colors} label="Confirm delete all logs" disabled={pending} onPress={() => action.mutate("clear")} /><Action colors={colors} label="Cancel deletion" disabled={pending} onPress={() => setConfirmDelete(false)} />
      </View></View> : null}
    </View>
    {state.isError ? <Action colors={colors} label="Reload logging status" onPress={() => { void state.refetch(); }} /> : null}
    {action.error ? <Text accessibilityRole="alert" style={{ ...text, color: colors.statusDanger }}>{action.error instanceof Error ? action.error.message : "Could not complete the action. Try again."}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
  </View>;
}
