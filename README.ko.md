# pasear

Claude·ChatGPT·Gemini·Grok 웹 채팅에서 내 Paseo 에이전트에 일을 맡기고, 메시지를 보내고, 진행 상황과 결과를 확인합니다.

[English](README.md) · [상세 안내](docs/reference.ko.md)

![햇빛이 드는 숲속 산책길](assets/forest-path.png)

## 설치

Paseo 데몬·앱 0.11.2 이상, 플러그인 활성화, npm과 호스트의 `paseo` CLI가 필요합니다.

**2026-11-05 확인 환경:** Paseo CLI·데몬 **0.15.0**, Node.js **24.21.0**, npm **11.19.0**. [언어·라이브러리 버전과 확인 범위](docs/reference.ko.md#버전).

```bash
paseo plugin add tkfka1/pasear
```

Paseo 플러그인 목록에서 **pasear**를 찾아 설치해도 됩니다. 목록 설치는 검토가 끝난 버전을 사용하므로 GitHub보다 늦을 수 있습니다. GitHub의 **v0.14.0**을 직접 설치하려면:

```bash
paseo plugin add git:tkfka1/pasear --ref v0.14.0
```

기존 설치는 `paseo plugin update paseo-mcp-plugin`으로 업데이트합니다. Git 직접 설치에서 이 릴리스를 지정하려면 `paseo plugin update paseo-mcp-plugin --ref v0.14.0`을 사용합니다. 업데이트 후 MCP 서버를 다시 시작하세요. 저장한 설정과 승인된 연결은 유지됩니다.

Paseo 사이드바에서 **pasear**를 열고 아래 두 방법 중 하나로 연결합니다.

## 방법 1 · 외부 프록시

1. LB·리버스 프록시에서 `https://mcp.example.com` 같은 공개 HTTPS 도메인을 Paseo 호스트의 HTTP `8787` 포트로 연결합니다.
2. pasear의 수신 주소는 프록시가 다른 머신이면 `0.0.0.0:8787`, 같은 호스트이면 `127.0.0.1:8787`로 설정합니다.
3. **Public MCP URL**에 해당 HTTPS 도메인을 입력하고 **Save and start**를 누릅니다.

도메인의 **모든 경로**를 전달하세요. `/`, `/mcp`, `/oauth/*`, `/.well-known/*`, `/authorize`, `/register`, `/token`, `/revoke`가 필요합니다. 경로와 Authorization 헤더를 그대로 전달합니다.

## 방법 2 · Tailscale Funnel

Paseo 호스트에 [Tailscale을 설치하고 로그인](https://tailscale.com/docs/install)한 뒤 실행합니다.

```bash
tailscale funnel --bg http://127.0.0.1:8787
```

처음 실행할 때 Funnel 활성화 안내가 나오면 완료합니다. 표시된 `https://<머신>.<테일넷>.ts.net` 주소를 pasear의 **Public MCP URL**에 넣고, 고급 설정에서 `127.0.0.1:8787`을 선택한 뒤 **Save and start**를 누릅니다.

Funnel은 인터넷에서 접근 가능한 HTTPS 주소를 제공합니다. Tailscale Serve만 켜면 사설 테일넷에서만 접근됩니다. [Funnel 공식 안내](https://tailscale.com/docs/features/tailscale-funnel)

## 채팅 연결

브라우저에서 사용할 웹 채팅을 열고 커스텀 MCP를 추가합니다.

네 서비스의 공식 등록 안내 확인일은 **2026-11-05**입니다. **GPT(Codex)·Gemini·Grok은 사용자가 2026-11-06에 실제 사용 확인을 완료했습니다.** [확인 상세](docs/reference.ko.md#버전)

| 채팅 · 공식 안내 | pasear 등록 위치 |
| --- | --- |
| [Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | **사용자 지정(Customize) → 커넥터 → 추가 → 커스텀 커넥터 추가**. 인증은 **지금 로그인**, OAuth 클라이언트는 **자동으로 등록(DCR)**을 선택합니다. |
| [ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) | **Plugins → + → Add custom MCP server**. OAuth와 자동 클라이언트 등록(DCR)을 선택하고 **Create as a plugin**으로 만듭니다. |
| [Gemini](https://developers.google.com/connected-apps/mcp/dev-mode/usage) | **설정 → Gemini Apps Developer Mode → Choose an app → + Create new**. 주소를 입력해 연결하고 앱 이름을 정합니다. 클라이언트 인증은 DCR을 사용합니다. |
| [Grok](https://docs.x.ai/grok/connectors#custom-mcp-connectors) | [grok.com/connectors](https://grok.com/connectors) → **New Connector → Custom**. 주소를 입력하고 OAuth 인증을 진행합니다. |

1. 이름은 **pasear**, 주소는 같은 공개 HTTPS 주소를 입력합니다. 도메인만 입력해도 되고 `/mcp`를 붙여도 됩니다. 인증은 OAuth·자동 등록(DCR)을 사용하며 클라이언트 ID·시크릿·커스텀 요청 헤더는 비워 둡니다.
2. 열린 OAuth 브라우저 창에 pasear의 **Connection key**를 입력합니다.
3. pasear의 **Connections** 탭에서 확인 코드·돌아갈 주소를 확인하고, 허용할 프로젝트·워크스페이스·에이전트를 선택해 승인합니다.
4. 채팅에서 pasear를 켭니다. Claude는 **+ → 커넥터**, ChatGPT는 플러그인 설치 후 **@pasear**, Gemini는 앱 선택 또는 **@pasear**를 사용합니다. “지금 작업 목록 보여줘”, “로그인 작업에 테스트하라고 하고 결과 요약해줘”처럼 말하세요.

메뉴와 지원 여부는 계정·지역·워크스페이스 정책에 따라 다릅니다. 메뉴가 없다면 위 공식 안내에서 조건을 확인하세요. 호스트마다 공개 주소와 승인이 필요하며, 플러그인 리로드 후에는 **Start server**를 다시 누릅니다.

## 결과 기다리기

“로그인 에이전트에 테스트하라고 하고, 끝날 때까지 기다렸다가 결과 요약해줘”라고 요청하세요. 채팅 AI가 `wait_for_agent`를 반복 호출해 사람이 매번 진행 확인을 요청하지 않아도 됩니다.

```json
{"agentId":"<에이전트 ID>","timeoutSeconds":15,"pollIntervalSeconds":2}
```

한 번의 폴링·요약 대기 예산은 최대 20초(기본 15초)이며 마지막 메시지 조회 시간을 일부 남깁니다. `idle`·`closed`·`error` 또는 사용자 승인 대기 상태면 반환합니다. 관측 상태, `lastMessageSummary`(채팅 AI가 요약할 최대 1,000자 발췌), `timedOut`을 제공하며, 시간 초과면 같은 ID로 다시 호출합니다. 승인·질문은 채팅에서 `respond_to_agent`로 응답하거나 Paseo에서 처리합니다. `idle`이 성공을 보장하지 않으며 메시지는 이전 턴의 내용이거나 조회되지 않을 수 있습니다.

여러 작업은 `agentId` 대신 `agentIds`에 최대 10개를 넣습니다. 폴링 회차에서 먼저 종료·승인 대기로 관측된 대상을 반환하고, 같은 회차에 관측되면 입력 순서를 따릅니다. 나머지는 `remainingAgentIds`로 이어서 기다립니다. 반복 호출은 채팅 클라이언트가 계속 도구를 실행할 수 있어야 하며 백그라운드 알림은 아닙니다. [도구 상세](docs/reference.ko.md#에이전트-완료-대기)

작업이 승인이나 답변을 요구하면 채팅이 요청 내용과 선택지를 보여줍니다. “그건 승인해”, “거절해”, “두 번째로 해”라고 하거나 텍스트로 답하세요. `respond_to_agent`가 명시한 결정을 전달하며, 지원되는 질문은 다중 선택도 가능합니다. 응답 후 다시 완료를 기다릴 수 있습니다. 요청 ID와 지문은 채팅이 처리하고, 지원하지 않거나 너무 큰 양식은 Paseo에서 처리합니다. [응답 상세](docs/reference.ko.md#승인거절과-질문-응답)

## 즉시 전달과 완료 후 지시

`send_agent_prompt`는 이미 두 공개 옵션을 지원합니다. 기본값인 `behavior="steer"`는 제공자가 지원하면 실행 중인 턴에 전달하고, 지원하지 않으면 중단·교체합니다. `behavior="interrupt"`는 현재 턴을 중단·교체합니다. 쉬고 있는 에이전트에는 새 턴을 시작합니다. 둘 다 현재 작업이 끝날 때까지 기다리는 큐가 아닙니다.

Paseo 앱에는 메시지 큐가 있지만, 아직 이를 조작하는 공개 API가 없습니다. **pasear는 현재 메시지 큐를 지원하지 않으며, 공개 API가 제공되면 지원할 예정입니다.**

현재 대안으로 “이거 끝나면 테스트해줘”는 채팅이 `wait_for_agent`를 반복해 `idle`을 확인하고 결과를 점검한 다음 `send_agent_prompt`를 호출하는 방식으로 처리합니다. 승인 대기·오류·닫힘은 따로 처리해야 합니다. 채팅이 계속 실행되어야 하며 영속 큐나 원자적인 예약은 아닙니다. 두 호출 사이에 다른 발신자가 새 턴을 시작할 수도 있습니다. 제공자별 정확한 반영 시점은 실측하지 않았습니다. [확인한 동작과 한계](docs/reference.ko.md#메시지-전달과-큐)

## 에이전트 정리

“로그인 에이전트 닫아줘”, “그 작업 보관해줘”, “그 에이전트와 Paseo 기록 삭제해줘”처럼 요청합니다. 세 도구 모두 `agentId`(ID 또는 정확히 일치하는 고유 이름)만 받으며, 도구 안에서 추가 확인 없이 즉시 실행합니다.

| 도구 | 동작 |
| --- | --- |
| `close_agent` | Paseo 화면의 닫기와 동일하게 보관 처리 |
| `archive_agent` | 실행을 닫고 보관. 일반 저장 에이전트의 기록은 `list_agents(includeArchived=true)`로 조회 |
| `delete_agent` | 로컬 CLI로 실행 중이면 중단 후 해당 에이전트 하나의 Paseo 레코드·타임라인을 삭제. 삭제 요청 접수 결과 반환 |

닫기·보관은 하위 에이전트까지 연쇄 처리될 수 있어 **호스트 전체 허용 연결**에서만 가능합니다. 제한된 연결에서도 허용된 에이전트 삭제와 기존 `cancel_agent` 실행 중단은 가능합니다. 접근 범위를 자동으로 넓히지 않습니다. 정리는 워크스페이스 파일·브랜치를 지우거나 변경을 되돌리지 않으며, 삭제가 제공자 원본 기록의 완전한 삭제까지 보장하지는 않습니다. [복구와 구현 상세](docs/reference.ko.md#에이전트-정리)

**Logs** 탭에서 페이지별 기록 조회와 **Collection off**을 선택할 수 있습니다. 기본 수집은 켜져 있고 최근 7일·최대 50MiB를 보관합니다. 알려진 인증 값은 가리지만 작업 본문에는 민감한 내용이 포함될 수 있습니다.

[MIT](LICENSE)
