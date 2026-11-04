import { mkdir, readFile, writeFile, rename, readdir, lstat, chmod, unlink, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const LOG_LIMITS = { retentionDays: 7, maxBytes: 50 * 1024 * 1024, segmentBytes: 4 * 1024 * 1024, bodyBytes: 1024 * 1024, queueBytes: 4 * 1024 * 1024 };
const segmentPattern = /^\d{13}-[a-f0-9-]{36}\.jsonl$/;
const secretKey = /^(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|.*(?:token|secret|password|credential|api[-_]?key|connection[-_]?key))$/i;
const masked = "[REDACTED]";
const cleanString = (value, secrets) => {
  for (const secret of secrets) if (secret) value = value.split(secret).join(masked);
  return value.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, `Bearer ${masked}`)
    .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|connection[_-]?key|api[_-]?key|password|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s&,;}]+)/gi, `$1${masked}`);
};
export function redact(value, secrets = [], depth = 0, budget = { left: 25000 }) {
  if (depth > 40 || --budget.left < 0) return { omitted: "structure_limit" };
  if (typeof value === "string") {
    // MCP tools commonly repeat their JSON result inside content[].text.
    try { const nested = JSON.parse(value); if (nested && typeof nested === "object") return JSON.stringify(redact(nested, secrets, depth + 1, budget)); } catch {}
    return cleanString(value, secrets);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1, budget));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [cleanString(key, secrets), secretKey.test(key) ? masked : redact(v, secrets, depth + 1, budget)]));
  return value ?? null;
}
/** @returns {import("../shared/logs").LogSummary} */
const summary = ({ request, response, ...row }) => row;

export class TrafficLog {
  constructor(directory, limits = {}) {
    this.directory = directory;
    this.limits = { ...LOG_LIMITS, ...limits };
    this.enabled = true;
    this.error = null;
    this.dropped = 0;
    this.generation = 0;
    this.archiveEpoch = 0;
    this.queuedBytes = 0;
    this.segments = [];
    this.exports = new Map();
    this.captures = new Set();
    this.queue = Promise.resolve();
    this.ready = this.exclusive(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      try { const saved = JSON.parse(await readFile(join(directory, "settings.json"), "utf8")); if (typeof saved.enabled !== "boolean") throw Error(); this.enabled = saved.enabled; }
      catch (e) { if (e.code !== "ENOENT") { this.enabled = false; throw Error("config"); } }
      for (const name of (await readdir(directory)).filter((name) => segmentPattern.test(name)).sort()) {
        const info = await lstat(join(directory, name));
        if (info.isFile()) { await chmod(join(directory, name), 0o600); this.segments.push({ name, bytes: info.size, modified: info.mtimeMs, sealed: true }); }
      }
      await this.prune();
    }).catch(() => { this.error = "로그 저장소를 열지 못했습니다. 호스트의 디스크와 파일 권한을 확인하세요."; });
  }
  /** @template T @param {() => T | Promise<T>} work @returns {Promise<T>} */
  exclusive(work) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  cutoff() { return Date.now() - this.limits.retentionDays * 86400000; }
  async prune() {
    let total = this.segments.reduce((n, s) => n + s.bytes, 0);
    while (this.segments.length && (total > this.limits.maxBytes || this.segments[0].modified < this.cutoff())) {
      const first = this.segments[0];
      await unlink(join(this.directory, first.name)).catch((e) => { if (e.code !== "ENOENT") throw e; });
      this.segments.shift(); total -= first.bytes;
    }
    for (const [id, entry] of this.exports) if (entry.expires < Date.now()) this.exports.delete(id);
  }
  capture() { return this.enabled && !this.closed ? this.generation : null; }
  isCapturing(generation) { return generation != null && generation === this.generation && this.enabled && !this.closed; }
  watchCapture(generation, cancel) {
    if (!this.isCapturing(generation)) { cancel(); return () => {}; }
    this.captures.add(cancel);
    return () => { this.captures.delete(cancel); };
  }
  cancelCaptures() { for (const cancel of this.captures) cancel(); this.captures.clear(); }
  record(entry, generation, secrets = []) {
    if (this.closed || generation === null || generation !== this.generation || !this.enabled) return;
    let line;
    try { line = JSON.stringify({ id: randomUUID(), ...redact(entry, secrets) }) + "\n"; }
    catch { this.dropped++; this.error = "로그 내용을 처리하지 못했습니다."; return; }
    const bytes = Buffer.byteLength(line);
    if (bytes > this.limits.segmentBytes || this.queuedBytes + bytes > this.limits.queueBytes) { this.dropped++; return; }
    this.queuedBytes += bytes;
    void this.exclusive(async () => {
      if (generation !== this.generation || !this.enabled) return;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await this.prune();
        let segment = this.segments.at(-1);
        if (!segment || segment.sealed || segment.bytes + bytes > this.limits.segmentBytes || new Date(segment.modified).toDateString() !== new Date().toDateString()) {
          const timestamp = Math.max(Date.now(), Number(segment?.name.slice(0, 13) ?? 0) + 1);
          segment = { name: `${timestamp}-${randomUUID()}.jsonl`, bytes: 0, modified: Date.now() };
          this.segments.push(segment);
        }
        await appendFile(join(this.directory, segment.name), line, { mode: 0o600 });
        segment.bytes += bytes; segment.modified = Date.now();
        await this.prune(); this.error = null;
      } catch { if (this.segments.length) this.segments.at(-1).sealed = true; this.dropped++; this.error = "로그를 저장하지 못했습니다. 호스트의 디스크와 파일 권한을 확인하세요."; }
    }).finally(() => { this.queuedBytes -= bytes; });
  }
  state() { return { enabled: this.enabled, retentionDays: this.limits.retentionDays, maxBytes: this.limits.maxBytes, storedBytes: this.segments.reduce((n, s) => n + s.bytes, 0), dropped: this.dropped, error: this.error }; }
  async status() { await this.ready; return this.exclusive(async () => { try { await this.prune(); } catch { this.error = "오래된 로그를 정리하지 못했습니다. 호스트의 파일 권한을 확인하세요."; } return this.state(); }); }
  async configure(enabled) {
    await this.ready;
    return this.exclusive(async () => {
      const temporary = join(this.directory, `settings-${randomUUID()}.tmp`);
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify({ enabled }), { mode: 0o600, flag: "wx" });
        await rename(temporary, join(this.directory, "settings.json"));
      } catch { await unlink(temporary).catch(() => {}); throw Error("로그 설정을 저장하지 못했습니다. 디스크와 파일 권한을 확인하세요."); }
      this.enabled = enabled; this.generation++; this.cancelCaptures(); return this.state();
    });
  }
  async clear() {
    // In-flight requests and already queued writes must not resurrect erased data.
    this.generation++; this.archiveEpoch++; this.exports.clear(); this.cancelCaptures();
    await this.ready;
    return this.exclusive(async () => {
      for (const segment of [...this.segments]) {
        try { await unlink(join(this.directory, segment.name)); }
        catch (e) { if (e.code !== "ENOENT") throw Error("로그를 삭제하지 못했습니다. 파일 권한을 확인하고 다시 시도하세요."); }
        this.segments = this.segments.filter((s) => s.name !== segment.name);
      }
      this.error = null; this.dropped = 0; return this.state();
    });
  }
  matches(row, filter) { return Date.parse(row.at) >= this.cutoff() && (!filter.connectionId || row.connectionId === filter.connectionId) && (!filter.tool || row.tool?.toLowerCase().includes(filter.tool.toLowerCase())) && (!filter.connection || `${row.clientName ?? ""} ${row.connectionId ?? ""}`.toLowerCase().includes(filter.connection.toLowerCase())); }
  async rows(segment) {
    const lines = (await readFile(join(this.directory, segment.name), "utf8")).split("\n");
    return lines.filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  async list({ connectionId, connection, tool, before, limit = 25 } = {}) {
    await this.ready;
    return this.exclusive(async () => {
      await this.prune();
      const entries = []; let found = !before, hasMore = false;
      for (const segment of [...this.segments].reverse()) {
        for (const row of (await this.rows(segment)).reverse()) {
          if (!found) { if (row.id === before) found = true; continue; }
          if (!this.matches(row, { connectionId, connection, tool })) continue;
          if (entries.length === limit) { hasMore = true; break; }
          entries.push(summary(row));
        }
        if (hasMore) break;
      }
      if (!found) throw Error("로그가 정리되었거나 삭제되었습니다. 최신 로그를 다시 불러오세요.");
      return { entries, nextCursor: hasMore ? entries.at(-1).id : null };
    });
  }
  async detail(id) {
    await this.ready;
    return this.exclusive(async () => {
      await this.prune();
      for (const segment of [...this.segments].reverse()) {
        const row = (await this.rows(segment)).find((r) => r.id === id && this.matches(r, {}));
        if (row) return row;
      }
      throw Error("로그가 정리되었거나 삭제되었습니다. 최신 로그를 다시 불러오세요.");
    });
  }
  async exportPage({ cursor, connectionId, connection, tool } = {}) {
    await this.ready;
    return this.exclusive(async () => {
      await this.prune();
      let session;
      if (!cursor) {
        if (this.exports.size >= 3) throw Error("로그 다운로드가 진행 중입니다. 잠시 후 다시 시도하세요.");
        cursor = randomUUID();
        session = { epoch: this.archiveEpoch, expires: Date.now() + 300000, files: this.segments.map((s) => ({ ...s })), index: 0, lines: [], remainder: "", filter: { connectionId, connection, tool } };
        this.exports.set(cursor, session);
      } else session = this.exports.get(cursor);
      if (!session || session.epoch !== this.archiveEpoch) throw Error("다운로드가 만료되었거나 로그가 삭제되었습니다. 다시 내려받으세요.");
      let content = "";
      while (content.length < 32768) {
        if (session.remainder) { const n = 32768 - content.length; content += session.remainder.slice(0, n); session.remainder = session.remainder.slice(n); continue; }
        if (session.lines.length) {
          const line = session.lines.shift();
          let row; try { row = JSON.parse(line); } catch { continue; }
          if (this.matches(row, session.filter)) session.remainder = line + "\n";
          continue;
        }
        if (session.index === session.files.length) break;
        const file = session.files[session.index++];
        try { const data = await readFile(join(this.directory, file.name)); session.lines = data.subarray(0, file.bytes).toString("utf8").split("\n").filter(Boolean); }
        catch { this.exports.delete(cursor); throw Error("로그가 정리되었습니다. 다시 내려받으세요."); }
      }
      const done = !session.remainder && !session.lines.length && session.index === session.files.length;
      if (done) this.exports.delete(cursor); else session.expires = Date.now() + 300000;
      return { content, nextCursor: done ? null : cursor };
    });
  }
  async close() { this.closed = true; this.exports.clear(); this.cancelCaptures(); await this.queue; }
}
