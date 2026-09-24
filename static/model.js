(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.LasoUI = model;
})(globalThis, function () {
  "use strict";

  function items(value) {
    if (Array.isArray(value)) return value;
    return value && Array.isArray(value.items) ? value.items : [];
  }

  function stateOf(value) {
    return value?.state ?? value?.status ?? value?.decision ?? "unknown";
  }

  function stateTone(value) {
    const state = String(value || "").toLowerCase();
    if (["completed", "complete", "healthy", "ok", "approved", "answered", "enabled", "succeeded"].some(token => state.includes(token))) return "good";
    if (["failed", "error", "denied", "cancelled", "canceled", "unavailable", "expired", "timedout", "timed_out"].some(token => state.includes(token))) return "bad";
    if (["pending", "waiting", "awaiting", "queued", "running", "starting", "submitting", "unknown", "created"].some(token => state.includes(token))) return "warn";
    return "neutral";
  }

  function terminal(value) {
    return ["completed", "complete", "failed", "cancelled", "canceled", "timedout", "timed_out"].includes(String(value || "").toLowerCase());
  }

  function pending(value) {
    const state = String(value || "").toLowerCase();
    return state === "created" || state.includes("pending") || state.includes("waiting") || state.includes("awaiting");
  }

  function humanize(value) {
    return String(value || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim()
      .replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function promptOf(run) {
    const payload = run?.message?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    for (const source of [payload, payload.input]) {
      if (!source || typeof source !== "object") continue;
      for (const key of ["prompt", "task", "instruction", "text"]) {
        if (typeof source[key] === "string" && source[key].trim()) return source[key].trim();
      }
    }
    return "";
  }

  function pipelineName(run, registeredName = "") {
    let name = registeredName || run?.pipeline_name || run?.pipeline_id || run?.pipeline || "Pipeline";
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(name))) name = "Pipeline";
    return run?.pipeline_version ? `${name} · v${run.pipeline_version}` : String(name);
  }

  function runTitle(run, registeredName = "") {
    const prompt = promptOf(run);
    if (prompt) return prompt.replace(/\s+/g, " ").slice(0, 72) + (prompt.length > 72 ? "…" : "");
    const fallback = registeredName || run?.pipeline_name || run?.pipeline_id || run?.pipeline || "Pipeline run";
    return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(fallback)) ? "Pipeline run" : humanize(fallback);
  }

  function relativeTime(value, now = Date.now()) {
    if (!value) return "";
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return "";
    const seconds = Math.round((timestamp - now) / 1000);
    const absolute = Math.abs(seconds);
    if (absolute < 45) return seconds <= 0 ? "just now" : "in a moment";
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
    if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
    if (absolute < 604800) return formatter.format(Math.round(seconds / 86400), "day");
    return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function dateLabel(value, now = Date.now()) {
    const relative = relativeTime(value, now);
    return relative ? relative.charAt(0).toUpperCase() + relative.slice(1) : "Time unavailable";
  }

  function stateCopy(value) {
    const state = String(value || "unknown").toLowerCase().replace(/[._\s-]/g, "");
    const copy = {
      queued: "Queued for LASO",
      starting: "Starting",
      running: "In progress",
      waiting: "Waiting",
      waitingforapproval: "Needs your approval",
      awaitingapproval: "Needs your approval",
      waitingforinput: "Needs your input",
      awaitinginput: "Needs your input",
      completed: "Completed",
      complete: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      canceled: "Cancelled",
      unknown: "Status unavailable"
    };
    return copy[state] || humanize(value || "Status unavailable");
  }

  function durationLabel(start, end) {
    const first = Date.parse(start || "");
    const last = Date.parse(end || "");
    if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return "";
    const seconds = Math.round((last - first) / 1000);
    if (seconds < 1) return "under a second";
    if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  function activitySummary(events, run) {
    const count = Array.isArray(events) ? events.length : 0;
    const state = String(stateOf(run) || "").toLowerCase();
    const terminalRun = terminal(state);
    const endEvent = [...(events || [])]
      .filter(event => /run\.(completed|failed|cancelled|canceled)$/i.test(event.type || ""))
      .sort((a, b) => Date.parse(a.occurred_at || a.time || a.ingested_at || "")
        - Date.parse(b.occurred_at || b.time || b.ingested_at || "")).pop();
    const elapsed = terminalRun && durationLabel(run?.created_at, endEvent?.occurred_at || endEvent?.time || endEvent?.ingested_at || run?.updated_at);
    const stateLabel = stateCopy(state);
    const summary = elapsed ? `${stateLabel} in ${elapsed}` : stateLabel;
    return `${summary} · ${count} event${count === 1 ? "" : "s"}`;
  }

  function outputText(payload) {
    if (typeof payload === "string") return payload.trim();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
    const fields = ["summary", "text", "content", "answer", "greeting", "output", "result", "message"];
    const values = [];
    for (const key of fields) {
      const value = payload[key];
      if (typeof value === "string" && value.trim()) values.push(value.trim());
      else if (value && typeof value === "object") values.push(JSON.stringify(value, null, 2));
    }
    if (values.length) return [...new Set(values)].join("\n\n");
    const transportFields = new Set(["input", "id", "run_id", "pipeline_id", "node_id", "metadata", "provenance"]);
    return Object.entries(payload)
      .filter(([key, value]) => !transportFields.has(key.toLowerCase()) && ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => `${humanize(key)}: ${String(value)}`).join("\n");
  }

  function messageLabel(type, payload = {}) {
    const value = String(type || "").toLowerCase();
    if (value.includes("error") || value.includes("failure") || (payload && (payload.error || payload.failure))) return "Error";
    if (value.includes("result") || value.includes("output")) return "Result";
    if (value.includes("worker")) return "Worker";
    return "LASO";
  }

  function route(hash) {
    const value = String(hash || "").replace(/^#\/?/, "");
    if (value.startsWith("run/")) {
      try { return { view: "thread", runId: decodeURIComponent(value.slice(4)) }; }
      catch { return { view: "new", runId: "" }; }
    }
    const views = ["new", "history", "workers", "approvals", "schedules", "system"];
    return { view: views.includes(value) ? value : "new", runId: "" };
  }

  function routeHash(view, runId = "") {
    return view === "thread" && runId ? `#/run/${encodeURIComponent(String(runId))}`
      : `#/${["new", "history", "workers", "approvals", "schedules", "system"].includes(view) ? view : "new"}`;
  }

  return { items, stateOf, stateTone, terminal, pending, humanize, promptOf, pipelineName, runTitle,
    relativeTime, dateLabel, stateCopy, durationLabel, activitySummary, outputText, messageLabel, route, routeHash };
});
