import { useEffect, useState, type RefObject } from "react";
import { AccessibilityInfo, AppState, Image, Pressable, Text, View } from "react-native";
import { Action, type Colors } from "./controls";
import { dogAtlas } from "./dog-atlas";

function Dog({ width, active, paused, dogRef, onDogLayout }: { width: number; active: boolean; paused: boolean; dogRef: RefObject<View | null>; onDogLayout(): void }) {
  const [frame, setFrame] = useState(0);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!active || paused || !foreground) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % 8), 110);
    return () => clearInterval(timer);
  }, [active, paused, foreground]);
  return <View ref={dogRef} onLayout={onDogLayout} nativeID="pasear-dog" accessibilityRole="image" accessibilityLabel="산책하는 작은 강아지" style={{ width, height: width * (300 / 384), overflow: "hidden" }}>
    <Image accessible={false} source={{ uri: dogAtlas }} resizeMode="stretch" style={{
      position: "absolute", width: width * 4, height: width * (1024 / 384),
      left: -(frame % 4) * width, top: -Math.floor(frame / 4) * width * (512 / 384) - width * (130 / 384),
    }} />
  </View>;
}

export function WalkScene({ colors, compact, active, dogRef, onDogLayout, panel, onPanel }: {
  colors: Colors; compact: boolean; active: boolean; panel: "settings" | "connections" | "usage" | null;
  dogRef: RefObject<View | null>; onDogLayout(): void;
  onPanel(panel: "settings" | "connections"): void;
}) {
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    let disposed = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (!disposed) setReducedMotion(enabled); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);
    return () => { disposed = true; subscription.remove(); };
  }, []);
  function sideButton(value: "settings" | "connections", label: string, lines: string) {
    const selected = panel === value;
    return <Pressable nativeID={`pasear-open-${value}`} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ expanded: selected }} onPress={() => onPanel(value)}
      style={({ pressed }) => ({ width: compact ? 68 : 88, minHeight: compact ? 64 : 72,
        padding: compact ? 8 : 16, borderRadius: 12, borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border, backgroundColor: selected || pressed ? colors.surface1 : colors.surface0,
        alignItems: "center", justifyContent: "center", opacity: pressed ? 0.7 : 1 })}>
      <Text style={{ textAlign: "center", color: selected ? colors.accent : colors.foreground, fontSize: 14, lineHeight: 21, fontWeight: "600" }}>{lines}</Text>
    </Pressable>;
  }
  return <View style={{ paddingTop: compact ? 24 : 32, paddingBottom: 8, gap: 12 }}>
    <View style={{ alignItems: "center", gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 28, lineHeight: 36, fontWeight: "600", letterSpacing: -0.7 }}>pasear</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 22, textAlign: "center" }}>Claude · GPT · Gemini · Grok</Text>
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: compact ? 12 : 32, paddingTop: 8 }}>
      {sideButton("settings", "설정 열기", "설정")}
      <View style={{ alignItems: "center" }}>
        <Dog width={compact ? 150 : 210} active={active} paused={paused || reducedMotion} dogRef={dogRef} onDogLayout={onDogLayout} />
        <View style={{ height: 1, width: compact ? 135 : 190, backgroundColor: colors.border, marginTop: -(compact ? 150 : 210) * (20 / 384) }} />
      </View>
      {sideButton("connections", "연결 열기", "연결")}
    </View>
    <View style={{ alignItems: "center", minHeight: 44 }}>
      {reducedMotion ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 20, paddingVertical: 12 }}>움직임 줄이기 적용 중</Text>
        : <Action colors={colors} label={paused ? "움직임 재생" : "움직임 멈추기"} onPress={() => setPaused(!paused)} />}
    </View>
  </View>;
}
