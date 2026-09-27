"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");

const PASSWORD = "browser-e2e-password-2026";
const WEB_ROOT = path.resolve(__dirname, "../..");
const LASO_ROOT = path.resolve(process.env.LASO_SOURCE_DIR || path.resolve(WEB_ROOT, "../LASO"));
const LASO_SERVER = path.resolve(process.env.LASO_E2E_LASO_SERVER || path.join(LASO_ROOT, "build-browser-e2e/bin/laso-server"));
const WEB_BINARY = path.resolve(process.env.LASO_E2E_WEB || path.join(WEB_ROOT, "build/laso-web"));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function start(command, args, { cwd, env, logPath }) {
  const log = fs.openSync(logPath, "a");
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", log, log], detached: false });
  child.once("exit", () => { try { fs.closeSync(log); } catch {} });
  child.once("error", error => { child.spawnError = error; });
  return child;
}

async function waitFor(url, auth, processes, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let last = "not attempted";
  while (Date.now() < until) {
    if (processes.some(process => process && (process.spawnError || process.exitCode !== null))) throw new Error(`service exited while waiting for ${url}`);
    try {
      const response = await fetch(url, { headers: auth ? { Authorization: `Basic ${Buffer.from(`operator:${PASSWORD}`).toString("base64")}` } : {}, signal: AbortSignal.timeout(1200) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`service did not become ready at ${url}: ${last}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  let timer;
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => { timer = setTimeout(resolve, 5000); }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startStack() {
  for (const file of [LASO_SERVER, WEB_BINARY]) if (!fs.existsSync(file)) throw new Error(`missing E2E binary ${file}; run tests/e2e/build-and-test.sh first`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laso-web-browser-e2e-"));
  const logs = path.join(root, "logs"); fs.mkdirSync(logs);
  const ports = [await freePort(), await freePort(), await freePort()];
  const lasoConfig = path.join(root, "laso.yaml");
  fs.writeFileSync(lasoConfig,
    `data_dir: ${JSON.stringify(path.join(root, "state"))}\n` +
    `artifact_root: ${JSON.stringify(path.join(root, "state", "artifacts"))}\n` +
    "storage_backend: sqlite\napi_host: 127.0.0.1\n" +
    `api_port: ${ports[0]}\nworkers: 2\n`, { mode: 0o600 });
  const apiURL = `http://127.0.0.1:${ports[0]}`;
  let lasoProcess;
  const startLaso = async () => {
    lasoProcess = start(LASO_SERVER, ["--config", lasoConfig, "--host", "127.0.0.1", "--port", String(ports[0])], {
      cwd: root, env: { ...process.env }, logPath: path.join(logs, "laso.log"),
    });
    await waitFor(`${apiURL}/api/v1/health`, null, [lasoProcess]);
    for (const name of ["hello-pipeline", "human-approval"]) {
      const yaml = fs.readFileSync(path.join(LASO_ROOT, "examples", name, "pipeline.yaml"), "utf8");
      const response = await fetch(`${apiURL}/api/v1/pipelines`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ yaml }) });
      if (!response.ok) throw new Error(`register ${name} fixture in LASO: HTTP ${response.status}: ${await response.text()}`);
    }
  };
  const webProcesses = [];
  try {
    await startLaso();
    const webURLs = [];
    for (let index = 0; index < 2; index++) {
      const port = ports[index + 1];
      const webProcess = start(WEB_BINARY, [], {
        cwd: root,
        env: { ...process.env, LASO_URL: apiURL, LASO_WEB_BIND: "127.0.0.1", LASO_WEB_PORT: String(port),
          LASO_WEB_PASSWORD: PASSWORD, LASO_WEB_ALLOWED_HOSTS: "", LASO_TOKEN: "e2e-server-only-secret" },
        logPath: path.join(logs, `laso-web-${index + 1}.log`),
      });
      webProcesses.push(webProcess);
      const url = `http://127.0.0.1:${port}`; webURLs.push(url);
      await waitFor(`${url}/api/laso/health`, true, [lasoProcess, ...webProcesses]);
    }
    return {
      root, logs, apiURL, webURLs, password: PASSWORD,
      async stopLaso() { await stop(lasoProcess); },
      async restartLaso() { await stop(lasoProcess); await startLaso(); },
      async stop() { await Promise.all([stop(lasoProcess), ...webProcesses.map(stop)]); fs.rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await Promise.all([stop(lasoProcess), ...webProcesses.map(stop)]);
    const retainedLogs = path.join(WEB_ROOT, "test-results", "service-logs");
    fs.rmSync(retainedLogs, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(retainedLogs), { recursive: true });
    fs.cpSync(logs, retainedLogs, { recursive: true });
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`${error.message}\nIsolated service logs: ${retainedLogs}`);
  }
}

module.exports = { startStack, PASSWORD };
