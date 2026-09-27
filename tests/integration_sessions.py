#!/usr/bin/env python3
"""Two Go frontends share durable sessions through two PostgreSQL LASO servers."""

import argparse
import http.client
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


def free_port():
    dynamic_start, dynamic_end = 32768, 60999
    try:
        dynamic_start, dynamic_end = map(
            int, Path("/proc/sys/net/ipv4/ip_local_port_range").read_text().split()
        )
    except OSError:
        pass
    ranges = []
    if dynamic_start > 20000:
        ranges.append((20000, min(dynamic_start - 1, 65000)))
    if dynamic_end < 65000:
        ranges.append((max(dynamic_end + 1, 20000), 65000))
    candidates = [port for lower, upper in ranges for port in range(lower, upper + 1)]
    random.shuffle(candidates)
    for port in candidates:
        try:
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", port))
            return port
        except OSError:
            continue
    raise RuntimeError("no non-ephemeral loopback listener port is available")


def request(url, method="GET", body=None, timeout=5):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        payload = response.read()
        try:
            value = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            value = payload.decode(errors="replace")
        return response.status, value


def wait_for(url, processes, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("LASO or LASO-Web exited before becoming ready")
        try:
            status, body = request(url, timeout=1)
            if status == 200:
                return body
        except (urllib.error.URLError, TimeoutError, OSError):
            pass
        time.sleep(0.1)
    raise RuntimeError(f"service did not become ready: {url}")


def read_one_sse_event(url, cursor):
    parsed = urllib.parse.urlparse(url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    headers = {"Accept": "text/event-stream"}
    if cursor:
        headers["Last-Event-ID"] = str(cursor)
    conn.request("GET", parsed.path, headers=headers)
    response = conn.getresponse()
    if response.status != 200 or not response.getheader("Content-Type", "").startswith("text/event-stream"):
        body = response.read().decode(errors="replace")
        conn.close()
        raise RuntimeError(f"session stream failed: HTTP {response.status}: {body}")
    frame = []
    while True:
        line = response.readline()
        if not line:
            break
        if line in (b"\n", b"\r\n"):
            if frame:
                break
            continue
        if not line.startswith(b":"):
            frame.append(line.decode().strip())
    conn.close()
    event_id = next((line[3:].strip() for line in frame if line.startswith("id:")), "")
    data = next((line[5:].strip() for line in frame if line.startswith("data:")), "")
    if not event_id or not data:
        raise RuntimeError(f"session stream returned no event frame: {frame}")
    return int(event_id), json.loads(data)


def stop(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True, help="Path to laso-server binary")
    parser.add_argument("--web", required=True, help="Path to built LASO-Web Go binary")
    parser.add_argument("--pipeline", required=True, help="Path to deterministic Hello pipeline YAML")
    parser.add_argument("--approval-pipeline", help="Path to human-approval pipeline YAML")
    parser.add_argument(
        "--postgres-dsn",
        default=os.environ.get("LASO_TEST_POSTGRES_DSN", os.environ.get("LASO_POSTGRES_DSN", "")),
        help="PostgreSQL connection string (or LASO_TEST_POSTGRES_DSN)",
    )
    args = parser.parse_args()
    binary, web_binary, pipeline = map(
        lambda value: Path(value).resolve(), (args.server, args.web, args.pipeline)
    )
    approval_pipeline = Path(args.approval_pipeline).resolve() if args.approval_pipeline else pipeline.parent.parent / "human-approval" / "pipeline.yaml"
    if not all(path.is_file() for path in (binary, web_binary, pipeline, approval_pipeline)):
        raise SystemExit("LASO server, Go LASO-Web binary, or pipeline fixture does not exist")
    if not args.postgres_dsn:
        raise SystemExit("PostgreSQL DSN is required via --postgres-dsn or LASO_TEST_POSTGRES_DSN")
    if shutil.which("psql") is None:
        raise SystemExit("psql is required to isolate and clean the PostgreSQL test schema")

    processes = []
    logs = []
    schema = "laso_web_test_" + uuid.uuid4().hex[:16]
    with tempfile.TemporaryDirectory(prefix="laso-web-pg-session-") as directory:
        root = Path(directory)
        core_configs = []
        core_ports = []
        core_urls = []
        front_ports = []
        front_urls = []
        backend_a = None
        backend_b = None

        def launch(name, command, env=None):
            log_path = root / f"{name}.log"
            log = log_path.open("ab")
            logs.append((log_path, log))
            process = subprocess.Popen(
                command,
                cwd=root,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=env,
            )
            processes.append(process)
            return process

        def start_core(index):
            port = core_ports[index]
            config = core_configs[index]
            process = launch(
                f"laso-{index + 1}",
                [str(binary), "--config", str(config)],
                os.environ.copy(),
            )
            wait_for(core_urls[index] + "/api/v1/health", processes)
            return process

        def start_web(index):
            env = os.environ.copy()
            env.update(
                {
                    "LASO_URL": core_urls[index],
                    "LASO_WEB_BIND": "127.0.0.1",
                    "LASO_WEB_PORT": str(front_ports[index]),
                    "LASO_WEB_PASSWORD": "",
                    "LASO_WEB_ALLOWED_HOSTS": "",
                    "LASO_TOKEN": "",
                }
            )
            process = launch(f"laso-web-{index + 1}", [str(web_binary)], env)
            wait_for(front_urls[index] + "/", processes)
            return process

        try:
            psql = subprocess.run(
                ["psql", args.postgres_dsn, "-v", "ON_ERROR_STOP=1", "-c", f'CREATE SCHEMA "{schema}"'],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            if psql.returncode:
                raise RuntimeError("could not create isolated PostgreSQL schema")

            # Start backend A before choosing B's port so the two service listeners
            # never overlap with PostgreSQL's kernel-assigned client source ports.
            for index in range(2):
                core_ports.append(free_port())
                core_urls.append(f"http://127.0.0.1:{core_ports[index]}")
                config = root / f"laso-{index + 1}.yaml"
                config.write_text(
                    f"postgres_dsn: {json.dumps(args.postgres_dsn)}\n"
                    f"postgres_schema: {schema}\n"
                    f"data_dir: {json.dumps(str(root / f'state-{index + 1}'))}\n"
                    f"artifact_root: {json.dumps(str(root / f'state-{index + 1}' / 'artifacts'))}\n"
                    f"api_host: 127.0.0.1\napi_port: {core_ports[index]}\n"
                    "execution_mode: multi_instance\n"
                    "coordination:\n  mode: experimental_multi_instance\n"
                    "  lease_ttl_ms: 3000\n  heartbeat_interval_ms: 500\nworkers: 1\n",
                    encoding="utf-8",
                )
                config.chmod(0o600)
                core_configs.append(config)
                if index == 0:
                    backend_a = start_core(index)
                else:
                    backend_b = start_core(index)

            for index in range(2):
                front_ports.append(free_port())
                front_urls.append(f"http://127.0.0.1:{front_ports[index]}")
                start_web(index)
            a, b = front_urls
            api_a = a + "/api/laso"
            api_b = b + "/api/laso"

            for api in (api_a, api_b):
                status, health = request(api + "/health")
                assert status == 200 and health.get("status") == "ok", health
                status, version = request(api + "/version")
                assert status == 200 and version.get("version"), version
            for web in (a, b):
                status, page = request(web + "/")
                assert status == 200 and "LASO" in page, page
            status, deep_page = request(b + "/sessions/new")
            assert status == 200 and "session.js" in deep_page, deep_page

            for endpoint in ("workers", "worker-jobs", "approvals", "schedules"):
                status, listing = request(api_b + f"/{endpoint}?limit=100&offset=0")
                assert status == 200 and isinstance(listing, list), (endpoint, listing)

            status, registered = request(
                api_a + "/pipelines", "POST", {"yaml": pipeline.read_text(encoding="utf-8")}
            )
            assert status in (200, 201), registered
            pipeline_id = f"{registered.get('name', 'hello')}@{registered.get('version', 1)}"
            status, registration_seen_by_b = request(api_b + f"/pipelines/{pipeline_id}")
            assert status == 200, registration_seen_by_b
            status, approval_registered = request(
                api_b + "/pipelines",
                "POST",
                {"yaml": approval_pipeline.read_text(encoding="utf-8")},
            )
            assert status in (200, 201), approval_registered
            approval_pipeline_id = f"{approval_registered.get('name', 'human-approval')}@{approval_registered.get('version', 1)}"

            status, standalone = request(
                api_a + f"/pipelines/{pipeline_id}/runs",
                "POST",
                {"input": {"source": "postgres frontend integration"}},
            )
            assert status in (200, 201, 202) and standalone.get("id"), standalone
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                status, run = request(api_b + f"/runs/{standalone['id']}")
                if run.get("state") in {"Completed", "Failed", "Cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and run.get("state") == "Completed", run
            status, runs = request(api_b + "/runs?limit=100&offset=0")
            assert status == 200 and any(item.get("id") == standalone["id"] for item in runs), runs
            for action in ("events", "attempts", "messages"):
                status, records = request(api_b + f"/runs/{standalone['id']}/{action}")
                assert status == 200 and isinstance(records, list), (action, records)

            # Validate approval operation through the frontend proxy and shared DB.
            status, approval_run = request(
                api_a + f"/pipelines/{approval_pipeline_id}/runs", "POST", {"input": {}}
            )
            assert status in (200, 201, 202) and approval_run.get("id"), approval_run
            deadline = time.monotonic() + 20
            pending = []
            while time.monotonic() < deadline:
                status, approvals = request(api_b + "/approvals?limit=100&offset=0")
                pending = [item for item in approvals if item.get("decision") == "pending"]
                if pending:
                    break
                time.sleep(0.1)
            assert status == 200 and pending, approvals
            status, decided = request(
                api_b + f"/approvals/{pending[0]['id']}/approve", "POST", {"comment": "integration"}
            )
            assert status == 202 and decided.get("decision") == "approved", decided
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                status, approved_run = request(api_a + f"/runs/{approval_run['id']}")
                if approved_run.get("state") in {"Completed", "Failed", "Cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and approved_run.get("state") == "Completed", approved_run

            status, session = request(api_a + "/sessions", "POST", {"pipeline_id": pipeline_id})
            assert status == 201 and session.get("id"), session
            sid = session["id"]
            status, from_b = request(api_b + f"/sessions/{sid}")
            assert status == 200 and from_b.get("id") == sid, from_b
            status, deep_page = request(b + f"/sessions/{sid}")
            assert status == 200 and "session.js" in deep_page, deep_page

            first_body = {"idempotency_key": "client-a-turn-1", "input": {"prompt": "first from A"}}
            status, first = request(api_a + f"/sessions/{sid}/turns", "POST", first_body)
            assert status == 202 and first.get("sequence") == 1, first
            retry_status, retry = request(api_b + f"/sessions/{sid}/turns", "POST", first_body)
            assert retry_status == 202 and retry.get("id") == first.get("id"), retry

            deadline = time.monotonic() + 20
            history = []
            while time.monotonic() < deadline:
                status, history = request(api_b + f"/sessions/{sid}/turns?limit=100&offset=0")
                if history and history[0].get("state") in {"succeeded", "failed", "cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and len(history) == 1 and history[0].get("state") == "succeeded", history
            run_id = history[0].get("run_id")
            assert run_id, history
            status, session_run = request(api_b + f"/runs/{run_id}")
            assert status == 200 and session_run.get("state") == "Completed", session_run

            event_id, event = read_one_sse_event(api_b + f"/sessions/{sid}/events/stream", 0)
            assert event_id >= 1 and event.get("type"), event
            status, journal = request(api_a + f"/sessions/{sid}/events?after=0&limit=100")
            assert status == 200 and journal, journal
            disconnect_cursor = journal[-1]["sequence"]
            second_body = {"idempotency_key": "client-a-turn-2", "input": {"prompt": "while B disconnected"}}
            status, second = request(api_a + f"/sessions/{sid}/turns", "POST", second_body)
            assert status == 202 and second.get("sequence") == 2, second
            replay_id, replay_event = read_one_sse_event(
                api_b + f"/sessions/{sid}/events/stream", disconnect_cursor
            )
            assert replay_id > disconnect_cursor and replay_event.get("turn_id") == second.get("id"), replay_event
            status, from_a = request(api_a + f"/sessions/{sid}/turns?limit=100&offset=0")
            assert status == 200 and [turn.get("sequence") for turn in from_a] == [1, 2], from_a

            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                status, from_a = request(api_a + f"/sessions/{sid}/turns?limit=100&offset=0")
                if from_a[-1].get("state") in {"succeeded", "failed", "cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and from_a[-1].get("state") == "succeeded", from_a

            # Restart only backend A. Its frontend reports bounded outage, while
            # frontend B continues to read the canonical session from backend B.
            stop(backend_a)
            processes.remove(backend_a)
            status, outage = request(api_a + f"/sessions/{sid}")
            assert status == 502 and isinstance(outage, dict), (status, outage)
            status, alive = request(api_b + f"/sessions/{sid}")
            assert status == 200 and alive.get("id") == sid, alive
            backend_a = start_core(0)
            status, recovered = request(api_a + f"/sessions/{sid}/turns?limit=100&offset=0")
            assert status == 200 and [turn.get("sequence") for turn in recovered] == [1, 2], recovered
            status, replay_after_restart = read_one_sse_event(
                api_b + f"/sessions/{sid}/events/stream", disconnect_cursor
            )
            assert status > disconnect_cursor and replay_after_restart.get("turn_id") == second.get("id"), replay_after_restart
            print(
                f"PASS: two Go frontends and two PostgreSQL LASO servers share session {sid}; "
                f"run/history/operator views, idempotency, ordered turns, SSE replay, backend restart"
            )
        finally:
            for process in reversed(processes):
                stop(process)
            for _, log in logs:
                log.close()
            psql = subprocess.run(
                ["psql", args.postgres_dsn, "-v", "ON_ERROR_STOP=1", "-c", f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            if psql.returncode:
                print("WARNING: could not drop isolated PostgreSQL schema", file=os.sys.stderr)
            if sys.exc_info()[0] is not None:
                for log_path, _ in logs:
                    if log_path.exists():
                        print(f"--- {log_path.name} ---", file=os.sys.stderr)
                        print(log_path.read_text(errors="replace"), file=os.sys.stderr)


if __name__ == "__main__":
    main()
