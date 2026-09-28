"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

const PASSWORD = "browser-e2e-password-2026";
const WEB_ROOT = path.resolve(__dirname, "../..");
const LASO_ROOT = path.resolve(process.env.LASO_SOURCE_DIR || path.resolve(WEB_ROOT, "../LASO"));
const LASO_SERVER = path.resolve(process.env.LASO_E2E_LASO_SERVER || path.join(LASO_ROOT, "build-browser-e2e/bin/laso-server"));
const WEB_BINARY = path.resolve(process.env.LASO_E2E_WEB || path.join(WEB_ROOT, "build/laso-web"));
const POSTGRES_DSN = process.env.LASO_E2E_POSTGRES_DSN || "";
const POSTGRES_SCHEMA = process.env.LASO_E2E_POSTGRES_SCHEMA || "laso_web_e2e";
const CONTEXT_REDUCTION = process.env.LASO_E2E_CONTEXT_REDUCTION === "1";
const LASO_COUNT = Number(process.env.LASO_E2E_LASO_COUNT || (POSTGRES_DSN ? 2 : 1));
const POSTGRES_CTL = process.env.LASO_E2E_POSTGRES_CTL || "";
const POSTGRES_DATA = process.env.LASO_E2E_POSTGRES_DATA || "";
const POSTGRES_PORT = Number(process.env.LASO_E2E_POSTGRES_PORT || 0);
const POSTGRES_SOCKET = process.env.LASO_E2E_POSTGRES_SOCKET || "";

if (!Number.isInteger(LASO_COUNT) || LASO_COUNT < 1 || LASO_COUNT > 2) throw new Error("LASO_E2E_LASO_COUNT must be 1 or 2");
if (POSTGRES_DSN && !/^[a-z][a-z0-9_]{0,62}$/.test(POSTGRES_SCHEMA)) throw new Error("LASO_E2E_POSTGRES_SCHEMA must be a lowercase PostgreSQL identifier");
if (POSTGRES_CTL || POSTGRES_DATA || POSTGRES_SOCKET || POSTGRES_PORT) {
  const workspace = path.resolve(WEB_ROOT, "..");
  const data = path.resolve(POSTGRES_DATA);
  const relative = path.relative(workspace, data);
  if (!POSTGRES_CTL || !POSTGRES_DATA || !POSTGRES_SOCKET || !Number.isInteger(POSTGRES_PORT) || POSTGRES_PORT < 1024 || POSTGRES_PORT > 65535 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("PostgreSQL restart controls must identify a task-local cluster inside the workspace");
  }
}

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
  const ports = await Promise.all(Array.from({ length: LASO_COUNT + 2 }, freePort));
  const artifactRoot = path.join(root, "shared-artifacts");
  fs.mkdirSync(artifactRoot);
  const lasoConfigs = Array.from({ length: LASO_COUNT }, (_, index) => {
    const config = path.join(root, `laso-${index + 1}.yaml`);
    let yaml = `data_dir: ${JSON.stringify(path.join(root, `state-${index + 1}`))}\n` +
      `artifact_root: ${JSON.stringify(artifactRoot)}\n` +
      "api_host: 127.0.0.1\n" +
      `api_port: ${ports[index]}\nworkers: 2\n`;
    if (POSTGRES_DSN) yaml += `postgres_dsn: ${JSON.stringify(POSTGRES_DSN)}\npostgres_schema: ${POSTGRES_SCHEMA}\nexecution_mode: multi_instance\n`;
    else yaml += "storage_backend: sqlite\n";
    if (CONTEXT_REDUCTION) yaml += "session_context_reduction:\n  enabled: true\n  reducer: recent-turns\n  threshold_bytes: 1800\n  target_bytes: 1600\n  max_input_bytes: 16384\n  timeout_ms: 30000\n";
    fs.writeFileSync(config, yaml, { mode: 0o600 });
    return config;
  });
  const apiURLs = ports.slice(0, LASO_COUNT).map(port => `http://127.0.0.1:${port}`);
  const webURLs = ports.slice(LASO_COUNT).map(port => `http://127.0.0.1:${port}`);
  const lasoProcesses = [];
  let postgresRunning = true;
  const stopPostgres = async () => {
    if (!POSTGRES_CTL || !postgresRunning) return;
    await execFileAsync(POSTGRES_CTL, ["-D", POSTGRES_DATA, "-m", "fast", "-w", "stop"], { timeout: 15000, maxBuffer: 1024 * 1024 });
    postgresRunning = false;
  };
  const startPostgres = async () => {
    if (!POSTGRES_CTL || postgresRunning) return;
    await execFileAsync(POSTGRES_CTL, ["-D", POSTGRES_DATA, "-l", path.join(path.dirname(POSTGRES_DATA), "server.log"), "-o", `-h 127.0.0.1 -p ${POSTGRES_PORT} -k ${POSTGRES_SOCKET} -c listen_addresses=127.0.0.1`, "-w", "start"], { timeout: 15000, maxBuffer: 1024 * 1024 });
    postgresRunning = true;
  };
  const startLaso = async index => {
    const port = ports[index];
    const serverProcess = start(LASO_SERVER, ["--config", lasoConfigs[index], "--host", "127.0.0.1", "--port", String(port)], {
      cwd: root, env: { ...process.env }, logPath: path.join(logs, `laso-${index + 1}.log`),
    });
    lasoProcesses[index] = serverProcess;
    const activeLaso = lasoProcesses.filter(process => process && process.exitCode === null);
    await waitFor(`${apiURLs[index]}/api/v1/health`, null, activeLaso);
  };
  const registerFixtures = async () => {
    for (const name of ["hello-pipeline", "human-approval"]) {
      const yaml = fs.readFileSync(path.join(LASO_ROOT, "examples", name, "pipeline.yaml"), "utf8");
      const response = await fetch(`${apiURLs[0]}/api/v1/pipelines`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ yaml }) });
      if (!response.ok) throw new Error(`register ${name} fixture in LASO: HTTP ${response.status}: ${await response.text()}`);
    }
  };
  const webProcesses = [];
  try {
    for (let index = 0; index < LASO_COUNT; index++) await startLaso(index);
    await registerFixtures();
    for (let index = 0; index < 2; index++) {
      const port = ports[LASO_COUNT + index];
      const lasoURL = apiURLs[Math.min(index, apiURLs.length - 1)];
      const webEnv = { ...process.env };
      for (const key of Object.keys(webEnv)) if (key.startsWith("LASO_E2E_")) delete webEnv[key];
      const webProcess = start(WEB_BINARY, [], {
        cwd: root,
        env: { ...webEnv, LASO_URL: lasoURL, LASO_WEB_BIND: "127.0.0.1", LASO_WEB_PORT: String(port),
          LASO_WEB_PASSWORD: PASSWORD, LASO_WEB_ALLOWED_HOSTS: "", LASO_TOKEN: "e2e-server-only-secret" },
        logPath: path.join(logs, `laso-web-${index + 1}.log`),
      });
      webProcesses.push(webProcess);
      await waitFor(`${webURLs[index]}/api/laso/health`, true, [...lasoProcesses, ...webProcesses]);
    }
    return {
      root, logs, apiURL: apiURLs[0], apiURLs, webURLs, password: PASSWORD,
      storage: POSTGRES_DSN ? "postgres" : "sqlite", contextReduction: CONTEXT_REDUCTION,
      postgresSchema: POSTGRES_DSN ? POSTGRES_SCHEMA : "",
      async stopLaso() { await Promise.all(lasoProcesses.map(stop)); lasoProcesses.fill(null); },
      async restartLaso() { await Promise.all(lasoProcesses.map(stop)); lasoProcesses.fill(null); for (let index = 0; index < LASO_COUNT; index++) await startLaso(index); },
      canRestartPostgres: Boolean(POSTGRES_CTL),
      stopPostgres, startPostgres,
      async restartPostgres() { if (!POSTGRES_CTL) throw new Error("No task-local PostgreSQL control path was configured"); await stopPostgres(); await startPostgres(); },
      async stop() { await startPostgres(); await Promise.all([...lasoProcesses.map(stop), ...webProcesses.map(stop)]); fs.rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await Promise.all([...lasoProcesses.map(stop), ...webProcesses.map(stop)]);
    const retainedLogs = path.join(WEB_ROOT, "test-results", "service-logs");
    fs.rmSync(retainedLogs, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(retainedLogs), { recursive: true });
    fs.cpSync(logs, retainedLogs, { recursive: true });
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`${error.message}\nIsolated service logs: ${retainedLogs}`);
  }
}

module.exports = { startStack, PASSWORD };
