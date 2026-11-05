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
  async function copy(value: string) { onNotice(await copyText(value) ? "Copied." : "Select or press and hold the text to copy it."); }
  return <View style={{ gap: 20 }}>
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={muted}>MCP URL</Text>
        <View style={{ flexDirection: "row", gap: 4 }}>
          {Platform.OS === "web" ? <Action colors={colors} quiet label="Copy URL" onPress={() => { void copy(values.publicUrl); }} /> : null}
          <Action colors={colors} quiet label="Settings" disabled={running} onPress={onEdit} />
        </View>
      </View>
      <Text selectable style={text}>{values.publicUrl}</Text>
      {running ? <Text style={muted}>Stop the server to change settings.</Text> : null}
    </View>
    {values.connectionKey ? <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
        <Text style={muted}>Connection key</Text>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Action colors={colors} quiet label={showKey ? "Hide key" : "Show key"} onPress={() => setShowKey(!showKey)} />
          {Platform.OS === "web" ? <Action colors={colors} quiet label="Copy key" onPress={() => { void copy(values.connectionKey); }} /> : null}
        </View>
      </View>
      {showKey ? <Text selectable style={text}>{values.connectionKey}</Text> : null}
      <Text style={muted}>Enter this key only in the OAuth sign-in window.</Text>
    </View> : null}
  </View>;
}
