import type { Server } from "node:http";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { McpConfig, McpStatus } from "../shared/mcp";
import { configSchema } from "../shared/mcp";
import { createApp } from "./app.js";
import { TrafficLog } from "./traffic-log.js";
import { OAuthStore } from "./oauth.js";
import { stopAgent } from "./stop-agent";
import { createNativeImporter } from "./import-agent";

export class McpServerManager {
  constructor(readonly oauth = new OAuthStore(), readonly trafficLog?: TrafficLog) {}
  private listener: Server | null = null;
  private active: McpConfig | null = null;
  private startedAt: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly importAgent = createNativeImporter();
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  status(): McpStatus {
    const running = this.listener?.listening === true;
    const host = running ? this.active!.host : null;
    const port = running ? this.active!.port : null;
    return {
      running, host, port, startedAt: running ? this.startedAt : null,
      upstreamUrl: running ? `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}${new URL(this.active!.publicUrl).pathname}` : null,
    };
  }
  start(config: McpConfig, paseo: PluginHandlerContext["paseo"]): Promise<McpStatus> {
    return this.exclusive(async () => {
      const parsed = configSchema.safeParse(config);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check your MCP settings.");
      config = parsed.data;
      if (!config.publicUrl) throw new Error("Enter the public HTTPS MCP URL.");
      if (!config.connectionKey) throw new Error("Generate a connection key and save your settings first.");
      if (this.listener?.listening) {
        if (this.active && this.sameListener(this.active, config)) return this.status();
        throw new Error("Stop the server before changing listener settings.");
      }
      await this.trafficLog?.ready;
      const app = createApp({ ...config, trafficLog: this.trafficLog, oauthStore: this.oauth, connection: { getApi: async () => paseo }, cancelAgent: stopAgent, importAgent: this.importAgent });
      const listener = app.listen(config.port, config.host);
      try {
        await new Promise<void>((resolve, reject) => {
          const onReady = () => { listener.off("error", onError); resolve(); };
          const onError = (error: Error) => { listener.off("listening", onReady); reject(error); };
          listener.once("listening", onReady);
          listener.once("error", onError);
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        throw new Error(code === "EADDRINUSE"
          ? `Port ${config.port} is already in use. Choose another port.`
          : "Could not start the MCP server. Check the bind address and port.");
      }
      this.listener = listener;
      this.active = { ...config };
      this.startedAt = new Date().toISOString();
      listener.on("error", () => { void this.stop(); });
      return this.status();
    });
  }
  private async closeListener(): Promise<void> {
    this.oauth.clearPending();
    const listener = this.listener;
    this.listener = null;
    this.active = null;
    this.startedAt = null;
    if (!listener) return;
    await new Promise<void>((resolve) => {
      listener.close(() => resolve());
      listener.closeAllConnections();
    });
  }
  stop(): Promise<McpStatus> {
    return this.exclusive(async () => { await this.closeListener(); return this.status(); });
  }
  reconcile(config: McpConfig | null): Promise<void> {
    return this.exclusive(async () => {
      if (this.active && (!config || !this.sameListener(this.active, config))) {
        await this.closeListener();
      }
    });
  }
  private sameListener(a: McpConfig, b: McpConfig) {
    return a.host === b.host && a.port === b.port && a.connectionKey === b.connectionKey && a.publicUrl === b.publicUrl;
  }
}
