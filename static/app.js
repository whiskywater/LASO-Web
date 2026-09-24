"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const UI = window.LasoUI;
const state = {
  data: {}, errors: {}, activeView: "new", activeRunId: "", runMessages: [], runEvents: [],
  draft: "", customInput: "", selectedPipeline: "", lastPipelineChoices: "", refreshing: false,
  hasLoaded: false, lastPipelineError: "", refreshPending: false,
  mobileOpen: false, collapsed: false, requestNotes: Object.create(null)
};
const endpoints = {
  health: "/api/laso/health", version: "/api/laso/version",
  workers: "/api/laso/workers?limit=100&offset=0", jobs: "/api/laso/worker-jobs?limit=100&offset=0",
  runs: "/api/laso/runs?limit=100&offset=0", pipelines: "/api/laso/pipelines?limit=100&offset=0",
  approvals: "/api/laso/approvals?limit=100&offset=0", requests: "/api/laso/worker-requests?limit=100&offset=0",
  schedules: "/api/laso/schedules?limit=100&offset=0"
};

function text(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return "Structured value"; }
  }
  return String(value);
}
function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}
function button(label, className, onClick, ariaLabel) {
  const node = element("button", label, className);
  node.type = "button";
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  node.addEventListener("click", onClick);
  return node;
}
function detail(value, label = "Technical details") {
  const node = document.createElement("details");
  node.className = "technical-details";
  node.append(element("summary", label));
  const pre = element("pre", JSON.stringify(value, null, 2), "json");
  node.append(pre);
  return node;
}
function stateBadge(value) {
  const label = UI.humanize(value || "unknown");
  return element("span", label, `state-pill ${UI.stateTone(value)}`);
}
function list(name) { return UI.items(state.data[name]); }
function routeId(value) { return encodeURIComponent(String(value)).replaceAll("%40", "@"); }
function showNotice(message, isError = false) {
  const box = $("#notice");
  box.textContent = message;
  box.className = `notice${isError ? " error" : ""}${message ? "" : " hidden"}`;
  box.setAttribute("role", isError ? "alert" : "status");
}
function errorFor(name) { return state.errors[name] || ""; }

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("The request timed out. LASO may still be working; it will reconnect automatically.");
    throw new Error("Could not reach LASO-Web. Check that the LASO-Web service is running.");
  }
  let value;
  try { value = await response.json(); }
  catch { throw new Error(`LASO-Web returned an unexpected response (${response.status}).`); }
  if (!response.ok) throw new Error(value.detail || value.error || `Request failed (${response.status}).`);
  return value;
}

async function refresh(options = {}) {
  if (state.refreshing) { state.refreshPending = true; return; }
  state.refreshing = true;
  const refreshButton = $("#refresh");
  if (!options.quiet) refreshButton.disabled = true;
  const keys = Object.keys(endpoints);
  const values = await Promise.allSettled(keys.map(key => api(endpoints[key])));
  keys.forEach((key, index) => {
    const result = values[index];
    if (result.status === "fulfilled") {
      state.data[key] = result.value;
      delete state.errors[key];
    } else {
      state.errors[key] = result.reason.message;
      if (state.data[key] === undefined) state.data[key] = [];
    }
  });
  const online = !errorFor("health") && state.data.health?.status === "ok";
  $("#connection-dot").className = `dot ${online ? "good" : "bad"}`;
  $("#connection-label").textContent = online
    ? `LASO connected${state.data.version?.version ? ` · ${state.data.version.version}` : ""}`
    : `Reconnecting · ${errorFor("health") || "unexpected health response"}`;

  if (state.activeRunId && online) {
    const id = routeId(state.activeRunId);
    const messages = await Promise.allSettled([
      api(`/api/laso/runs/${id}/messages`), api(`/api/laso/runs/${id}/events`)
    ]);
    state.runMessages = messages[0].status === "fulfilled" ? UI.items(messages[0].value) : [];
    state.runEvents = messages[1].status === "fulfilled" ? UI.items(messages[1].value) : [];
  }
  updateSidebar();
  const choices = list("pipelines").map(p => `${p.name || p.id}@${p.version || 1}`).join("|");
  const firstLoad = !state.hasLoaded;
  const pipelineError = errorFor("pipelines");
  const composerFocused = $("#task-composer")?.contains(document.activeElement) || false;
  if (state.activeView !== "new" || !$("#task-composer") || firstLoad || choices !== state.lastPipelineChoices
      || (pipelineError !== state.lastPipelineError && !composerFocused)) renderView();
  else {
    const welcomeCopy = $(".welcome-copy");
    if (welcomeCopy) welcomeCopy.textContent = errorFor("health")
      ? "LASO is reconnecting. Your task will stay here until you submit it."
      : "Choose a pipeline, describe the task, and LASO will run it.";
  }
  state.lastPipelineChoices = choices;
  state.lastPipelineError = pipelineError;
  state.hasLoaded = true;
  state.refreshing = false;
  refreshButton.disabled = false;
  if (state.refreshPending) {
    state.refreshPending = false;
    window.setTimeout(() => refresh({ quiet: true }), 0);
  }
}

function titleForRun(run) {
  const pipeline = list("pipelines").find(item => String(item.id || "") === String(run.pipeline_id || "")
    || String(item.name || "") === String(run.pipeline_id || run.pipeline || ""));
  return UI.runTitle(run, pipeline?.name || run.pipeline_name || "");
}
function pipelineLabel(run) {
  const pipeline = list("pipelines").find(item => String(item.id || "") === String(run.pipeline_id || "")
    || String(item.name || "") === String(run.pipeline_id || run.pipeline || ""));
  return UI.pipelineName(run, pipeline?.name || run.pipeline_name || "");
}
function updateSidebar() {
  const runs = [...list("runs")].sort((a, b) => Date.parse(b.created_at || b.updated_at || "") - Date.parse(a.created_at || a.updated_at || ""));
  const recent = $("#recent-runs"); recent.replaceChildren();
  if (errorFor("runs") && !runs.length) {
    recent.append(element("p", "Could not load recent work.", "sidebar-empty"));
  } else if (!runs.length) {
    recent.append(element("p", "Your runs will appear here.", "sidebar-empty"));
  } else {
    runs.slice(0, 12).forEach(run => {
      const item = button("", `recent-item${state.activeRunId === run.id ? " selected" : ""}`, () => openRun(run.id));
      item.title = titleForRun(run);
      item.append(element("span", titleForRun(run), "recent-title"));
      const meta = element("span", undefined, "recent-meta");
      meta.append(element("span", UI.humanize(run.state || "unknown")), element("span", UI.relativeTime(run.created_at || run.updated_at)));
      item.append(meta); recent.append(item);
    });
  }
  const pending = list("approvals").filter(x => UI.pending(UI.stateOf(x))).length + list("requests").filter(x => UI.pending(UI.stateOf(x))).length;
  $("#approval-count").textContent = pending ? String(pending) : "";
  $("#approval-count").hidden = !pending;
  document.body.classList.toggle("sidebar-collapsed", state.collapsed);
  document.body.classList.toggle("sidebar-open", state.mobileOpen);
  const mobile = matchMedia("(max-width: 760px)").matches;
  $("#sidebar-toggle").setAttribute("aria-expanded", String(mobile ? state.mobileOpen : !state.collapsed));
  $("#drawer-backdrop").hidden = !state.mobileOpen;
  document.querySelectorAll(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.view === state.activeView));
}

function setView(view) {
  state.activeView = view;
  if (view === "new") state.activeRunId = "";
  state.mobileOpen = false;
  updateSidebar();
  renderView();
  $("#main").focus({ preventScroll: true });
}
function openRun(id) {
  state.activeRunId = String(id);
  state.activeView = "thread";
  state.mobileOpen = false;
  updateSidebar();
  renderView();
  refresh({ quiet: true });
  $("#main").focus({ preventScroll: true });
}

function sectionError(name) {
  const message = errorFor(name);
  if (!message) return null;
  const box = element("div", undefined, "inline-error");
  box.append(element("strong", `Could not load ${name}.`), element("span", message));
  return box;
}
function emptyState(title, message) {
  const node = element("div", undefined, "empty-state");
  node.append(element("span", "◇", "empty-icon"), element("h3", title), element("p", message));
  return node;
}
function sectionTitle(title, subtitle, extra) {
  const header = element("div", undefined, "section-title");
  const copy = element("div"); copy.append(element("h1", title), element("p", subtitle)); header.append(copy);
  if (extra) header.append(extra);
  return header;
}

function taskComposer() {
  const form = element("form", undefined, "composer");
  form.id = "task-composer";
  const top = element("div", undefined, "composer-top");
  const pipelineLabel = element("label", "Run with"); pipelineLabel.htmlFor = "pipeline-select";
  const select = document.createElement("select"); select.id = "pipeline-select"; select.required = true;
  const pipelines = list("pipelines");
  if (!pipelines.length) {
    const option = element("option", errorFor("pipelines") ? "Pipelines unavailable" : "No pipelines registered");
    option.value = ""; select.append(option); select.disabled = true;
  } else {
    const option = element("option", "Choose a pipeline"); option.value = ""; select.append(option);
    pipelines.forEach(pipeline => {
      const value = `${pipeline.name || pipeline.id}@${pipeline.version || 1}`;
      const optionNode = element("option", `${pipeline.name || "Pipeline"} · v${pipeline.version || 1}`);
      optionNode.value = value; select.append(optionNode);
    });
    const remembered = pipelines.some(p => `${p.name || p.id}@${p.version || 1}` === state.selectedPipeline)
      ? state.selectedPipeline : (pipelines.length === 1 ? `${pipelines[0].name || pipelines[0].id}@${pipelines[0].version || 1}` : "");
    state.selectedPipeline = remembered;
    select.value = remembered;
  }
  select.addEventListener("change", () => { state.selectedPipeline = select.value; });
  top.append(pipelineLabel, select);
  const label = element("label", "Your task"); label.htmlFor = "task-input";
  const input = document.createElement("textarea"); input.id = "task-input"; input.rows = 3;
  input.placeholder = "Describe what you want LASO to do…";
  input.setAttribute("aria-describedby", "keyboard-hint"); input.value = state.draft;
  input.addEventListener("input", () => { state.draft = input.value; });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  const advanced = document.createElement("details"); advanced.className = "advanced-input";
  advanced.append(element("summary", "Options · custom pipeline input"));
  const help = element("p", "Use this when your selected pipeline expects fields other than a prompt. Enter the input object LASO should receive.", "helper-text");
  const custom = document.createElement("textarea"); custom.id = "custom-input"; custom.rows = 4;
  custom.placeholder = '{\n  "field": "value"\n}'; custom.value = state.customInput;
  custom.setAttribute("aria-label", "Custom pipeline input JSON object");
  custom.addEventListener("input", () => { state.customInput = custom.value; });
  advanced.append(help, custom);
  const hint = element("span", "Enter to run · Shift+Enter for a new line", "composer-hint"); hint.id = "keyboard-hint";
  const footer = element("div", undefined, "composer-footer");
  const hintWrap = element("div", undefined, "composer-help"); hintWrap.append(advanced, hint);
  const submit = element("button", undefined, "run-button"); submit.type = "submit";
  submit.disabled = !pipelines.length;
  submit.append(element("span", pipelines.length ? "Run task" : "No pipeline available"), element("span", "↑", "send-icon"));
  footer.append(hintWrap, submit);
  form.append(top, label, input, advanced, footer);
  form.addEventListener("submit", submitTask);
  return form;
}

async function submitTask(event) {
  event.preventDefault();
  const prompt = state.draft.trim();
  if (!state.selectedPipeline) { showNotice("Choose a registered pipeline to run.", true); $("#pipeline-select")?.focus(); return; }
  if (!prompt && !state.customInput.trim()) { showNotice("Describe the task you want LASO to run.", true); $("#task-input")?.focus(); return; }
  let input;
  if (state.customInput.trim()) {
    try { input = JSON.parse(state.customInput); }
    catch { showNotice("Custom pipeline input must be valid JSON.", true); $("#custom-input")?.focus(); return; }
    if (!input || typeof input !== "object" || Array.isArray(input)) { showNotice("Custom pipeline input must be a JSON object.", true); $("#custom-input")?.focus(); return; }
  } else input = { prompt };
  const runButton = $(".run-button"); runButton.disabled = true;
  try {
    const result = await api(`/api/laso/pipelines/${routeId(state.selectedPipeline)}/runs`, {
      method: "POST", body: JSON.stringify({ input })
    });
    state.submittedPrompt = prompt;
    state.draft = ""; state.customInput = "";
    if (!result.id) throw new Error("LASO accepted the request but did not return a run identifier.");
    state.activeRunId = String(result.id); state.activeView = "thread";
    showNotice("LASO accepted your task.");
    await refresh({ quiet: true });
    renderView(); updateSidebar();
  } catch (error) {
    showNotice(error.message, true);
    runButton.disabled = false;
  }
}

function renderNew(root) {
  const page = element("section", undefined, "welcome-page");
  const emblem = element("div", "L", "welcome-mark"); emblem.setAttribute("aria-hidden", "true");
  const status = errorFor("health") ? "LASO is reconnecting. Your task will stay here until you submit it." : "Choose a pipeline, describe the task, and LASO will run it.";
  page.append(emblem, element("p", "YOUR WORKSPACE", "eyebrow"), element("h1", "What would you like LASO to do?"), element("p", status, "welcome-copy"), taskComposer());
  const pipelines = list("pipelines");
  if (errorFor("pipelines")) page.append(sectionError("pipelines"));
  else if (!pipelines.length) page.append(emptyState("No pipelines are registered yet", "Register a pipeline with LASO, then come back here to start a run."));
  const runs = [...list("runs")].sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || "")).slice(0, 3);
  if (runs.length) {
    const recent = element("section", undefined, "welcome-recent");
    const heading = element("div", undefined, "mini-heading"); heading.append(element("h2", "Pick up recent work"), button("View all", "text-button", () => setView("history")));
    recent.append(heading);
    const cards = element("div", undefined, "recent-cards");
    runs.forEach(run => {
      const card = button("", "recent-card", () => openRun(run.id));
      card.append(element("span", titleForRun(run), "recent-card-title"), stateBadge(run.state), element("span", `${pipelineLabel(run)} · ${UI.relativeTime(run.created_at || run.updated_at)}`, "recent-card-meta"));
      cards.append(card);
    });
    recent.append(cards); page.append(recent);
  }
  root.append(page);
}

function findActiveRun() { return list("runs").find(run => String(run.id) === state.activeRunId); }
function messagePrompt(messages) {
  for (const message of messages) {
    const payload = message?.payload;
    for (const source of [payload, payload?.input]) {
      if (!source || typeof source !== "object") continue;
      for (const key of ["prompt", "task", "instruction", "text"]) {
        if (typeof source[key] === "string" && source[key].trim()) return source[key].trim();
      }
    }
  }
  return "";
}
function readablePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const chunks = [];
  for (const key of ["summary", "text", "content", "answer", "greeting", "output", "result", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) chunks.push(value.trim());
  }
  return chunks.join("\n\n");
}
function isActive(value) { return !UI.terminal(value); }

function workerJobCard(job, compact = false) {
  const worker = list("workers").find(item => String(item.id || "") === String(job.worker_id || ""));
  const workerName = job.worker_name || worker?.name || worker?.type || worker?.component || "Worker job";
  const card = element("article", undefined, compact ? "worker-activity-card" : "worker-job-card");
  const heading = element("div", undefined, "worker-job-heading");
  heading.append(element("strong", workerName), stateBadge(UI.stateOf(job)));
  const date = job.started_at || job.created_at || job.updated_at;
  if (date) { const time = element("time", `Started ${UI.relativeTime(date)}`); time.dateTime = date; time.title = date; heading.append(time); }
  card.append(heading);
  const usage = job.usage;
  if (usage && typeof usage === "object" && !Array.isArray(usage)) {
    const metrics = [];
    for (const [key, label] of [["wall_duration_ms", "Wall time"], ["input_tokens", "Input tokens"], ["output_tokens", "Output tokens"], ["total_tokens", "Total tokens"], ["cost_units", "Cost units"]]) {
      if (usage[key] !== undefined && usage[key] !== null) metrics.push(`${label}: ${text(usage[key])}`);
    }
    if (metrics.length) card.append(element("p", metrics.join(" · "), "job-usage"));
  }
  card.append(detail(job, "Worker job details"));
  if (isActive(UI.stateOf(job))) {
    card.append(button("Cancel worker job", "button secondary danger", () => act(`/api/laso/worker-jobs/${routeId(job.id)}/cancel`, {})));
  }
  return card;
}

function renderActivity(run) {
  const section = element("section", undefined, "thread-section");
  section.append(element("h2", "Activity", "thread-section-title"));
  if (!state.runEvents.length) {
    section.append(emptyState("No activity events returned", errorFor("health") ? "Activity will update when LASO reconnects." : "LASO has not exposed any run events yet."));
    return section;
  }
  const timeline = element("ol", undefined, "timeline");
  const events = [...state.runEvents].sort((a, b) => Date.parse(a.occurred_at || a.time || a.ingested_at || "") - Date.parse(b.occurred_at || b.time || b.ingested_at || ""));
  events.forEach(event => {
    const item = element("li", undefined, "timeline-item");
    item.append(element("span", "", "timeline-dot"));
    const copy = element("div", undefined, "timeline-copy");
    copy.append(element("strong", UI.humanize(event.type || "Run event")));
    const when = event.occurred_at || event.time || event.ingested_at;
    if (when) { const date = element("time", UI.relativeTime(when)); date.dateTime = when; date.title = when; copy.append(date); }
    copy.append(detail(event, "Event details")); item.append(copy); timeline.append(item);
  });
  section.append(timeline); return section;
}
function renderMessages() {
  const messages = state.runMessages;
  if (!messages.length) return null;
  const section = element("section", undefined, "thread-section");
  section.append(element("h2", "Messages and results", "thread-section-title"));
  messages.forEach(message => {
    const payload = message.payload;
    const card = element("article", undefined, "message-card");
    const heading = element("div", undefined, "message-heading");
    heading.append(element("span", UI.humanize(message.type || "LASO message"), "message-kind"));
    const date = message.timestamp;
    if (date) { const time = element("time", UI.relativeTime(date)); time.dateTime = date; time.title = date; heading.append(time); }
    card.append(heading);
    const summary = readablePayload(payload);
    if (summary) card.append(element("div", summary, "message-content"));
    else card.append(element("p", "LASO returned structured data for this step.", "message-muted"));
    card.append(detail(message, "Inspect message data")); section.append(card);
  });
  return section;
}
function approvalCard(record, kind) {
  const card = element("article", undefined, "approval-card");
  const copy = element("div", undefined, "approval-copy");
  copy.append(element("span", kind === "approval" ? "LASO needs a decision" : `Worker ${record.type || record.request_type || "request"}`, "eyebrow"));
  copy.append(element("h3", record.title || record.summary || (kind === "approval" ? "Review this operation" : "Review worker request")));
  const payload = record.payload || record.context || record.details;
  const preview = readablePayload(payload);
  if (preview) copy.append(element("p", preview, "approval-preview"));
  else if (record.command) copy.append(element("code", record.command, "approval-command"));
  const technical = detail(record, "Request details"); copy.append(technical);
  card.append(copy);
  const actions = element("div", undefined, "approval-actions");
  if (kind === "approval") {
    actions.append(button("Reject", "button secondary danger", () => act(`/api/laso/approvals/${routeId(record.id)}/reject`, { comment: "Rejected in LASO-Web" })));
    actions.append(button("Approve", "button primary", () => act(`/api/laso/approvals/${routeId(record.id)}/approve`, { comment: "Approved in LASO-Web" })));
  } else {
    const type = String(record.type || record.request_type || "").toLowerCase();
    if (type === "question") {
      const answer = document.createElement("textarea"); answer.rows = 2; answer.placeholder = "Write an answer…"; answer.setAttribute("aria-label", "Answer worker question");
      answer.value = state.requestNotes[record.id] || "";
      answer.addEventListener("input", () => { state.requestNotes[record.id] = answer.value; });
      const send = button("Send answer", "button primary", () => {
        if (!answer.value.trim()) { showNotice("Add an answer before sending.", true); answer.focus(); return; }
        act(`/api/laso/worker-requests/${routeId(record.id)}/answer`, { payload: { answer: answer.value.trim() } });
      });
      actions.append(answer, send);
    } else {
      actions.append(button("Deny", "button secondary danger", () => act(`/api/laso/worker-requests/${routeId(record.id)}/deny`, { payload: {} })));
      actions.append(button("Approve", "button primary", () => act(`/api/laso/worker-requests/${routeId(record.id)}/approve`, { payload: {} })));
    }
  }
  card.append(actions); return card;
}
function relatedDecisions(run) {
  const nodes = [];
  list("approvals").filter(item => String(item.run_id || "") === String(run.id) && UI.pending(UI.stateOf(item)))
    .forEach(item => nodes.push(approvalCard(item, "approval")));
  list("requests").filter(item => (String(item.run_id || "") === String(run.id)
    || (run.worker_job_id && String(item.worker_job_id || "") === String(run.worker_job_id))) && UI.pending(UI.stateOf(item)))
    .forEach(item => nodes.push(approvalCard(item, "request")));
  return nodes;
}
function renderThread(root) {
  const run = findActiveRun();
  if (!run) {
    root.append(emptyState("This run is not in the current history", "It may have moved beyond the API’s current page of recent runs, or LASO may be reconnecting."));
    root.append(button("Back to new task", "button primary", () => setView("new")));
    return;
  }
  const page = element("section", undefined, "thread-page");
  const top = sectionTitle(titleForRun(run), `${pipelineLabel(run)} · Started ${UI.relativeTime(run.created_at || run.updated_at)}`,
    button("New task", "button secondary", () => setView("new")));
  page.append(top);
  const card = element("section", undefined, "run-summary");
  const statusLine = element("div", undefined, "run-summary-line");
  statusLine.append(stateBadge(run.state));
  const updated = run.updated_at || run.created_at;
  if (updated) { const time = element("time", `Updated ${UI.relativeTime(updated)}`); time.dateTime = updated; time.title = updated; statusLine.append(time); }
  card.append(statusLine);
  const stateCopy = {
    queued: "LASO has queued this run.", starting: "LASO is starting this run.", running: "LASO is working on this run.",
    waiting: "This run is waiting for a LASO-side event or decision.", completed: "LASO completed this run.",
    waitingforapproval: "LASO is waiting for your approval.", awaitingapproval: "LASO is waiting for your approval.",
    waitingforinput: "LASO is waiting for input.", awaitinginput: "LASO is waiting for input.",
    failed: "LASO reported that this run failed.", cancelled: "This run was cancelled.", canceled: "This run was cancelled."
  };
  const statusValue = String(run.state || "unknown").toLowerCase();
  card.append(element("p", stateCopy[statusValue.replaceAll("_", "")] || `Current state: ${UI.humanize(run.state || "unknown")}.`, "run-state-copy"));
  if (run.error) card.append(element("div", run.error, "run-error"));
  const requestText = messagePrompt(state.runMessages) || UI.promptOf(run) || (state.submittedPrompt && state.activeRunId === run.id ? state.submittedPrompt : "");
  if (requestText) {
    const user = element("article", undefined, "user-message");
    user.append(element("span", "YOUR TASK", "eyebrow"), element("p", requestText));
    page.append(user);
  } else {
    const supplied = run.message?.payload ?? run.message;
    const submission = element("article", undefined, "user-message");
    submission.append(element("span", "PIPELINE INPUT", "eyebrow"), element("p", "This run’s input is available in the technical details below."), detail(supplied, "Submitted input"));
    page.append(submission);
  }
  card.append(detail(run)); page.append(card);
  const decisions = relatedDecisions(run);
  if (decisions.length) {
    const pending = element("section", undefined, "thread-section");
    pending.append(element("h2", "LASO needs your input", "thread-section-title"));
    decisions.forEach(decision => pending.append(decision)); page.append(pending);
  }
  const messages = renderMessages(); if (messages) page.append(messages);
  page.append(renderActivity(run));
  const jobs = list("jobs").filter(job => String(job.run_id || job.pipeline_run_id || "") === String(run.id));
  if (jobs.length) {
    const workerSection = element("section", undefined, "thread-section");
    workerSection.append(element("h2", "Worker activity", "thread-section-title"));
    jobs.forEach(job => workerSection.append(workerJobCard(job, true)));
    page.append(workerSection);
  }
  if (isActive(run.state)) {
    page.append(button("Cancel run", "button secondary danger cancel-run", () => act(`/api/laso/runs/${routeId(run.id)}/cancel`, {})));
  }
  root.append(page);
}

function renderWorkers(root) {
  const workers = list("workers");
  const page = element("section", undefined, "secondary-page");
  page.append(sectionTitle("Workers", "Workers and capabilities reported by LASO."));
  if (sectionError("workers")) page.append(sectionError("workers"));
  if (!workers.length && !errorFor("workers")) page.append(emptyState("No workers are registered", "Pipelines may use built-in steps or workers configured in LASO."));
  const grid = element("div", undefined, "worker-grid");
  workers.forEach(worker => {
    const card = element("article", undefined, "worker-card");
    const title = element("div", undefined, "worker-card-title");
    const workerLabel = worker.name || worker.type || worker.component || worker.plugin || "Worker";
    const avatar = element("div", workerLabel.charAt(0).toUpperCase(), "worker-avatar");
    title.append(avatar);
    const name = element("div"); name.append(element("h2", workerLabel), element("p", worker.type || worker.component || worker.plugin || "Worker")); title.append(name);
    const workerState = worker.status || (worker.healthy ? "healthy" : worker.enabled === false ? "disabled" : "unknown");
    card.append(title, stateBadge(workerState));
    const capabilities = Array.isArray(worker.capabilities) ? worker.capabilities : [];
    if (capabilities.length) {
      const tags = element("div", undefined, "capability-list");
      capabilities.forEach(item => tags.append(element("span", typeof item === "string" ? item
        : item && typeof item === "object" ? item.name || item.id || text(item) : text(item), "capability")));
      card.append(element("h3", "Capabilities", "card-subtitle"), tags);
    }
    const assignment = worker.current_assignment || worker.current_job || worker.current_run;
    if (assignment) {
      const assignmentId = typeof assignment === "object" ? assignment.run_id || assignment.job_id || assignment.id : assignment;
      const run = list("runs").find(item => String(item.id || "") === String(assignmentId));
      const job = list("jobs").find(item => String(item.id || "") === String(assignmentId));
      const display = run ? titleForRun(run) : job ? (job.worker_name || "Worker job")
        : typeof assignment === "object" || /^[0-9a-f-]{30,}$/i.test(String(assignmentId)) ? "Active task" : text(assignment);
      card.append(element("p", `Current assignment · ${display}`, "muted small"));
    }
    card.append(detail(worker)); grid.append(card);
  });
  page.append(grid, element("p", "Worker assignment remains part of each pipeline. LASO does not expose a separate operator assignment control.", "page-note"));
  root.append(page);
}

function renderHistory(root) {
  const runs = [...list("runs")].sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""));
  const page = element("section", undefined, "secondary-page");
  page.append(sectionTitle("History", "Runs returned by LASO, with their current durable state."));
  if (sectionError("runs")) page.append(sectionError("runs"));
  if (!runs.length && !errorFor("runs")) page.append(emptyState("No runs yet", "Tasks you start with a registered pipeline will appear here."));
  const rows = element("div", undefined, "history-list");
  runs.forEach(run => {
    const card = button("", `history-card${state.activeRunId === run.id ? " selected" : ""}`, () => openRun(run.id));
    const copy = element("div", undefined, "history-copy");
    copy.append(element("strong", titleForRun(run)), element("span", `${pipelineLabel(run)} · Started ${UI.relativeTime(run.created_at || run.updated_at)}`));
    card.append(copy, stateBadge(run.state));
    if (run.error) card.append(element("span", run.error, "history-error"));
    card.append(detail(run)); rows.append(card);
  });
  page.append(rows);
  const jobs = [...list("jobs")].sort((a, b) => Date.parse(b.created_at || b.started_at || "") - Date.parse(a.created_at || a.started_at || ""));
  const jobsSection = element("section", undefined, "history-jobs");
  jobsSection.append(element("h2", "Worker jobs", "thread-section-title"));
  if (!jobs.length && !errorFor("jobs")) jobsSection.append(emptyState("No worker jobs in recent history", "Worker jobs created by LASO will appear here."));
  if (errorFor("jobs")) jobsSection.append(sectionError("jobs"));
  jobs.forEach(job => jobsSection.append(workerJobCard(job)));
  page.append(jobsSection); root.append(page);
}

function renderApprovals(root) {
  const approvals = list("approvals"); const requests = list("requests");
  const pending = [...approvals.filter(x => UI.pending(UI.stateOf(x))).map(x => [x, "approval"]), ...requests.filter(x => UI.pending(UI.stateOf(x))).map(x => [x, "request"])];
  const page = element("section", undefined, "secondary-page");
  page.append(sectionTitle("Approvals", "Review decisions LASO has explicitly asked you to make."));
  [sectionError("approvals"), sectionError("requests")].filter(Boolean).forEach(err => page.append(err));
  if (!pending.length && !errorFor("approvals") && !errorFor("requests")) page.append(emptyState("You’re all caught up", "Pending pipeline approvals and worker requests will appear here."));
  pending.forEach(([record, kind]) => page.append(approvalCard(record, kind)));
  const resolved = [...approvals.filter(x => !UI.pending(UI.stateOf(x))).map(x => [x, "approval"]), ...requests.filter(x => !UI.pending(UI.stateOf(x))).map(x => [x, "request"])].slice(0, 8);
  if (resolved.length) {
    const section = element("section", undefined, "resolved-section"); section.append(element("h2", "Recently resolved", "thread-section-title"));
    resolved.forEach(([record, kind]) => {
      const row = element("article", undefined, "resolved-row");
      row.append(element("strong", record.title || record.summary || UI.humanize(record.type || record.request_type || kind)), stateBadge(UI.stateOf(record)));
      row.append(detail(record)); section.append(row);
    }); page.append(section);
  }
  root.append(page);
}

function renderSchedules(root) {
  const schedules = list("schedules");
  const page = element("section", undefined, "secondary-page");
  page.append(sectionTitle("Schedules", "Recurring and scheduled work configured in LASO."));
  if (sectionError("schedules")) page.append(sectionError("schedules"));
  if (!schedules.length && !errorFor("schedules")) page.append(emptyState("No schedules configured", "Schedule creation and editing are not exposed by LASO’s current operator API."));
  schedules.forEach(schedule => {
    const card = element("article", undefined, "schedule-card");
    const title = element("div", undefined, "schedule-title");
    title.append(element("h2", schedule.name || `${pipelineLabel(schedule)} schedule`), stateBadge(schedule.enabled ? "enabled" : "disabled"));
    card.append(title, element("p", `Pipeline · ${UI.pipelineName(schedule)}`, "muted"));
    if (schedule.type) card.append(element("p", `Schedule type · ${UI.humanize(schedule.type)}`, "muted"));
    if (schedule.next_due_at) {
      const date = element("time", `Next run · ${UI.relativeTime(schedule.next_due_at)}`, "muted"); date.dateTime = schedule.next_due_at; date.title = schedule.next_due_at; card.append(date);
    }
    card.append(detail(schedule)); page.append(card);
  });
  root.append(page);
}

function renderSystem(root) {
  const page = element("section", undefined, "secondary-page");
  page.append(sectionTitle("System", "A concise view of LASO’s current API status."));
  const health = state.data.health || {};
  const grid = element("div", undefined, "system-grid");
  const values = [
    ["Connection", errorFor("health") ? "Unavailable" : health.status || "Unknown"],
    ["LASO version", state.data.version?.version || "Not reported"],
    ["Registered workers", list("workers").length],
    ["Pipelines", list("pipelines").length],
    ["Runs in recent history", list("runs").length],
    ["Pending decisions", list("approvals").filter(x => UI.pending(UI.stateOf(x))).length + list("requests").filter(x => UI.pending(UI.stateOf(x))).length]
  ];
  values.forEach(([label, value]) => { const card = element("article", undefined, "system-card"); card.append(element("span", label), element("strong", String(value))); grid.append(card); });
  page.append(grid);
  ["health", "version", "workers", "pipelines", "runs", "jobs", "approvals", "requests", "schedules"].forEach(key => {
    const err = sectionError(key); if (err) page.append(err);
  });
  const about = element("section", undefined, "system-note");
  about.append(element("h2", "About this client"), element("p", "LASO-Web can display and submit registered pipeline runs, inspect returned run messages/events, review approvals and worker requests, and browse workers and schedules. It does not create pipelines, edit schedules, assign workers, or invent progress data."));
  page.append(about); root.append(page);
}

function renderView() {
  const root = $("#content"); root.replaceChildren();
  showNotice($("#notice").textContent || "", $("#notice").classList.contains("error"));
  switch (state.activeView) {
    case "thread": renderThread(root); break;
    case "history": renderHistory(root); break;
    case "workers": renderWorkers(root); break;
    case "approvals": renderApprovals(root); break;
    case "schedules": renderSchedules(root); break;
    case "system": renderSystem(root); break;
    default: renderNew(root);
  }
  updateSidebar();
}

async function act(path, body) {
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
    showNotice("LASO accepted the decision.");
    await refresh({ quiet: true });
    renderView();
  } catch (error) { showNotice(error.message, true); }
}

document.querySelectorAll(".nav-item").forEach(item => item.addEventListener("click", () => setView(item.dataset.view)));
$("#new-task").addEventListener("click", () => setView("new"));
$("#brand-home").addEventListener("click", event => { event.preventDefault(); setView("new"); });
$("#sidebar-toggle").addEventListener("click", () => {
  if (matchMedia("(max-width: 760px)").matches) state.mobileOpen = !state.mobileOpen;
  else state.collapsed = !state.collapsed;
  updateSidebar();
});
$("#drawer-backdrop").addEventListener("click", () => { state.mobileOpen = false; updateSidebar(); });
$("#refresh").addEventListener("click", () => refresh());
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh({ quiet: true }); });
window.addEventListener("resize", updateSidebar);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && state.mobileOpen) {
    state.mobileOpen = false; updateSidebar(); $("#sidebar-toggle").focus();
  }
});

renderView();
refresh();
window.setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, 5000);
