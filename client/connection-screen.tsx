import { useState } from "react";
import { Platform, Text, View } from "react-native";
import type { McpConfig } from "../shared/mcp";
import { Action, type Colors } from "./controls";
import { copyText } from "./web";

export function ConnectionDetails({ colors, values, running, onEdit, onNotice }: {
  colors: Colors; values: McpConfig; running: boolean; onEdit(): void; onNotice(message: string): void;
}) {
  const [showKey, setShowKey] = useState(false);
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  async function copy(value: string) { onNotice(await copyText(value) ? "복사했습니다." : "텍스트를 선택하거나 길게 눌러 복사하세요."); }
  return <View style={{ gap: 20 }}>
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={muted}>MCP 주소</Text>
        <View style={{ flexDirection: "row", gap: 4 }}>
          {Platform.OS === "web" ? <Action colors={colors} quiet label="주소 복사" onPress={() => { void copy(values.publicUrl); }} /> : null}
          <Action colors={colors} quiet label="설정" disabled={running} onPress={onEdit} />
        </View>
      </View>
      <Text selectable style={text}>{values.publicUrl}</Text>
      {running ? <Text style={muted}>설정 변경은 서버를 끈 뒤 가능합니다.</Text> : null}
    </View>
    {values.connectionKey ? <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
        <Text style={muted}>연결 비밀키</Text>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Action colors={colors} quiet label={showKey ? "비밀키 숨기기" : "비밀키 보기"} onPress={() => setShowKey(!showKey)} />
          {Platform.OS === "web" ? <Action colors={colors} quiet label="비밀키 복사" onPress={() => { void copy(values.connectionKey); }} /> : null}
        </View>
      </View>
      {showKey ? <Text selectable style={text}>{values.connectionKey}</Text> : null}
      <Text style={muted}>OAuth 인증 창에만 입력하세요.</Text>
    </View> : null}
  </View>;
}
