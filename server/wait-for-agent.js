import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

export function agentWaitReason(state) {
  if (state.pendingPermissionCount > 0) return "permission";
  return ["idle", "closed", "error"].includes(state.status) ? state.status : null;
}

// The SDK's refresh/refetch methods do not accept AbortSignal. Bound our wait
// for them, and let callbacks check the signal before issuing another RPC.
export async function waitForAgents({ agentIds, timeoutSeconds, pollIntervalSeconds, signal, observe, summarize }) {
  const started = performance.now();
  const deadline = started + timeoutSeconds * 1000;
  // Leave time for the final bounded timeline read and placement recheck.
  const pollDeadline = deadline - Math.min(1000, timeoutSeconds * 500);
  const lifetime = new AbortController();
  const abort = () => lifetime.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  const states = new Map();
  const expired = Symbol("deadline");
  const bounded = async (work, until) => {
    lifetime.signal.throwIfAborted();
    const remaining = until - performance.now();
    if (remaining <= 0) return expired;
    const timer = new AbortController();
    const onAbort = () => timer.abort(lifetime.signal.reason);
    lifetime.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        sleep(remaining, expired, { signal: timer.signal }),
      ]);
    } finally {
      timer.abort();
      lifetime.signal.removeEventListener("abort", onAbort);
    }
  };
  const recordSummary = (result, target) => {
    for (const state of result.states ?? [result.state]) states.set(state.agentId, state);
    states.set(target, result.state);
  };
  let selected = null, summary = null;
  try {
    while (performance.now() < pollDeadline) {
      // Resolve a round together; simultaneous finishes use input order.
      // A missing/unauthorized target fails the entire call, never a partial success.
      const round = await bounded(() => Promise.all(agentIds.map((agentId) => observe(agentId, lifetime.signal))), pollDeadline);
      lifetime.signal.throwIfAborted();
      if (round === expired) break;
      round.forEach((state, index) => states.set(agentIds[index], state));
      selected = agentIds.find((id) => agentWaitReason(states.get(id))) ?? null;
      if (selected) {
        summary = await bounded(() => summarize(selected, lifetime.signal), deadline);
        if (summary === expired) { summary = null; break; }
        recordSummary(summary, selected);
        // A new turn may have started while fetching the previous answer.
        if (agentWaitReason(summary.state)) break;
        selected = null; summary = null;
      }
      const delay = Math.min(pollIntervalSeconds * 1000, Math.max(0, pollDeadline - performance.now()));
      if (delay) await sleep(delay, undefined, { signal: lifetime.signal });
      if (delay < pollIntervalSeconds * 1000) break;
    }
    selected ??= agentIds.find((id) => agentWaitReason(states.get(id) ?? {})) ?? (agentIds.length === 1 ? agentIds[0] : null);
    if (selected && !summary && performance.now() < deadline) {
      const result = await bounded(() => summarize(selected, lifetime.signal), deadline);
      if (result !== expired) { summary = result; recordSummary(summary, selected); }
    }
    lifetime.signal.throwIfAborted();
    const state = selected ? states.get(selected) : null;
    const reason = state && agentWaitReason(state) || "timeout";
    const timedOut = reason === "timeout";
    return {
      ...(state ?? { agentId: selected, status: null, pendingPermissionCount: null }),
      reason, timedOut,
      elapsedSeconds: Math.round((performance.now() - started) / 10) / 100,
      watchedAgentIds: agentIds,
      remainingAgentIds: timedOut ? agentIds : agentIds.filter((id) => id !== selected),
      states: agentIds.map((id) => states.get(id) ?? { agentId: id, status: null, pendingPermissionCount: null }),
      lastMessageSummary: summary?.text ?? null,
      lastMessageTruncated: summary?.truncated ?? false,
      summaryUnavailable: selected !== null && (!summary || summary.unavailable === true),
      permissionAction: reason === "permission" ? "Present pendingRequests and ask the user. Send their explicit decision with respond_to_agent, or answer in Paseo, then call wait_for_agent again." : null,
      error: state?.status === "error" ? "Agent run failed. Inspect Paseo for details." : null,
      next: timedOut ? "wait_for_agent" : reason === "permission" ? "respond_to_agent" : "get_agent",
      nextAction: timedOut
        ? "The bounded wait ended; the task was not cancelled. Call wait_for_agent again with the same agent ID(s) to keep waiting."
        : "Report the observed state and summarize the message excerpt. Idle is not proof of success. Use get_agent for details; watch remainingAgentIds to collect other agents.",
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    lifetime.abort();
  }
}
