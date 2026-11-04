import { useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import type { McpConfig, McpStatus } from "../shared/mcp";
import { Action, type Colors } from "./controls";
import { copyText } from "./web";

export function ConnectionDetails({ colors, hostLabel, values, status, active, notice, onNotice }: {
  colors: Colors; hostLabel: string; values: McpConfig; status?: McpStatus; active: boolean; notice: string; onNotice(message: string): void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [details, setDetails] = useState(false);
  useEffect(() => { if (!active) setShowKey(false); }, [active]);
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  async function copy(value: string) { onNotice(await copyText(value) ? "복사했습니다." : "텍스트를 선택하거나 길게 눌러 복사하세요."); }
  return <View style={{ gap: 12, paddingTop: 24, borderTopWidth: 1, borderTopColor: colors.border }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 17, fontWeight: "600" }}>새 채팅 연결</Text>
    <Text style={muted}>{hostLabel}의 MCP 주소를 채팅에 등록하고 OAuth로 연결하세요.</Text>
    {values.publicUrl ? <Text selectable style={{ ...text, padding: 12, backgroundColor: colors.surface1, borderRadius: 8 }}>{values.publicUrl}</Text> : <Text style={muted}>설정에서 공개 HTTPS 주소를 먼저 저장하세요.</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {values.publicUrl && Platform.OS === "web" ? <Action colors={colors} label="MCP 주소 복사" onPress={() => { void copy(values.publicUrl); }} /> : null}
      {values.connectionKey && Platform.OS === "web" ? <Action colors={colors} label="연결 비밀키 복사" onPress={() => { void copy(values.connectionKey); }} /> : null}
      {values.connectionKey ? <Action colors={colors} label={showKey ? "비밀키 숨기기" : "비밀키 보기"} onPress={() => setShowKey(!showKey)} /> : null}
    </View>
    {notice ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
    {showKey ? <Text selectable style={text}>{values.connectionKey}</Text> : null}
    <Text style={muted}>인증 창에 비밀키를 입력한 뒤, 이 화면에서 연결을 승인하세요. 키는 채팅에 보내지 않습니다.</Text>
    {status?.running === false ? <Text style={muted}>연결을 시작하려면 위에서 서버를 켜세요.</Text> : null}
    <Action colors={colors} label={details ? "프록시 정보 접기" : "프록시 정보"} onPress={() => setDetails(!details)} />
    {details ? <View style={{ gap: 8 }}>
      <Text selectable style={text}>LB 연결 대상: {status?.upstreamUrl ?? `http://${values.host === "0.0.0.0" ? "127.0.0.1" : values.host}:${values.port}/mcp`}</Text>
      <Text style={muted}>다른 머신의 LB는 이 호스트의 접근 가능한 IP를 사용하세요. 전용 도메인의 모든 경로를 같은 포트로 전달하면 됩니다.</Text>
      <Text style={muted}>개별 매핑 시: /mcp, /.well-known/, /authorize, /token, /register, /revoke, /oauth/.</Text>
    </View> : null}
  </View>;
}
