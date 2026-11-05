# pasear

Control your Paseo agents from Claude, ChatGPT, Gemini, or Grok web chat. Start tasks, send follow-ups, check progress, and summarize results.

[Korean](README.ko.md) · [Detailed guide](docs/reference.md)

![A sunlit forest path](assets/forest-path.png)

## Install

Requires Paseo daemon and app 0.11.2+, plugins enabled, npm, and the local `paseo` CLI.

Environment checked **2026-11-05**: Paseo CLI/daemon **0.15.0**, Node.js **24.21.0**, npm **11.19.0**. [Language, library versions and verification details](docs/reference.md#versions).

```bash
paseo plugin add git:tkfka1/pasear --ref v0.13.0
```

Open **pasear** in the Paseo sidebar, then choose one connection method below.

## Option 1 · External proxy

1. Route a public HTTPS domain, such as `https://mcp.example.com`, to the Paseo host's HTTP port `8787` using your load balancer or reverse proxy.
2. In pasear, use `0.0.0.0:8787` when the proxy is on another machine, or `127.0.0.1:8787` when it is on the same host.
3. Enter the HTTPS domain in the public MCP URL field, then save and start the server.

Forward **all paths** to the listener, including `/`, `/mcp`, `/oauth/*`, `/.well-known/*`, `/authorize`, `/register`, `/token`, and `/revoke`. Preserve paths and the Authorization header.

## Option 2 · Tailscale Funnel

On the Paseo host, [install and sign in to Tailscale](https://tailscale.com/docs/install), then run:

```bash
tailscale funnel --bg http://127.0.0.1:8787
```

Complete the Funnel enablement steps if prompted. Copy the displayed `https://<machine>.<tailnet>.ts.net` URL into pasear's public MCP URL field, select `127.0.0.1:8787` in advanced settings, then save and start the server.

Funnel exposes the service publicly over HTTPS; Tailscale Serve alone is private to your tailnet. See the [official Funnel guide](https://tailscale.com/docs/features/tailscale-funnel).

## Connect your chat

Open your chat service in a browser and add a custom MCP connection:

Official setup guides for all four services checked **2026-11-05**. Live connection verification is recorded in the [version details](docs/reference.md#versions).

| Chat · official guide | Where to register pasear |
| --- | --- |
| [Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | **Customize → Connectors → + Add → Add custom connector**. Choose **Sign in now → Register automatically** (DCR). |
| [ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) | **Plugins → + → Add custom MCP server**. Choose OAuth and automatic client registration (DCR), then **Create as a plugin**. |
| [Gemini](https://developers.google.com/connected-apps/mcp/dev-mode/usage) | **Settings → Gemini Apps Developer Mode → Choose an app → + Create new**. Enter the URL, connect and name the app; use DCR for client authentication. |
| [Grok](https://docs.x.ai/grok/connectors#custom-mcp-connectors) | [grok.com/connectors](https://grok.com/connectors) → **New Connector → Custom**. Enter the URL and complete OAuth authentication. |

1. Enter the same public HTTPS URL with the name **pasear**. A domain-only URL works; `/mcp` also works. Use OAuth with automatic client registration (DCR); leave client ID, client secret and custom request headers unset.
2. Enter pasear's **connection key** in the OAuth browser window.
3. In pasear's connections tab, verify the code and callback URL, select allowed projects, workspaces, or agents, and approve.
4. Enable pasear in chat (Claude: **+ → Connectors**; ChatGPT: install the plugin and select **@pasear**; Gemini: select the app or use **@pasear**), then ask: “Show my current tasks” or “Tell the login agent to run tests and summarize the result.”

Menus and availability depend on your account, region and workspace policy. If the menu is missing, see the linked official guide. Each Paseo host needs its own public URL and approval. After a plugin reload, start the server again.

## Wait for results

Ask “Tell the login agent to run tests, wait until it finishes, then summarize the result.” The chat can call `wait_for_agent` repeatedly without asking you to check progress manually:

```json
{"agentId":"<agent ID>","timeoutSeconds":15,"pollIntervalSeconds":2}
```

Each call uses at most 20 seconds of polling/summary time (default 15), reserving time for a final message read. It stops at `idle`, `closed`, `error`, or a pending permission request. The response includes the observed state, `lastMessageSummary` (an excerpt of up to 1,000 characters for the chat to summarize), and `timedOut`. On timeout, the chat should call again with the same ID; permission requests can be answered in chat through `respond_to_agent` or in Paseo. Idle does not prove success, and the excerpt may be from a previous turn or unavailable.

To watch several tasks, pass `agentIds` instead of `agentId` (up to 10). The first finish/permission observed in a polling round is returned; ties use input order. Continue with `remainingAgentIds` to collect the others. Repeated tool calls depend on the chat client continuing the conversation; this does not send background notifications. [Tool details](docs/reference.md#wait-for-an-agent)

When a task asks for approval or an answer, the chat shows the pending request and choices. Say “Approve that”, “Deny it”, “Choose the second option”, or give a text answer. `respond_to_agent` forwards your explicit decision, including multi-select answers when supported, then the chat can resume waiting. Request IDs and fingerprints are handled by the chat. Unsupported or oversized forms stay in Paseo. [Response details](docs/reference.md#answer-approvals-and-questions)

The logs tab provides paged traffic logs and an option to disable collection. Logs default to on and retain up to 7 days / 50 MiB; known credentials are redacted, but task text can contain sensitive data.

[MIT](LICENSE)
