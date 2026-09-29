"use strict";
(() => {
  const root = document.querySelector("#recent-sessions");
  if (!root) return;
  const sidebar = document.querySelector("#sessions-sidebar");
  const newChat = document.querySelector("#new-chat-link");
  const add = (tag, value, cls) => { const node = document.createElement(tag); node.textContent = value; if (cls) node.className = cls; return node; };
  async function recentSessions() {
    const all = [];
    for (let offset = 0, page = 0; page < 100; page++) {
      const response = await fetch(`/api/laso/sessions?limit=100&offset=${offset}`, { cache: "no-store" });
      if (!response.ok) { const error = new Error("Session listing failed."); error.status = response.status; throw error; }
      const items = await response.json(); if (!Array.isArray(items)) throw new Error("unexpected sessions response");
      all.push(...items); if (items.length < 100) break; offset += items.length;
    }
    return all.sort((a,b) => Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || "")).slice(0,20);
  }
  async function load() {
    try {
      const capabilities = await window.LasoCapabilities.load();
      if (capabilities.supports("sessions.durable") === false) {
        sidebar?.classList.remove("hidden");
        root.replaceChildren(add("p", "This LASO server does not advertise durable sessions. The run workspace remains available.", "sidebar-empty"));
        return;
      }
      const sessions = await recentSessions();
      sidebar?.classList.remove("hidden"); newChat?.classList.remove("hidden");
      root.replaceChildren();
      for (const session of sessions) {
        const link = document.createElement("a"); link.className = "recent-item"; link.href = `/sessions/${encodeURIComponent(session.id)}`;
        let label = `${session.pipeline_id || "LASO session"} · ${new Date(session.created_at || Date.now()).toLocaleDateString()}`;
        try {
          const turnsResponse = await fetch(`/api/laso/sessions/${encodeURIComponent(session.id)}/turns?limit=1&offset=0`, { cache: "no-store" });
          if (turnsResponse.ok) {
            const turns = await turnsResponse.json();
            const input = turns?.[0]?.input;
            const prompt = typeof input === "string" ? input : input?.prompt || input?.text || input?.task || "";
            if (prompt) label = String(prompt).replace(/\s+/g, " ").slice(0, 58);
          }
        } catch {}
        link.append(add("span", label, "recent-title"));
        link.append(add("span", `${session.state || "open"} · ${new Date(session.updated_at || session.created_at).toLocaleDateString()}`, "recent-meta"));
        root.append(link);
      }
      if (!sessions.length) root.append(add("p", "No sessions yet.", "sidebar-empty"));
    } catch (error) {
      sidebar?.classList.remove("hidden");
      const message = error.status === 404
        ? "This LASO server does not expose durable sessions. The run workspace remains available."
        : "Could not reach LASO sessions. The run workspace remains available; retry when LASO reconnects.";
      root.replaceChildren(add("p", message, "sidebar-empty"));
    }
  }
  load();
  window.setInterval(() => { if (!document.hidden) load(); }, 15000);
})();
