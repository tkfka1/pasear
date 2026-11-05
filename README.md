# pasear

Control your Paseo agents from Claude, ChatGPT, Gemini, or Grok web chat. Start tasks, send follow-ups, check progress, and summarize results.

[한국어](README.ko.md) · [Detailed guide](docs/reference.md)

![A sunlit forest path](assets/forest-path.png)

## Install

Requires Paseo daemon and app 0.11.2+, plugins enabled, npm, and the local `paseo` CLI.

```bash
paseo plugin add git:tkfka1/pasear --ref v0.12.2
```

Open **pasear** in the Paseo sidebar, then choose one connection method below.

## Option 1 · External proxy

1. Route a public HTTPS domain, such as `https://mcp.example.com`, to the Paseo host's HTTP port `8787` using your load balancer or reverse proxy.
2. In pasear, use `0.0.0.0:8787` when the proxy is on another machine, or `127.0.0.1:8787` when it is on the same host.
3. Enter the HTTPS domain in **공개 MCP 주소**, then press **저장하고 켜기**.

Forward **all paths** to the listener, including `/`, `/mcp`, `/oauth/*`, `/.well-known/*`, `/authorize`, `/register`, `/token`, and `/revoke`. Preserve paths and the Authorization header.

## Option 2 · Tailscale Funnel

On the Paseo host, [install and sign in to Tailscale](https://tailscale.com/docs/install), then run:

```bash
tailscale funnel --bg http://127.0.0.1:8787
```

Complete the Funnel enablement steps if prompted. Copy the displayed `https://<machine>.<tailnet>.ts.net` URL into pasear's **공개 MCP 주소**, select `127.0.0.1:8787` in advanced settings, and press **저장하고 켜기**.

Funnel exposes the service publicly over HTTPS; Tailscale Serve alone is private to your tailnet. See the [official Funnel guide](https://tailscale.com/docs/features/tailscale-funnel).

## Connect your chat

1. Add the same public HTTPS URL as an OAuth MCP connector. A domain-only URL works; `/mcp` also works. In Claude, choose **Automatically register** (DCR).
2. Enter pasear's **connection key** in the OAuth browser window.
3. In pasear's **연결** tab, verify the code and callback URL, select allowed projects, workspaces, or agents, and approve.
4. Select the connector in chat and ask: “Show my current tasks” or “Tell the login agent to run tests and summarize the result.”

Connector availability depends on the chat service and account. Each Paseo host needs its own public URL and approval. After a plugin reload, press **서버 켜기** again.

The **로그** tab provides paged traffic logs and a **수집 안 함** option. Logs default to on and retain up to 7 days / 50 MiB; known credentials are redacted, but task text can contain sensitive data.

[MIT](LICENSE)
