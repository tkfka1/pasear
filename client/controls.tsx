import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text } from "react-native";

export type Colors = PluginScreenProps["theme"]["colors"];
export function Action({ label, onPress, disabled, primary, quiet, expanded, colors }: {
  label: string; onPress(): void; disabled?: boolean; primary?: boolean; quiet?: boolean; expanded?: boolean; colors: Colors;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled, ...(expanded === undefined ? {} : { expanded }) }}
    disabled={disabled} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={({ pressed }) => ({
      minHeight: 44, paddingHorizontal: quiet ? 10 : 16, paddingVertical: 10, borderRadius: 8,
      borderWidth: 1, borderColor: focused ? colors.accent : "transparent",
      backgroundColor: primary ? colors.accent : quiet && !hovered && !pressed ? "transparent" : colors.surface1,
      opacity: disabled ? 0.45 : pressed ? 0.75 : 1, alignItems: "center", justifyContent: "center",
    })}>
    <Text style={{ color: primary ? colors.accentForeground : colors.foreground, fontSize: 14, lineHeight: 22, fontWeight: "600" }}>{label}</Text>
  </Pressable>;
}
