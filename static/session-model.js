"use strict";
(function (root) {
  function parseFrame(frame) {
    let id = "", data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) data += `${data ? "\n" : ""}${line.slice(5).trimStart()}`;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(id)) return null;
    let sequence;
    try { sequence = BigInt(id); } catch { return null; }
    if (sequence > 9223372036854775807n) return null;
    if (!data) return { id, sequence, event: null };
    try { return { id, sequence, event: JSON.parse(data) }; }
    catch { return { id, sequence, event: null }; }
  }

  class Cursor {
    constructor(value = "0") { this.value = /^(0|[1-9][0-9]*)$/.test(String(value)) ? String(value) : "0"; }
    accept(frame) {
      const parsed = typeof frame === "string" ? parseFrame(frame) : frame;
      if (!parsed || parsed.sequence <= BigInt(this.value)) return null;
      this.value = parsed.id;
      return parsed;
    }
    header() { return this.value === "0" ? "" : this.value; }
  }

  const model = { parseFrame, Cursor };
  if (typeof module !== "undefined" && module.exports) module.exports = model;
  else root.LasoSessionModel = model;
})(typeof window !== "undefined" ? window : globalThis);
