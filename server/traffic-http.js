// Observe only MCP routes. OAuth forms, headers, cookies and URL queries never enter the log.
export function captureTraffic(log, connectionKey) {
  return (req, res, next) => {
    if (!log || !["/", "/mcp"].includes(req.path)) return next();
    const generation = log.capture();
    if (generation === null) return next();
    const started = Date.now(), chunks = [];
    let bytes = 0, finished = false, tooLarge = false;
    const capture = (chunk, encoding) => {
      if (chunk === undefined || chunk === null) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
      bytes += buffer.length;
      if (bytes > log.limits.bodyBytes) { tooLarge = true; chunks.length = 0; }
      if (!tooLarge) chunks.push(Buffer.from(buffer));
    };
    const write = res.write, end = res.end;
    res.write = function (chunk, ...args) { capture(chunk, args[0]); return write.call(this, chunk, ...args); };
    res.end = function (chunk, ...args) { capture(chunk, args[0]); return end.call(this, chunk, ...args); };
    function complete(aborted) {
      if (finished) return; finished = true;
      let response = null;
      if (tooLarge) response = { omitted: "body_size_limit", bytes };
      else if (bytes) { try { response = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response = { omitted: "non_json_body", bytes }; } }
      chunks.length = 0;
      const authorized = !!req.principal;
      const body = authorized ? req.body ?? null : null;
      const outcome = aborted ? "aborted" : res.statusCode === 401 ? "unauthorized" : res.statusCode >= 400 || response?.error || response?.result?.isError ? "error" : "ok";
      const bearer = (req.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      log.record({ at: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - started),
        connectionId: req.principal?.connectionId ?? null, clientName: req.logClientName ?? null,
        httpMethod: req.method, path: req.path, status: res.statusCode, outcome,
        method: typeof body?.method === "string" ? body.method.slice(0, 200) : null,
        tool: body?.method === "tools/call" && typeof body?.params?.name === "string" ? body.params.name.slice(0, 200) : null,
        request: body, response,
      }, generation, [connectionKey, bearer]);
    }
    res.once("finish", () => complete(false));
    res.once("close", () => complete(!res.writableFinished));
    next();
  };
}
