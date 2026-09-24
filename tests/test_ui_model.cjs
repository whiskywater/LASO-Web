const test = require("node:test");
const assert = require("node:assert/strict");
const UI = require("../static/model.js");

test("collection normalization accepts LASO list and paginated shapes", () => {
  assert.deepEqual(UI.items([{ id: "a" }]), [{ id: "a" }]);
  assert.deepEqual(UI.items({ items: [{ id: "b" }] }), [{ id: "b" }]);
  assert.deepEqual(UI.items({ unexpected: true }), []);
});

test("run labels prefer real prompt input and avoid making an ID the title", () => {
  const run = { id: "opaque-id", pipeline_id: "hello", pipeline_version: 1,
    message: { payload: { input: { prompt: "  Inspect the safe fixture  " } } } };
  assert.equal(UI.promptOf(run), "Inspect the safe fixture");
  assert.equal(UI.runTitle(run), "Inspect the safe fixture");
  assert.equal(UI.runTitle({ id: "opaque-id", pipeline_id: "hello_world" }), "Hello World");
  assert.equal(UI.runTitle({ id: "opaque-id", pipeline_id: "92f3a5e7-d86d-47f8-b892-862c6f9d5213" }), "Pipeline run");
  assert.equal(UI.pipelineName(run), "hello · v1");
  assert.equal(UI.pipelineName({ pipeline_id: "92f3a5e7-d86d-47f8-b892-862c6f9d5213" }), "Pipeline");
});

test("state presentation distinguishes active, successful, and failed work", () => {
  assert.equal(UI.stateTone("Running"), "warn");
  assert.equal(UI.stateTone("WaitingForApproval"), "warn");
  assert.equal(UI.stateTone("Completed"), "good");
  assert.equal(UI.stateTone("Failed"), "bad");
  assert.equal(UI.humanize("WaitingForApproval"), "Waiting For Approval");
  assert.equal(UI.pending("AwaitingApproval"), true);
  assert.equal(UI.pending("Approved"), false);
  assert.equal(UI.terminal("Cancelled"), true);
  assert.equal(UI.terminal("Running"), false);
  assert.equal(UI.stateCopy("WaitingForApproval"), "Needs your approval");
  assert.equal(UI.stateCopy("Completed"), "Completed");
});

test("timestamps become relative labels and invalid dates are omitted", () => {
  const now = Date.parse("2026-01-01T00:10:00Z");
  assert.equal(UI.relativeTime("2026-01-01T00:05:00Z", now), "5 minutes ago");
  assert.equal(UI.dateLabel("2026-01-01T00:10:10Z", now), "In a moment");
  assert.equal(UI.relativeTime("invalid", now), "");
});

test("untrusted values remain data; model creates labels without HTML interpretation", () => {
  const malicious = { id: "x", pipeline_id: "<img src=x onerror=alert(1)>" };
  assert.equal(UI.runTitle(malicious), "<Img Src=X Onerror=Alert(1)>");
  assert.equal(typeof UI.runTitle(malicious), "string");
});

test("thread summaries use only returned lifecycle events and timestamps", () => {
  const run = { state: "Completed", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:01Z" };
  const events = [{ type: "run.completed", time: "2026-01-01T00:00:01Z" }, { type: "node.started" }, { type: "run.created" }];
  assert.equal(UI.activitySummary(events, run), "Completed in 1 second · 3 events");
  assert.equal(UI.activitySummary([], { state: "Running" }), "In progress · 0 events");
  assert.equal(UI.durationLabel("bad", "also bad"), "");
});

test("LASO output prefers readable fields and labels unknown message types conservatively", () => {
  assert.equal(UI.outputText({ greeting: "Hello from LASO", input: { prompt: "private task" } }), "Hello from LASO");
  assert.equal(UI.outputText({ answer_count: 3, input: { prompt: "hidden request" } }), "Answer Count: 3");
  assert.equal(UI.outputText({}), "");
  assert.equal(UI.messageLabel("laso.data"), "LASO");
  assert.equal(UI.messageLabel("laso.data", { error: "step failed" }), "Error");
  assert.equal(UI.messageLabel("worker.result"), "Result");
  assert.equal(UI.messageLabel("pipeline.error"), "Error");
});

test("workspace routes reopen a run after refresh and safely encode identifiers", () => {
  const hash = UI.routeHash("thread", "run/id with spaces");
  assert.deepEqual(UI.route(hash), { view: "thread", runId: "run/id with spaces" });
  assert.deepEqual(UI.route("#/approvals"), { view: "approvals", runId: "" });
  assert.deepEqual(UI.route("#/unknown"), { view: "new", runId: "" });
  assert.deepEqual(UI.route("#/run/%E0%A4%A"), { view: "new", runId: "" });
});
