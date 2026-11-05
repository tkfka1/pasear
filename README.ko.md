# pasear

Claude·ChatGPT·Gemini·Grok 웹 채팅에서 내 Paseo 에이전트에 일을 맡기고, 메시지를 보내고, 진행 상황과 결과를 확인합니다.

[English](README.md) · [상세 안내](docs/reference.ko.md)

![햇빛이 드는 숲속 산책길](assets/forest-path.png)

## 설치

Paseo 데몬·앱 0.11.2 이상, 플러그인 활성화, npm과 호스트의 `paseo` CLI가 필요합니다.

```bash
paseo plugin add git:tkfka1/pasear --ref v0.12.2
```

Paseo 사이드바에서 **pasear**를 열고 아래 두 방법 중 하나로 연결합니다.

## 방법 1 · 외부 프록시

1. LB·리버스 프록시에서 `https://mcp.example.com` 같은 공개 HTTPS 도메인을 Paseo 호스트의 HTTP `8787` 포트로 연결합니다.
2. pasear의 수신 주소는 프록시가 다른 머신이면 `0.0.0.0:8787`, 같은 호스트이면 `127.0.0.1:8787`로 설정합니다.
3. **공개 MCP 주소**에 해당 HTTPS 도메인을 입력하고 **저장하고 켜기**를 누릅니다.

도메인의 **모든 경로**를 전달하세요. `/`, `/mcp`, `/oauth/*`, `/.well-known/*`, `/authorize`, `/register`, `/token`, `/revoke`가 필요합니다. 경로와 Authorization 헤더를 그대로 전달합니다.

## 방법 2 · Tailscale Funnel

Paseo 호스트에 [Tailscale을 설치하고 로그인](https://tailscale.com/docs/install)한 뒤 실행합니다.

```bash
tailscale funnel --bg http://127.0.0.1:8787
```

처음 실행할 때 Funnel 활성화 안내가 나오면 완료합니다. 표시된 `https://<머신>.<테일넷>.ts.net` 주소를 pasear의 **공개 MCP 주소**에 넣고, 고급 설정에서 `127.0.0.1:8787`을 선택한 뒤 **저장하고 켜기**를 누릅니다.

Funnel은 인터넷에서 접근 가능한 HTTPS 주소를 제공합니다. Tailscale Serve만 켜면 사설 테일넷에서만 접근됩니다. [Funnel 공식 안내](https://tailscale.com/docs/features/tailscale-funnel)

## 채팅 연결

브라우저에서 사용할 웹 채팅을 열고 커스텀 MCP를 추가합니다.

| 채팅 · 공식 안내 | pasear 등록 위치 |
| --- | --- |
| [Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | **사용자 지정(Customize) → 커넥터 → 추가 → 커스텀 커넥터 추가**. 인증은 **지금 로그인**, OAuth 클라이언트는 **자동으로 등록(DCR)**을 선택합니다. |
| [ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) | **Plugins → + → Add custom MCP server**. OAuth와 자동 클라이언트 등록(DCR)을 선택하고 **Create as a plugin**으로 만듭니다. |
| [Gemini](https://developers.google.com/connected-apps/mcp/dev-mode/usage) | **설정 → Gemini Apps Developer Mode → Choose an app → + Create new**. 주소를 입력해 연결하고 앱 이름을 정합니다. 클라이언트 인증은 DCR을 사용합니다. |
| [Grok](https://docs.x.ai/grok/connectors#custom-mcp-connectors) | [grok.com/connectors](https://grok.com/connectors) → **New Connector → Custom**. 주소를 입력하고 OAuth 인증을 진행합니다. |

1. 이름은 **pasear**, 주소는 같은 공개 HTTPS 주소를 입력합니다. 도메인만 입력해도 되고 `/mcp`를 붙여도 됩니다. 인증은 OAuth·자동 등록(DCR)을 사용하며 클라이언트 ID·시크릿·커스텀 요청 헤더는 비워 둡니다.
2. 열린 OAuth 브라우저 창에 pasear의 **연결 비밀키**를 입력합니다.
3. pasear의 **연결** 탭에서 확인 코드·돌아갈 주소를 확인하고, 허용할 프로젝트·워크스페이스·에이전트를 선택해 승인합니다.
4. 채팅에서 pasear를 켭니다. Claude는 **+ → 커넥터**, ChatGPT는 플러그인 설치 후 **@pasear**, Gemini는 앱 선택 또는 **@pasear**를 사용합니다. “지금 작업 목록 보여줘”, “로그인 작업에 테스트하라고 하고 결과 요약해줘”처럼 말하세요.

메뉴와 지원 여부는 계정·지역·워크스페이스 정책에 따라 다릅니다. 메뉴가 없다면 위 공식 안내에서 조건을 확인하세요. 호스트마다 공개 주소와 승인이 필요하며, 플러그인 리로드 후에는 **서버 켜기**를 다시 누릅니다.

**로그** 탭에서 페이지별 기록 조회와 **수집 안 함**을 선택할 수 있습니다. 기본 수집은 켜져 있고 최근 7일·최대 50MiB를 보관합니다. 알려진 인증 값은 가리지만 작업 본문에는 민감한 내용이 포함될 수 있습니다.

[MIT](LICENSE)
