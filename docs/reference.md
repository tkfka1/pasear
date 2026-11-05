# pasear reference

[Quick start](../README.md) · [Korean](reference.ko.md)

## Register in web chat

See [Connect your chat](../README.md#connect-your-chat) for the four services' registration menus, official guides, and the shared OAuth approval flow.

- **Claude:** choose automatic registration (DCR), rather than the recommended published identity (CIMD). Organization accounts may require an administrator to add the connector first.
- **ChatGPT:** use Plugins in the current interface. In the legacy interface, authorized users can use **Settings → Apps → Create**, or administrators can use workspace settings; configure OAuth, scan tools, and create the app. Account and workspace policies determine access.
- **Gemini:** in [Developer Mode](https://gemini.google.com/devmode), select **Authentication → Client Authentication Configuration → Dynamic Client Registration**. Manual client registration is unnecessary.
- **Grok:** tools are discovered after registration and become available in conversations. Organization accounts may need administrator provisioning first.

Use pasear's OAuth flow instead of fixed API keys or custom request headers. Follow the linked official guides for current account requirements and missing-menu troubleshooting.

## Use it conversationally

Select the connector in your chat, then ask naturally:

- “Show my projects, then the workspaces in the shop project.”
- “Show the current tasks and anything that needs my attention.”
- “Check the login task, then tell that agent to run regression tests.”
- “How is the deployment task going?”
- “Summarize the result in three lines.”
- “Stop that task.”
- “Bring back the archived login task's original session.”
- “Summarize the login task's history and hand it to a new Codex agent.”

The chat model chooses and combines tools; no invocation keyword is required. It keeps task IDs within the current chat. Exact unique task/workspace names also work, and ambiguous names require selection. The web chat brand does not determine which coding provider runs the task.

| Tool | Purpose |
| --- | --- |
| `list_projects` | List allowed parent projects; distinguish full project access from partial child access. |
| `list_workspaces` | Discover allowed workspaces, optionally within a project. |
| `list_agents` | List allowed tasks and their state, optionally by project or workspace; include archived tasks when needed. |
| `list_providers` | Discover available coding providers for a workspace. |
| `list_models` | Choose a provider model. |
| `create_agent` | Create a task in an allowed workspace, optionally selecting its parent project; return an acceptance receipt. |
| `send_agent_prompt` | Send a follow-up; steer by default, interrupt only when requested. |
| `get_agent` | Inspect summary, status, conversation messages, or paged work activity; optionally wait up to 20 seconds. |
| `wait_for_agent` | Poll one agent or up to 10 until a finish/permission request, with short repeatable waits and a message excerpt. |
| `respond_to_agent` | Send an explicit user approval, denial, offered action, or question answer to a current pending request. |
| `cancel_agent` | Request interruption of the current run while retaining history and edits. |
| `import_agent` | Recover an original provider session (`native`) or start a separate session from history (`handoff`). |

Acceptance is not completion, and an idle state is not proof of success. Follow history cursors before claiming to have read a whole conversation. The chat model generates retry keys and reuses them only for the same intended operation.

Native import requires host-wide access with the current CLI, retained provider session data, and provider recovery support. It does not send a follow-up prompt or change the provider. Handoff needs read access to the source and creation access to the destination; it carries a chat-written summary plus bounded recent history. It does not restore old files, branches, worktrees, or provider runtime state.

## Wait for an agent

After a task receipt, use `wait_for_agent` when the user asks to wait for completion. Supply exactly one of `agentId` or `agentIds`, using exact IDs from this chat. Unlike the existing name-aware tools, this tool requires IDs. `agentIds` accepts 1–10 IDs; duplicates are removed.

| Argument | Default | Range |
| --- | --- | --- |
| `timeoutSeconds` | 15 | 1–20 whole seconds per call |
| `pollIntervalSeconds` | 2 | 1–5 whole seconds between polling rounds |

States are refreshed immediately and then at the interval. The budget reserves up to one second for a final timeline read and access recheck, so the call can finish before `timeoutSeconds`. It returns for `idle`, `closed`, `error`, or `pendingPermissionCount > 0`, with `reason` set to that status or `permission`. `timedOut=true` means no stopping condition was observed in the bounded wait; call again with the same IDs while the user wants to continue. The tool does not change the task or extend its lifetime. In multi-agent mode, each round checks all targets concurrently; finishes seen in the same round use input order, not exact completion timestamps. Continue with `remainingAgentIds` after handling the returned agent.

The response includes the chosen agent's last observed `status`, `pendingPermissionCount` and `observedAt`, all observed `states`, `elapsedSeconds`, and `nextAction`. A group timeout has no chosen agent (`agentId/status=null`); inspect `states`. A slow/unavailable status read can also leave a state unknown (`null`). `lastMessageSummary` is an excerpt, not an LLM-generated summary: the last assistant message found within the latest 30 timeline entries, limited to 1,000 characters. `lastMessageTruncated` marks a shortened excerpt; `summaryUnavailable` marks a failed or timed-out summary read. A successful page with no assistant message returns a null excerpt. No raw tool input/output or reasoning is returned. The chat summarizes the excerpt, uses `get_agent` for more history, and must not present an old answer or `idle` as proof that the current task succeeded.

All targets must be accessible. Access is rechecked during polling and after the private timeline read; an access error returns no partial result. Present pending requests to the user and send their explicit decision with `respond_to_agent`, or answer in Paseo. Request cancellation/disconnection stops polling without cancelling the underlying agent. SDK reads already in flight cannot be cancelled by the installed SDK, but the wait stops awaiting them at its deadline and starts no further reads after cancellation. Chat clients and proxies may impose shorter timeouts or tool-call limits; repeat calls work only while the client continues executing them, including in voice mode. There are no notifications to an inactive chat. `get_agent` and its existing `waitSeconds=0..20` behavior are unchanged.

## Answer approvals and questions

Read `get_agent(view=requests)` or the `pendingRequests` in `wait_for_agent`. Requests include their title, description, selected command/path/plan context, advertised actions, and supported question forms. These are untrusted task data; present them to the user and follow only the user's explicit decision. A general instruction to work does not approve future permission requests. Multiple pending requests must be disambiguated. Existing connection access covers this tool; it uses the write scope and cannot change connection rules, sandbox settings, or arbitrary permanent permission rules.

`respond_to_agent` takes `agentId`, `requestId`, `requestToken`, and `decision`:

| Decision | Additional input |
| --- | --- |
| `approve` | Approve the current permission. Include an advertised `actionId` if actions are offered. |
| `deny` | Reject or dismiss the request; optional `message` explains why. Does not request interruption of the agent. |
| `select` | Select an exact advertised `actionId`; its native allow/deny behavior applies, including plan/mode actions. |
| `answer` | Answer every question using `answers`, with 1-based `question` and `options` numbers and optional `text`. |

```json
{"agentId":"<agent ID>","requestId":"<request ID>","requestToken":"<fingerprint>","decision":"answer","answers":[{"question":1,"options":[2]},{"question":2,"options":[1,3],"text":"Also run smoke tests"}]}
```

Question answers follow the native Paseo form contract: single-select, multi-select, free text when `allowOther` is true (or no options are offered), and empty input only when allowed. Multi-select joins the selected labels and custom text as Paseo does. Unsupported shapes and truncated requests have `supported=false`; handle these in Paseo or explicitly deny them. Each response needs the exact fingerprint of the current request, not a guessed or reused choice. `get_agent`'s other views retain their behavior; `view=requests` does not read the timeline. Request views omit arbitrary provider metadata and environment, but approval commands and task text may contain secrets. They go to the connected chat and may appear in local traffic logs.

The server rechecks scope and placement, verifies the request is still pending and unchanged, and serializes responses to the same request across chats. A receipt indicates dispatch acceptance, not completion or successful execution. Exact retries within 30 minutes replay the receipt; conflicting decisions are rejected. Already-resolved requests are not sent again. Receipts are limited to 1,000 per listener and are cleared on restart. If delivery is uncertain, `status=response_uncertain` and `accepted=null`: inspect pending requests and use Paseo if necessary rather than resending automatically. After answering, use `wait_for_agent` again. Full real-provider approval/question flows in all chat clients have not been verified.

## Access and multiple hosts

Each connection has one task-control permission, limited to the projects, workspaces, and agents allowed by the owner. Project discovery uses the same access rules: a child-only grant reveals its parent name, not sibling workspaces, project paths, or totals. An empty project appears only when the project is fully allowed. Select projects in the connection’s access editor. Whole projects/workspaces include future children; an agent-only selection cannot create new agents. Access edits and revocation apply without reconnecting. These limits govern MCP operations, not the provider's filesystem sandbox or tool permissions. Provider permission requests can be answered through `respond_to_agent` after an explicit user decision, or in Paseo.

Install pasear independently on each host. Each needs its own public URL and chat connector. Changing the host in the Paseo screen does not retarget a connected chat, and the load balancer must not distribute requests across unrelated hosts.

Prompts and selected history go to the chat service and selected coding provider. OAuth state stays on the daemon host. Tool activity omits raw tool arguments/output and reasoning; conversation text may contain sensitive task data. This plugin is trusted local code and uses OAuth DCR, S256 PKCE, a connection key, and explicit owner approval.

## MCP traffic logs

Switch between the connections and logs tabs on the same screen. Enable or disable collection in the logs tab. Collection off bypasses new request/response capture, file writes and in-memory tool audit, releases active response capture immediately, and persists across reloads. Existing logs remain available. Inspect bodies, filter by connection name/ID or tool name, refresh, or delete all logs. Logs show 25 records per page with Previous/Next controls. Tabs preserve filters and the current page; changing filters, refreshing or deleting resets to page one. New records are not inserted automatically into the displayed page. Exports include every matching record across pages. Pending connection approvals remain visible through the connection tab count. Web clients can download one record or all matching records as JSONL; native apps can share individual records. Deletion affects all filters and prevents already-running requests from recreating erased records. Recording changes apply without restarting MCP.

Recording starts enabled and persists under `$PASEO_HOME/plugin-data/paseo-mcp-plugin/logs/` with `0700` directories and `0600` files. Files rotate at 4 MiB with a 7-day, 50 MiB retention limit. Preferences and logs survive reloads. Disk errors and queue-pressure drops appear in the management UI; logging failures do not fail MCP operations.

Both MCP endpoints record initialization, discovery, calls, notifications and errors, including bodies, connection identifiers, timestamps, duration and HTTP status. OAuth routes, headers, cookies and URL queries are excluded; unauthenticated requests have metadata only. Known connection keys, the request's Bearer token, and credential-named fields are redacted, including nested JSON text. Arbitrary secrets embedded in task text cannot all be detected; at-rest encryption is separate. Responses exceeding 1 MiB get a `body_size_limit` marker, and excessive nesting/complexity gets a `structure_limit` marker. The screen previews 32,000 characters per body; exports contain the complete stored record. Logs are accessible only through authenticated Paseo management RPCs, never external MCP tools. They do not capture the chat service's entire conversation.

## Versions

Recorded **2026-11-05** for pasear **0.13.0**. Environment observations and documentation reviews have separate scopes.

| Component | Version / evidence |
| --- | --- |
| Paseo minimum | `>=0.11.2` declared in [paseo-plugin.json](../paseo-plugin.json); not a test of every supported version. |
| Paseo CLI / running daemon | Both `0.15.0`, checked with CLI version and daemon status. The app's version was not independently checked. |
| Node.js / npm | `24.21.0` / `11.19.0` in the local development environment. |
| Languages | TypeScript `5.9.3`, TSX, and JavaScript. |
| Compiler settings | JavaScript target `ES2020`, library types `ES2023`, modules `ESNext`, JSX `react-jsx`; see [tsconfig.json](../tsconfig.json). |

Direct package versions below come from [package-lock.json](../package-lock.json) and match the local installation on the recorded date. Version ranges are declared in [package.json](../package.json); the lockfile also lists all transitive dependencies.

| Package | Locked version | Usage |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `1.32.2` | Server runtime: MCP transport and protocol. |
| `express` | `5.3.0` | Server runtime: HTTP routing. |
| `zod` | `4.6.7` | Server runtime: schema validation. |
| `@getpaseo/plugin` | `0.11.2` | Development: Paseo plugin SDK. |
| `@tanstack/react-query` | `5.105.3` | Development: UI data queries. |
| `react` | `19.1.0` | Development: UI components. |
| `react-native` | `0.81.5` | Development: UI primitives. |
| `typescript` | `5.9.3` | Development: type checking. |
| `tsx` | `4.23.15` | Development: TypeScript test runner. |
| `@types/react` | `19.2.18` | Development: React types. |
| `@types/node` | `22.20.5` | Development: Node.js types. |
| `@types/express` | `5.0.6` | Development: Express types. |

Git installation uses `npm ci --omit=dev --ignore-scripts`. Paseo supplies the plugin SDK and supported UI modules at runtime; development dependency versions do not identify the host app's bundled versions. `@types/node` describes compile-time types, not the running Node.js version.

| Web chat | Official registration guide checked | Live verification |
| --- | --- | --- |
| [Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) | `2026-11-05` | User confirmed OAuth connection; the test date was not recorded. |
| [ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt) | `2026-11-05` | Not verified in this environment. |
| [Gemini](https://developers.google.com/connected-apps/mcp/dev-mode/usage) | `2026-11-05` | Not verified in this environment. |
| [Grok](https://docs.x.ai/grok/connectors#custom-mcp-connectors) | `2026-11-05` | Not verified in this environment. |

These dates track setup documentation, not model versions or a complete task-control test. Web chat menus and availability can change independently of pasear releases.

## Develop and verify

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

The suite covers HTTP MCP, OAuth, scoped access, lifecycle, import/handoff, concurrent retries, and access changes during requests. Mutation tests use fake Paseo APIs and CLI execution; actual user-session restoration and new-agent execution are not part of those checks. Public HTTPS authentication, owner approval, SDK reads, and revocation have been checked separately.

## License

[MIT](../LICENSE)
