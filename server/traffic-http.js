// Observe only MCP routes. OAuth forms, headers, cookies and URL queries never enter the log.
export function captureTraffic(log, connectionKey) {
  return (req, res, next) => {
    if (!log || !["/", "/mcp"].includes(req.path)) return next();
    const generation = log.capture();
    req.logGeneration = generation;
    if (generation === null) return next();
    const started = Date.now(), chunks = [];
    let bytes = 0, finished = false, tooLarge = false, release = () => {};
    const capture = (chunk, encoding) => {
      if (!log.isCapturing(generation)) { cancel(); return; }
      if (chunk === undefined || chunk === null) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
      bytes += buffer.length;
      if (bytes > log.limits.bodyBytes) { tooLarge = true; chunks.length = 0; }
      if (!tooLarge) chunks.push(Buffer.from(buffer));
    };
    const write = res.write, end = res.end;
    res.write = function (chunk, ...args) { capture(chunk, args[0]); return write.call(this, chunk, ...args); };
    res.end = function (chunk, ...args) { capture(chunk, args[0]); return end.call(this, chunk, ...args); };
    const onFinish = () => complete(false), onClose = () => complete(!res.writableFinished);
    function detach() {
      res.write = write; res.end = end;
      res.off("finish", onFinish); res.off("close", onClose); release();
    }
    function cancel() { if (finished) return; finished = true; chunks.length = 0; detach(); }
    function complete(aborted) {
      if (finished) return;
      if (!log.isCapturing(generation)) { cancel(); return; }
      finished = true; detach();
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
    res.once("finish", onFinish);
    res.once("close", onClose);
    release = log.watchCapture(generation, cancel);
    next();
  };
}
