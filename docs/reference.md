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
| `cancel_agent` | Request interruption of the current run while retaining history and edits. |
| `import_agent` | Recover an original provider session (`native`) or start a separate session from history (`handoff`). |

Acceptance is not completion, and an idle state is not proof of success. Follow history cursors before claiming to have read a whole conversation. The chat model generates retry keys and reuses them only for the same intended operation.

Native import requires host-wide access with the current CLI, retained provider session data, and provider recovery support. It does not send a follow-up prompt or change the provider. Handoff needs read access to the source and creation access to the destination; it carries a chat-written summary plus bounded recent history. It does not restore old files, branches, worktrees, or provider runtime state.

## Access and multiple hosts

Each connection has one task-control permission, limited to the projects, workspaces, and agents allowed by the owner. Project discovery uses the same access rules: a child-only grant reveals its parent name, not sibling workspaces, project paths, or totals. An empty project appears only when the project is fully allowed. Select projects in the connection’s access editor. Whole projects/workspaces include future children; an agent-only selection cannot create new agents. Access edits and revocation apply without reconnecting. These limits govern MCP operations, not the provider's filesystem sandbox or tool permissions. Answer provider permission requests in Paseo.

Install pasear independently on each host. Each needs its own public URL and chat connector. Changing the host in the Paseo screen does not retarget a connected chat, and the load balancer must not distribute requests across unrelated hosts.

Prompts and selected history go to the chat service and selected coding provider. OAuth state stays on the daemon host. Tool activity omits raw tool arguments/output and reasoning; conversation text may contain sensitive task data. This plugin is trusted local code and uses OAuth DCR, S256 PKCE, a connection key, and explicit owner approval.

## MCP traffic logs

Switch between the connections and logs tabs on the same screen. Enable or disable collection in the logs tab. Collection off bypasses new request/response capture, file writes and in-memory tool audit, releases active response capture immediately, and persists across reloads. Existing logs remain available. Inspect bodies, filter by connection name/ID or tool name, refresh, or delete all logs. Logs show 25 records per page with Previous/Next controls. Tabs preserve filters and the current page; changing filters, refreshing or deleting resets to page one. New records are not inserted automatically into the displayed page. Exports include every matching record across pages. Pending connection approvals remain visible through the connection tab count. Web clients can download one record or all matching records as JSONL; native apps can share individual records. Deletion affects all filters and prevents already-running requests from recreating erased records. Recording changes apply without restarting MCP.

Recording starts enabled and persists under `$PASEO_HOME/plugin-data/paseo-mcp-plugin/logs/` with `0700` directories and `0600` files. Files rotate at 4 MiB with a 7-day, 50 MiB retention limit. Preferences and logs survive reloads. Disk errors and queue-pressure drops appear in the management UI; logging failures do not fail MCP operations.

Both MCP endpoints record initialization, discovery, calls, notifications and errors, including bodies, connection identifiers, timestamps, duration and HTTP status. OAuth routes, headers, cookies and URL queries are excluded; unauthenticated requests have metadata only. Known connection keys, the request's Bearer token, and credential-named fields are redacted, including nested JSON text. Arbitrary secrets embedded in task text cannot all be detected; at-rest encryption is separate. Responses exceeding 1 MiB get a `body_size_limit` marker, and excessive nesting/complexity gets a `structure_limit` marker. The screen previews 32,000 characters per body; exports contain the complete stored record. Logs are accessible only through authenticated Paseo management RPCs, never external MCP tools. They do not capture the chat service's entire conversation.

## Versions

Recorded **2026-11-05** for pasear **0.12.2**. Environment observations and documentation reviews have separate scopes.

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
