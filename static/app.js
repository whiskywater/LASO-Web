const $ = (selector, root = document) => root.querySelector(selector);
const state = { data: {}, active: "overview" };
const endpoints = {
  health: "/api/laso/health", version: "/api/laso/version", workers: "/api/laso/workers?limit=100&offset=0",
  jobs: "/api/laso/worker-jobs?limit=100&offset=0", runs: "/api/laso/runs?limit=100&offset=0",
  pipelines: "/api/laso/pipelines?limit=100&offset=0", approvals: "/api/laso/approvals?limit=100&offset=0",
  requests: "/api/laso/worker-requests?limit=100&offset=0", schedules: "/api/laso/schedules?limit=100&offset=0"
};

function list(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []); }
function stateOf(value) { return value?.state ?? value?.status ?? value?.decision; }
function text(value, fallback = "—") {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function routeId(value) { return encodeURIComponent(String(value)).replaceAll("%40", "@"); }
function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}
function status(value) {
  const label = text(value, "Unknown");
  const low = label.toLowerCase();
  const kind = ["completed", "healthy", "ok", "approved", "answered", "enabled"].some(x => low.includes(x)) ? "good"
    : ["failed", "error", "denied", "cancelled", "unavailable"].some(x => low.includes(x)) ? "bad"
      : ["pending", "waiting", "queued", "running", "unknown", "disabled"].some(x => low.includes(x)) ? "warn" : "";
  return element("span", label, `status ${kind}`);
}
function panel(title, body) {
  const wrap = element("section", undefined, "panel");
  const head = element("div", undefined, "panel-head"); head.append(element("h2", title)); wrap.append(head);
  const content = element("div", undefined, "panel-body");
  if (typeof body === "string") content.append(element("div", body, "empty")); else content.append(body);
  wrap.append(content); return wrap;
}
function table(columns, rows, renderRow) {
  const wrap = element("div", undefined, "table-wrap");
  const tableNode = document.createElement("table"), thead = document.createElement("thead"), tr = document.createElement("tr");
  columns.forEach(col => tr.append(element("th", col.label))); thead.append(tr); tableNode.append(thead);
  const tbody = document.createElement("tbody");
  if (!rows.length) { const row = document.createElement("tr"), cell = element("td", "Nothing to show yet.", "empty"); cell.colSpan = columns.length; row.append(cell); tbody.append(row); }
  rows.forEach(item => {
    const row = document.createElement("tr");
    columns.forEach(col => { const cell = document.createElement("td");
      if (col.render) cell.append(col.render(item)); else cell.textContent = text(item?.[col.key]);
      row.append(cell);
    });
    if (renderRow) renderRow(row, item);
    tbody.append(row);
  });
  tableNode.append(tbody); wrap.append(tableNode); return wrap;
}
function detail(value) {
  const d = document.createElement("details"), summary = element("summary", "Inspect");
  d.append(summary, element("pre", JSON.stringify(value, null, 2), "json")); return d;
}
function heading(title, subtitle, button) {
  const node = element("div", undefined, "page-heading"), left = document.createElement("div");
  left.append(element("h1", title), element("p", subtitle)); node.append(left);
  if (button) node.append(button); return node;
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? {"Content-Type":"application/json"} : {}), ...(options.headers || {}) }, signal: AbortSignal.timeout(10000) });
  let value;
  try { value = await response.json(); } catch { throw new Error(`LASO-Web returned non-JSON (${response.status})`); }
  if (!response.ok) throw new Error(value.detail || value.error || `Request failed (${response.status})`);
  return value;
}
function showNotice(message, isError = false) {
  const box = $("#notice"); box.className = `notice${isError ? " error" : ""}`; box.textContent = message;
  if (!message) box.classList.add("hidden");
}
function card(label, value) {
  const node = element("div", undefined, "card"); node.append(element("div", label, "card-label"), element("div", text(value), "card-value")); return node;
}
function setConnection(ok, label) {
  $("#connection-dot").className = `dot ${ok ? "good" : "bad"}`; $("#connection-label").textContent = label;
}

async function refresh() {
  $("#refresh").disabled = true; showNotice("");
  const names = Object.keys(endpoints);
  const results = await Promise.allSettled(names.map(name => api(endpoints[name])));
  results.forEach((result, index) => { const name = names[index]; if (result.status === "fulfilled") state.data[name] = result.value; else state.data[name] = { __error: result.reason.message }; });
  const connected = !state.data.health?.__error && state.data.health?.status === "ok";
  setConnection(connected, connected ? `LASO online · ${text(state.data.version?.version, "version unknown")}` : `LASO unavailable · ${state.data.health?.__error || "unexpected health response"}`);
  const pending = list(state.data.approvals).filter(x => isPending(stateOf(x))).length + list(state.data.requests).filter(x => isPending(stateOf(x))).length;
  $("#approval-count").textContent = pending || "";
  render(); $("#refresh").disabled = false;
}
function isPending(value) { return ["pending", "waiting", "created"].includes(String(value || "").toLowerCase()); }
function sectionError(key) { return state.data[key]?.__error ? element("div", `${key}: ${state.data[key].__error}`, "error") : null; }

function renderOverview(root) {
  const runs = list(state.data.runs), workers = list(state.data.workers), jobs = list(state.data.jobs);
  const pending = list(state.data.approvals).filter(x => isPending(stateOf(x))).length + list(state.data.requests).filter(x => isPending(stateOf(x))).length;
  root.append(heading("Overview", "A live view of LASO’s exposed runtime and operator APIs."));
  const grid = element("div", undefined, "grid");
  grid.append(card("Workers", workers.length), card("Active worker jobs", jobs.filter(x => ["queued", "running", "waiting", "submitting"].includes(String(stateOf(x)).toLowerCase())).length), card("Runs", runs.length), card("Pending decisions", pending)); root.append(grid);
  ["health", "workers", "jobs", "runs"].forEach(key => { const error = sectionError(key); if (error) root.append(error); });
  root.append(panel("Recent runs", table([
    {label:"Run", key:"id"}, {label:"Pipeline", render:x=>element("span", `${text(x.pipeline_id || x.pipeline)}${x.pipeline_version ? `@${x.pipeline_version}` : ""}`)},
    {label:"State", render:x=>status(stateOf(x))}, {label:"Updated", key:"updated_at"}, {label:"Details", render:detail}
  ], runs.slice(0, 8))));
  const workerSummary = workers.slice(0, 6).map(w => `${text(w.name || w.id)} · ${text(w.type || w.component || w.plugin)}`).join("\n");
  root.append(panel("Available workers", workerSummary || (state.data.workers?.__error ? "Worker list unavailable." : "No workers are currently registered.")));
}
function renderWorkers(root) {
  const items = list(state.data.workers);
  root.append(heading("Workers", "Configured native and process-backed workers reported by LASO."));
  if (sectionError("workers")) root.append(sectionError("workers"));
  root.append(panel("Registered workers", table([
    {label:"Worker", render:w=>element("strong", text(w.name || w.id))},
    {label:"State", render:w=>status(w.status || (w.healthy ? "Healthy" : w.enabled ? "Unavailable" : "Disabled"))},
    {label:"Adapter", render:w=>element("span", text(w.plugin || w.component || w.version))},
    {label:"Capabilities", render:w=>element("span", text(w.capabilities))},
    {label:"Details", render:detail}
  ], items)));
  root.append(element("p", "Worker selection and capabilities are defined by each pipeline; LASO does not expose a separate operator-side worker assignment API.", "muted"));
}
function renderRuns(root) {
  const runs = list(state.data.runs), jobs = list(state.data.jobs), pipelines = list(state.data.pipelines);
  root.append(heading("Runs & jobs", "Start a registered pipeline and inspect durable execution state."));
  const formPanel = element("section", undefined, "panel"), head = element("div", undefined, "panel-head"); head.append(element("h2", "Start a pipeline run")); formPanel.append(head);
  const body = element("div", undefined, "panel-body"), form = document.createElement("form");
  const row = element("div", undefined, "form-row"), pipelineField = element("div", undefined, "field"), inputField = element("div", undefined, "field");
  pipelineField.append(element("label", "Registered pipeline")); const select = document.createElement("select"); select.required = true;
  const placeholder = element("option", "Choose a pipeline"); placeholder.value = ""; select.append(placeholder);
  pipelines.forEach(p => { const opt = element("option", `${text(p.name || p.id)}${p.version ? `@${p.version}` : ""}`); opt.value = `${p.name || p.id}${p.version ? `@${p.version}` : ""}`; select.append(opt); });
  pipelineField.append(select); inputField.append(element("label", "Input JSON (object)")); const textarea = document.createElement("textarea"); textarea.value = "{}"; textarea.setAttribute("aria-label", "Input JSON"); inputField.append(textarea);
  const submit = element("button", "Start run", "button primary"); submit.type = "submit"; row.append(pipelineField, inputField, submit); form.append(row);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try { const input = JSON.parse(textarea.value); if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("Input must be a JSON object");
      const result = await api(`/api/laso/pipelines/${routeId(select.value)}/runs`, {method:"POST", body:JSON.stringify({input})});
      showNotice(`Run accepted: ${text(result.id)}`); await refresh();
    } catch (error) { showNotice(error.message, true); }
  });
  body.append(form); formPanel.append(body); root.append(formPanel);
  if (sectionError("pipelines")) root.append(sectionError("pipelines"));
  root.append(panel("Pipeline runs", table([
    {label:"Run ID", key:"id"}, {label:"Pipeline", render:r=>element("span",`${text(r.pipeline_id || r.pipeline)}${r.pipeline_version ? `@${r.pipeline_version}` : ""}`)},
    {label:"State", render:r=>status(r.state)}, {label:"Result", render:detail},
    {label:"Action", render:r=>{
      const wrap=element("div",undefined,"actions");
      if (!["completed","failed","cancelled","timedout"].includes(String(r.state).toLowerCase())) { const b=element("button","Cancel","button danger"); b.addEventListener("click",()=>act(`/api/laso/runs/${routeId(r.id)}/cancel`,{})); wrap.append(b); }
      return wrap;
    }}
  ], runs)));
  root.append(panel("Worker jobs", table([
    {label:"Job", key:"id"}, {label:"Worker", render:j=>element("span",text(j.worker_id || j.worker))},
    {label:"State", render:j=>status(stateOf(j))}, {label:"Usage", render:j=>element("span",text(j.usage))},
    {label:"Details", render:detail},
    {label:"Action", render:j=>{ const wrap=element("div",undefined,"actions"); if (!["completed","failed","cancelled","timedout"].includes(String(stateOf(j)).toLowerCase())) { const b=element("button","Cancel","button danger"); b.addEventListener("click",()=>act(`/api/laso/worker-jobs/${routeId(j.id)}/cancel`,{})); wrap.append(b); } return wrap; }}
  ], jobs)));
}
async function act(path, body) { try { await api(path,{method:"POST",body:JSON.stringify(body)}); showNotice("Action accepted by LASO."); await refresh(); } catch(error) { showNotice(error.message,true); } }
function renderApprovals(root) {
  const approvals=list(state.data.approvals), requests=list(state.data.requests);
  root.append(heading("Approvals & requests", "Review durable LASO approvals and bounded worker-originated requests."));
  ["approvals","requests"].forEach(k=>{const e=sectionError(k);if(e)root.append(e);});
  root.append(panel("Pipeline approvals", table([
    {label:"Approval",render:a=>element("strong",text(a.id))},{label:"Run / node",render:a=>element("span",`${text(a.run_id)} / ${text(a.node_id)}`)},
    {label:"State",render:a=>status(stateOf(a))},{label:"Context",render:detail},
    {label:"Decision",render:a=>{const wrap=element("div",undefined,"actions");if(isPending(stateOf(a))){[["Approve","approve","button"],["Reject","reject","button danger"]].forEach(([label,action,cls])=>{const b=element("button",label,cls);b.addEventListener("click",()=>act(`/api/laso/approvals/${routeId(a.id)}/${action}`,{comment:"Reviewed in LASO-Web"}));wrap.append(b);});}return wrap;}}
  ],approvals)));
  root.append(panel("Worker requests", table([
    {label:"Request",render:r=>element("strong",text(r.id))},{label:"Kind",render:r=>element("span",text(r.type || r.request_type))},
    {label:"Summary",render:r=>element("span",text(r.title || r.summary))},{label:"State",render:r=>status(stateOf(r))},
    {label:"Payload",render:detail},{label:"Decision",render:r=>{
      const wrap=element("div",undefined,"actions");
      if(isPending(stateOf(r))){
        const type=String(r.type||r.request_type||"").toLowerCase();
        if(type==="question") { const b=element("button","Answer","button"); b.addEventListener("click",()=>{const answer=window.prompt("Answer for the worker:");if(answer!==null)act(`/api/laso/worker-requests/${routeId(r.id)}/answer`,{payload:{answer}});});wrap.append(b); }
        else { [["Approve","approve","button"],["Deny","deny","button danger"]].forEach(([label,action,cls])=>{const b=element("button",label,cls);b.addEventListener("click",()=>act(`/api/laso/worker-requests/${routeId(r.id)}/${action}`,{payload:{}}));wrap.append(b);}); }
      } return wrap;
    }}
  ],requests)));
}
function renderSchedules(root) {
  const schedules=list(state.data.schedules);
  root.append(heading("Schedules", "Configured LASO schedules. Schedule creation and editing are not exposed in this initial GUI."));
  if(sectionError("schedules"))root.append(sectionError("schedules"));
  root.append(panel("Configured schedules",table([
    {label:"Schedule",render:s=>element("strong",text(s.name || s.id))},{label:"Pipeline",render:s=>element("span",`${text(s.pipeline_id || s.pipeline)}${s.pipeline_version?`@${s.pipeline_version}`:""}`)},
    {label:"Type",key:"type"},{label:"Next run",key:"next_due_at"},{label:"Enabled",render:s=>status(s.enabled?"Enabled":"Disabled")},{label:"Details",render:detail}
  ],schedules)));
}
function render() {
  document.querySelectorAll(".view").forEach(v=>{v.replaceChildren();v.classList.toggle("hidden",v.id!==`view-${state.active}`);});
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.toggle("active",n.dataset.view===state.active));
  const root=$(`#view-${state.active}`);
  ({overview:renderOverview,workers:renderWorkers,runs:renderRuns,approvals:renderApprovals,schedules:renderSchedules}[state.active])(root);
}
document.querySelectorAll(".nav-item").forEach(button=>button.addEventListener("click",()=>{state.active=button.dataset.view;render();$("#main").focus({preventScroll:true});}));
$("#refresh").addEventListener("click",refresh);
refresh();
