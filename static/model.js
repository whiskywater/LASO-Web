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

  return { items, stateOf, stateTone, terminal, pending, humanize, promptOf, pipelineName, runTitle, relativeTime, dateLabel };
});
