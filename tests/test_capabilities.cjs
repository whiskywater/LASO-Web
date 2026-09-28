"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const Capabilities = require("../static/capabilities.js");

test("advertised LASO capabilities retain exact names and ignore unknown value shapes", () => {
  const parsed = Capabilities.parse({ advertised: true, capabilities: ["sessions.durable", "sessions.sse", "sessions.durable", { name: "fake" }, "Bad Name"] });
  assert.equal(parsed.advertised, true);
  assert.deepEqual(parsed.capabilities, ["sessions.durable", "sessions.sse"]);
  assert.equal(parsed.supports("sessions.durable"), true);
  assert.equal(parsed.supports("sessions.context_reduction"), false);
});

test("absent capability advertisement remains unknown for older LASO API probing", () => {
  const parsed = Capabilities.parse({ version: "older" });
  assert.equal(parsed.advertised, false);
  assert.deepEqual(parsed.capabilities, []);
  assert.equal(parsed.supports("sessions.durable"), null);
});
