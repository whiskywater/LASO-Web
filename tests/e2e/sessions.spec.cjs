"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { startStack, PASSWORD } = require("./stack.cjs");

let stack;
let suiteFailed = false;
const contexts = [];

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => { stack = await startStack(); });
test.afterAll(async ({}, testInfo) => {
  if (stack) {
    if (suiteFailed) {
      const retainedLogs = path.resolve(__dirname, "../../test-results/service-logs");
      fs.cpSync(stack.logs, retainedLogs, { recursive: true });
      console.error(`Browser E2E logs retained at ${retainedLogs}`);
    }
    await stack.stop();
  }
});
test.afterEach(async ({}, testInfo) => {
  const failed = testInfo.status !== testInfo.expectedStatus;
  suiteFailed ||= failed;
  await Promise.all(contexts.splice(0).map(async ({ context, pages }, index) => {
    if (failed) {
      const image = path.join(testInfo.outputDir, `browser-${index + 1}.png`);
      const trace = path.join(testInfo.outputDir, `browser-${index + 1}.zip`);
      try { if (pages[0]) { await pages[0].screenshot({ path: image, fullPage: true }); await testInfo.attach(`browser-${index + 1}`, { path: image, contentType: "image/png" }); } } catch {}
      try { await context.tracing.stop({ path: trace }); await testInfo.attach(`trace-${index + 1}`, { path: trace, contentType: "application/zip" }); } catch {}
    } else {
      try { await context.tracing.stop(); } catch {}
    }
    await context.close();
  }));
});

async function client(browser, url, viewport) {
  const context = await browser.newContext({
    httpCredentials: { username: "operator", password: PASSWORD },
    viewport: viewport || { width: 1440, height: 900 },
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const record = { context, pages: [] }; contexts.push(record);
  context.on("page", page => page.on("console", message => {
    if (message.type() === "error" && !message.text().includes("ERR_INTERNET_DISCONNECTED") && !message.text().includes("status of 502")) console.error(`[browser console] ${message.text()}`);
  }));
  const page = await context.newPage();
  record.pages.push(page);
  await page.goto(url);
  return { context, page };
}

async function createSession(page, webURL = stack.webURLs[0]) {
  await page.goto(`${webURL}/sessions/new`);
  await page.getByTestId("session-pipeline").selectOption("hello@1");
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page).toHaveURL(/\/sessions\/[A-Za-z0-9_.@-]+$/);
  await expect(page.getByTestId("message-composer")).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveAttribute("data-state", "caught-up", { timeout: 15_000 });
  return page.url();
}

async function expectLiveOrCaughtUp(page) {
  await expect(page.getByTestId("chat-status")).toHaveAttribute("data-state", /^(live|caught-up)$/);
}

test("two browser clients share durable ordered turns and recover through SSE replay and LASO restart", async ({ browser }) => {
  const a = await client(browser, stack.webURLs[0]);
  const sessionURL = await createSession(a.page);
  const clientURLB = `${stack.webURLs[1]}${new URL(sessionURL).pathname}`;
  const b = await client(browser, clientURLB);
  await expect(b.page.getByTestId("chat-status")).toHaveAttribute("data-state", "caught-up", { timeout: 15_000 });
  await expect(b.page.locator("#session-list a[aria-current=page]")).toHaveCount(1);
  const sessionID = new URL(sessionURL).pathname.split("/").at(-1);

  await a.page.getByTestId("message-composer").fill("first turn from browser A");
  await a.page.getByTestId("send-turn").click();
  await expect(a.page.getByTestId("user-turn").filter({ hasText: "first turn from browser A" })).toBeVisible();
  await expect(b.page.getByTestId("user-turn").filter({ hasText: "first turn from browser A" })).toBeVisible();
  await expect(a.page.getByTestId("assistant-turn").first()).toBeVisible({ timeout: 30_000 });
  await expect(b.page.getByRole("link", { name: "Run details" }).first()).toBeVisible();

  await b.page.getByTestId("message-composer").fill("second turn");
  await b.page.getByTestId("message-composer").press("Shift+Enter");
  await b.page.getByTestId("message-composer").pressSequentially("from browser B");
  await expect(b.page.getByTestId("message-composer")).toHaveValue("second turn\nfrom browser B");
  await b.page.getByTestId("send-turn").press("Enter");
  await expect(a.page.getByTestId("user-turn").filter({ hasText: "second turn" })).toContainText("from browser B");
  await expect(b.page.getByTestId("assistant-turn").nth(1)).toBeVisible({ timeout: 30_000 });

  const userBubbles = b.page.getByTestId("user-turn");
  await expect(userBubbles).toHaveCount(2);
  await expect(userBubbles.nth(0)).toContainText("first turn from browser A");
  await expect(userBubbles.nth(1)).toContainText("second turn\nfrom browser B");
  await b.page.getByRole("link", { name: "Run details" }).first().click();
  await expect(b.page).toHaveURL(/#\/run\//);
  await b.page.goBack();
  await expect(b.page).toHaveURL(clientURLB);
  await expect(b.page.getByTestId("user-turn")).toHaveCount(2);

  await b.context.setOffline(true);
  await expect(b.page.getByTestId("chat-status")).toHaveAttribute("data-state", "reconnecting", { timeout: 10_000 });
  await a.page.getByTestId("message-composer").fill("third turn while browser B is offline");
  await a.page.getByTestId("send-turn").click();
  await expect(a.page.getByTestId("user-turn")).toHaveCount(3);
  await b.context.setOffline(false);
  await expect(b.page.getByTestId("user-turn").filter({ hasText: "third turn while browser B is offline" })).toBeVisible({ timeout: 30_000 });
  await expect(b.page.getByTestId("user-turn")).toHaveCount(3);
  await expect(b.page.getByTestId("user-turn").nth(2)).toContainText("third turn while browser B is offline");

  await expect(b.page.getByTestId("chat-status")).toHaveAttribute("data-state", "caught-up", { timeout: 15_000 });
  const refresh = await client(browser, clientURLB);
  await expect(refresh.page.getByTestId("user-turn")).toHaveCount(3);
  await expect(refresh.page.getByTestId("chat-status")).toHaveAttribute("data-state", "caught-up", { timeout: 15_000 });

  await stack.stopLaso();
  await expect(a.page.getByTestId("chat-status")).toHaveAttribute("data-state", /^(reconnecting|unavailable)$/, { timeout: 15_000 });
  await stack.restartLaso();
  await expectLiveOrCaughtUp(a.page);
  await refresh.page.reload();
  await expect(refresh.page.getByTestId("user-turn")).toHaveCount(3);
  await expect(refresh.page).toHaveURL(clientURLB);
  await expect(refresh.page.getByTestId("chat-status")).toHaveAttribute("data-state", "caught-up", { timeout: 15_000 });

  a.page.once("dialog", dialog => dialog.accept());
  await a.page.getByTestId("close-session").click();
  await expect(a.page.getByTestId("closed-session-note")).toBeVisible();
  await expect(a.page.getByTestId("message-composer")).toHaveCount(0);
  await expect(b.page.getByTestId("chat-status")).toHaveAttribute("data-state", "closed", { timeout: 15_000 });
  await expect(b.page.getByTestId("message-composer")).toHaveCount(0);
  await expect(b.page.getByTestId("user-turn")).toHaveCount(3);
  await expect(a.page.locator('#session-list a[data-state="closed"]')).toHaveCount(1);
  expect(sessionID).toMatch(/^[A-Za-z0-9_.@-]+$/);
});

test("authenticated workspace covers runs, operator views, approvals, and LASO outage recovery", async ({ browser }) => {
  const { page } = await client(browser, stack.webURLs[0]);
  await expect(page.locator("#connection-label")).toHaveText("Connected", { timeout: 15_000 });
  const browserVisible = await page.evaluate(async () => {
    const paths = ["/", "/app.js", "/sessions.js", "/api/laso/version"];
    return (await Promise.all(paths.map(async route => await (await fetch(route)).text()))).join("\n");
  });
  expect(browserVisible).not.toContain("e2e-server-only-secret");
  await expect(page.locator("#pipeline-select")).toContainText("hello");
  await page.locator("#pipeline-select").selectOption("hello@1");
  await page.locator("#task-input").fill("browser standalone run");
  await page.locator(".run-button").click();
  await expect(page).toHaveURL(/#\/run\//);
  await expect(page.locator("#content")).toContainText("browser standalone run", { timeout: 30_000 });
  await expect(page.locator("#content")).toContainText("Completed", { timeout: 30_000 });

  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator("#content")).toContainText("browser standalone run");
  await page.locator("#recent-runs").getByText("browser standalone run").click();
  await expect(page).toHaveURL(/#\/run\//);
  await expect(page.locator("#content")).toContainText("Started");

  await page.getByRole("button", { name: "Workers" }).click();
  await expect(page.locator("#content")).toContainText("No workers are registered");

  await page.locator("#new-task").click();
  await page.locator("#pipeline-select").selectOption("human-approval@1");
  await page.locator("#task-input").fill("browser approval workflow");
  await page.locator(".run-button").click();
  await expect(page.locator("#content")).toContainText("WaitingApproval", { timeout: 30_000 });
  await page.getByRole("button", { name: "Approvals" }).click();
  await expect(page.locator("#content")).toContainText("LASO needs your approval", { timeout: 15_000 });
  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(page.locator("#notice")).toContainText("accepted the decision");
  await page.getByRole("button", { name: "History" }).click();
  await page.locator("#recent-runs").getByText("browser approval workflow").click();
  await expect(page.locator("#content")).toContainText("Completed", { timeout: 30_000 });

  await page.getByRole("button", { name: "Schedules" }).click();
  await expect(page.locator("#content")).toContainText("No schedules configured");
  await page.getByRole("button", { name: "System" }).click();
  await expect(page.locator("#content")).toContainText("Connection");
  await expect(page.locator("#content")).toContainText("ok");

  await stack.stopLaso();
  await page.locator("#refresh").click();
  await expect(page.locator("#connection-label")).toHaveText("Reconnecting…", { timeout: 15_000 });
  await stack.restartLaso();
  await page.locator("#refresh").click();
  await expect(page.locator("#connection-label")).toHaveText("Connected", { timeout: 20_000 });
});

test("mobile session creation, filtering, composer, run details, and return navigation work", async ({ browser }) => {
  const { page } = await client(browser, stack.webURLs[1], { width: 390, height: 844 });
  const sessionURL = await createSession(page, stack.webURLs[1]);
  await page.getByTestId("message-composer").fill("mobile viewport turn");
  await page.getByTestId("send-turn").click();
  await expect(page.getByTestId("user-turn").filter({ hasText: "mobile viewport turn" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Run details" })).toBeVisible({ timeout: 30_000 });

  const toggle = page.locator("#session-nav-toggle");
  await expect(toggle).toHaveAccessibleName("Show session list");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Hide session list");
  await expect(page.locator("#session-sidebar")).toBeVisible();
  await page.getByRole("searchbox", { name: "Filter recent sessions" }).fill("mobile viewport turn");
  await expect(page.getByTestId("session-item")).toContainText("mobile viewport turn");
  await page.getByRole("searchbox", { name: "Filter recent sessions" }).fill("no matching label");
  await expect(page.locator("#session-list")).toContainText("No recent sessions match");
  await page.getByRole("searchbox", { name: "Filter recent sessions" }).fill("");
  await page.getByRole("link", { name: /mobile viewport turn/ }).click();
  await expect(page).toHaveURL(sessionURL);
  await expect(page.getByTestId("user-turn")).toHaveCount(1);
  await page.getByRole("link", { name: "Run details" }).click();
  await expect(page).toHaveURL(/#\/run\//);
  await page.goBack();
  await expect(page).toHaveURL(sessionURL);
  await expect(page.getByTestId("message-composer")).toBeVisible();
});
