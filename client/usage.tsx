import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Action } from "./controls";
import { copyText } from "./web";

const services = {
  Claude: { text: "커스텀 커넥터에 MCP 주소를 등록하고 ‘자동으로 등록’(DCR)을 선택하세요. 연결한 커넥터를 채팅에서 켜세요.", url: "https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp" },
  GPT: { text: "ChatGPT의 커스텀 MCP 연결에 주소와 OAuth를 설정하고, 연결한 항목을 채팅에서 선택하세요. 제공 여부는 계정과 워크스페이스 설정에 따라 다릅니다.", url: "https://developers.openai.com/apps-sdk/deploy/connect-chatgpt" },
  Gemini: { text: "Connected Apps의 Custom apps에 MCP 주소를 등록하세요. 계정·지역·언어에 따라 이용 조건이 다릅니다.", url: "https://support.google.com/gemini/answer/17209137" },
  Grok: { text: "grok.com/connectors에서 New Connector → Custom을 선택하고 MCP 주소를 입력한 뒤 OAuth로 연결하세요.", url: "https://docs.x.ai/grok/connectors#custom-mcp-connectors" },
} as const;
const examples = [
  ["작업 맡기기", "Paseo의 '프로젝트 이름'에서 로그인 오류 조사해줘."],
  ["진행 확인", "어디까지 됐어?"],
  ["메시지 보내기", "그 에이전트에게 테스트도 해달라고 보내줘."],
  ["결과 요약", "결과를 세 줄로 요약해줘."],
  ["작업 중단", "그 작업 멈춰줘."],
  ["원본 세션 가져오기", "보관한 '로그인 작업'의 원본 세션을 가져와줘."],
  ["기록으로 새로 시작", "'로그인 작업'의 기록을 요약해서 Codex 새 에이전트에게 넘기고, 남은 테스트를 진행해줘."],
] as const;
const tools = [
  { name: "list_workspaces", title: "워크스페이스 찾기", description: "이 연결에서 허용된 워크스페이스의 이름·경로와 상위 프로젝트를 확인합니다.", example: "Paseo에서 어떤 프로젝트를 쓸 수 있어?" },
  { name: "list_agents", title: "에이전트 목록", description: "허용된 에이전트와 진행 상태를 봅니다. 워크스페이스를 지정해 좁혀 볼 수 있습니다.", example: "상점 프로젝트에서 진행 중인 작업 보여줘." },
  { name: "list_providers", title: "실행 도구 확인", description: "선택한 워크스페이스에서 사용할 수 있는 코딩 제공자와 준비 상태를 확인합니다. 웹 채팅 서비스와 실행 제공자는 별개입니다.", example: "이 프로젝트에서 어떤 코딩 도구를 쓸 수 있어?" },
  { name: "list_models", title: "모델 확인", description: "코딩 제공자에서 선택할 수 있는 모델을 확인합니다. 특정 모델을 원할 때 사용하면 됩니다.", example: "Codex에서 선택할 수 있는 모델 알려줘." },
  { name: "create_agent", title: "새 작업 맡기기", description: "프로젝트 또는 워크스페이스 전체를 허용한 곳에 에이전트를 만들고 작업을 보냅니다. 에이전트만 선택한 곳에서는 생성할 수 없습니다. 응답은 완료가 아닌 접수 확인입니다.", example: "상점 프로젝트에서 로그인 오류 조사해줘." },
  { name: "import_agent", title: "세션·기록 가져오기", description: "원본 가져오기는 기존 제공자 세션을 Paseo에 연결하거나 복구합니다. 현재는 호스트 전체 허용 연결과 제공자의 세션 복구 지원이 필요하며, 작업 지시는 별도로 보냅니다. 기록 인계는 채팅 AI의 요약과 최근 대화·작업 내역으로 새 에이전트를 시작합니다. 원본 조회 권한과 대상 워크스페이스 생성 권한이 필요하며 다른 모델로 넘길 수도 있습니다. 과거 파일 상태는 복원하지 않습니다.", example: "로그인 작업 기록을 요약해서 새 에이전트에게 넘기고 남은 테스트를 진행해줘." },
  { name: "send_agent_prompt", title: "메시지 보내기", description: "기존 에이전트에 후속 지시를 보냅니다. 기본 동작은 진행 중인 작업에 지시를 보태는 것이며, 끼어들기를 요청하면 현재 턴을 중단하고 새 지시를 보냅니다.", example: "그 에이전트에게 테스트도 해달라고 보내줘." },
  { name: "get_agent", title: "진행·결과 확인", description: "상태, 최근 활동, 변경 파일과 마지막 답변을 함께 봅니다. 메시지 기록이나 상태만 볼 수도 있고 최대 20초 기다릴 수 있습니다. 채팅 AI가 이 내용을 바탕으로 결과를 요약합니다.", example: "그 작업 결과를 세 줄로 요약해줘." },
  { name: "cancel_agent", title: "현재 작업 중단", description: "에이전트의 현재 실행을 멈추도록 요청합니다. 에이전트·대화 기록·수정 파일은 남으며 중단 여부는 다시 조회해 확인합니다.", example: "그 작업 멈춰줘." },
] as const;
export function Usage({ theme: { colors } }: Pick<PluginScreenProps, "theme" | "layout" | "host">) {
  const [service, setService] = useState<keyof typeof services>("Claude");
  const [notice, setNotice] = useState("");
  const [showTools, setShowTools] = useState(false);
  const text = { color: colors.foreground, fontSize: 14, lineHeight: 22 };
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 21 };
  return <View style={{ gap: 16, paddingBottom: 20 }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 17, fontWeight: "600" }}>채팅에서 사용하기</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {(Object.keys(services) as (keyof typeof services)[]).map((name) => <Pressable key={name} accessibilityRole="button" accessibilityLabel={`${name} 연결 안내`}
        accessibilityState={{ selected: service === name }} onPress={() => setService(name)} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 8,
          backgroundColor: service === name || pressed ? colors.surface1 : colors.surface0, borderWidth: 1, borderColor: service === name ? colors.accent : colors.border })}>
        <Text style={text}>{name}</Text>
      </Pressable>)}
    </View>
    <Text style={text}>{services[service].text}</Text>
    <ExternalLink href={services[service].url}><Text style={{ ...muted, textDecorationLine: "underline" }}>{service} 공식 연결 안내</Text></ExternalLink>
    <Text style={muted}>인증 창에 연결 비밀키를 입력하고, 이 메인 화면에서 워크스페이스를 선택해 승인하면 됩니다. 연결한 채팅은 작업 요청·메시지 전송·중단을 할 수 있습니다.</Text>
    <Text style={muted}>연결 → 연결된 채팅의 접근 범위에서 프로젝트 → 워크스페이스 → 에이전트 순서로 선택하세요. 상위를 허용하면 앞으로 만드는 하위 항목도 포함합니다. 저장한 범위는 재연결 없이 적용됩니다.</Text>
    <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>여러 호스트 사용하기</Text>
    <Text style={text}>제어할 호스트마다 pasear를 설치하세요. 상단 호스트 선택에서 대상을 고르고 서버를 켜면 그 호스트 안에서 실행됩니다. 설정·연결·접근 범위는 호스트마다 따로 관리합니다.</Text>
    <Text style={muted}>채팅에는 호스트별 공개 MCP 주소를 각각 등록하세요. Paseo에서 호스트를 바꿔도 이미 연결한 채팅의 대상은 바뀌지 않습니다. 다른 호스트로 전환해도 켜 둔 서버는 계속 실행됩니다.</Text>
    <View style={{ alignItems: "flex-start" }}><Action colors={colors} label={showTools ? "도구 안내 접기" : `도구 ${tools.length}개 알아보기`} onPress={() => setShowTools(!showTools)} /></View>
    {showTools ? <View style={{ gap: 16 }}>
      <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>도구별 사용법</Text>
      <Text style={muted}>도구 이름을 직접 말할 필요는 없습니다. 채팅 AI가 요청에 맞는 도구를 선택합니다.</Text>
      {tools.map((tool) => <View key={tool.name} style={{ gap: 6, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text accessibilityRole="header" style={{ ...text, fontWeight: "600" }}>{tool.title}</Text>
        <Text selectable style={muted}>{tool.name}</Text>
        <Text style={text}>{tool.description}</Text>
        <Text selectable style={muted}>예: “{tool.example}”</Text>
      </View>)}
    </View> : null}
    <Text accessibilityRole="header" style={{ ...text, fontWeight: "600", marginTop: 8 }}>이렇게 말하세요</Text>
    {examples.map(([title, prompt]) => <View key={title} style={{ gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
      <Text style={muted}>{title}</Text><Text selectable style={text}>{prompt}</Text>
      {Platform.OS === "web" ? <View style={{ alignItems: "flex-start" }}><Action colors={colors} label={`${title} 예시 복사`} onPress={() => { void copyText(prompt).then((copied) => setNotice(copied ? "예시를 복사했습니다." : "문장을 선택해서 복사하세요.")); }} /></View> : null}
    </View>)}
    {notice ? <Text accessibilityLiveRegion="polite" style={muted}>{notice}</Text> : null}
    <Text style={muted}>같은 채팅에서는 짧게 이어 말하세요. 새 채팅에서는 작업 이름이나 ID를 알려주세요. 이름이 겹치면 대상을 선택합니다.</Text>
    <Text style={muted}>작업 접수는 완료가 아닙니다. 결과는 다시 조회하며, 닫힌 채팅으로 알림을 자동 전송하지 않습니다. 각 서비스의 실제 계정 연결은 별도 검증이 필요합니다.</Text>
  </View>;
}
