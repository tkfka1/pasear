import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Pressable, Text } from "react-native";

export type Colors = PluginScreenProps["theme"]["colors"];
export function Action({ label, onPress, disabled, primary, colors }: {
  label: string; onPress(): void; disabled?: boolean; primary?: boolean; colors: Colors;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
    disabled={disabled} onPress={onPress} style={({ pressed }) => ({
      minHeight: 44, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 8,
      backgroundColor: primary ? colors.accent : colors.surface1,
      opacity: disabled ? 0.45 : pressed ? 0.7 : 1, alignItems: "center", justifyContent: "center",
    })}>
    <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontSize: 14, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
}
