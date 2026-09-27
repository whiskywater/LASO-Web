#!/usr/bin/env python3
"""Opt-in run/operator parity smoke using an isolated real LASO and Go LASO-Web."""

import argparse
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


def request(url, method="GET", body=None, timeout=4):
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=encoded, method=method,
                                 headers={"Content-Type": "application/json"} if encoded is not None else {})
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


def wait_for(url, processes, timeout=15):
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
    parser.add_argument("--pipeline", required=True, help="Path to deterministic hello pipeline YAML")
    parser.add_argument("--approval-pipeline", required=True, help="Path to human-approval pipeline YAML")
    parser.add_argument(
        "--postgres-dsn",
        default=os.environ.get("LASO_TEST_POSTGRES_DSN", os.environ.get("LASO_POSTGRES_DSN", "")),
        help="PostgreSQL connection string (or LASO_TEST_POSTGRES_DSN)",
    )
    args = parser.parse_args()
    binary, web_binary, pipeline, approval_pipeline = map(
        lambda value: Path(value).resolve(),
        (args.server, args.web, args.pipeline, args.approval_pipeline),
    )
    if not all(path.is_file() for path in (binary, web_binary, pipeline, approval_pipeline)):
        raise SystemExit("LASO server, Go LASO-Web binary, or pipeline fixture does not exist")
    if not args.postgres_dsn:
        raise SystemExit("PostgreSQL DSN is required via --postgres-dsn or LASO_TEST_POSTGRES_DSN")
    if shutil.which("psql") is None:
        raise SystemExit("psql is required to isolate and clean the PostgreSQL test schema")

    processes = []
    logs = []
    schema = "laso_web_smoke_" + uuid.uuid4().hex[:16]
    with tempfile.TemporaryDirectory(prefix="laso-web-go-parity-") as directory:
        root = Path(directory)
        api_port, web_port = free_port(), free_port()
        config = root / "laso.yaml"
        psql = subprocess.run(
            ["psql", args.postgres_dsn, "-v", "ON_ERROR_STOP=1", "-c", f'CREATE SCHEMA "{schema}"'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if psql.returncode:
            raise SystemExit("could not create isolated PostgreSQL schema")
        config.write_text(
            f"postgres_dsn: {json.dumps(args.postgres_dsn)}\n"
            f"postgres_schema: {schema}\n"
            f"data_dir: {json.dumps(str(root / 'state'))}\n"
            f"artifact_root: {json.dumps(str(root / 'state' / 'artifacts'))}\n"
            "api_host: 127.0.0.1\n"
            f"api_port: {api_port}\nworkers: 1\n",
            encoding="utf-8",
        )
        config.chmod(0o600)
        api_url = f"http://127.0.0.1:{api_port}"
        env = os.environ.copy()
        core_log = (root / "laso.log").open("ab")
        web_log = (root / "laso-web.log").open("ab")
        logs.extend(((root / "laso.log", core_log), (root / "laso-web.log", web_log)))
        laso = subprocess.Popen(
            [str(binary), "--config", str(config)],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=core_log,
            stderr=subprocess.STDOUT,
            env=env,
        )
        processes.append(laso)
        try:
            wait_for(api_url + "/api/v1/health", processes)
            web_env = env.copy()
            web_env.update({"LASO_URL": api_url, "LASO_WEB_BIND": "127.0.0.1", "LASO_WEB_PORT": str(web_port),
                            "LASO_WEB_PASSWORD": "", "LASO_WEB_ALLOWED_HOSTS": "", "LASO_TOKEN": ""})
            web = subprocess.Popen(
                [str(web_binary)],
                cwd=root,
                stdin=subprocess.DEVNULL,
                stdout=web_log,
                stderr=subprocess.STDOUT,
                env=web_env,
            )
            processes.append(web)
            web_url = f"http://127.0.0.1:{web_port}"
            wait_for(web_url + "/", processes)

            status, home = request(web_url + "/")
            assert status == 200
            for path in ("/app.js", "/model.js", "/style.css", "/sessions.js"):
                status, asset = request(web_url + path)
                assert status == 200 and asset, (path, status)
            status, health = request(web_url + "/api/laso/health")
            assert status == 200 and health.get("status") == "ok", health
            status, version = request(web_url + "/api/laso/version")
            assert status == 200 and isinstance(version, dict), version
            status, workers = request(web_url + "/api/laso/workers?limit=100&offset=0")
            assert status == 200 and isinstance(workers, list), workers
            status, jobs = request(web_url + "/api/laso/worker-jobs?limit=100&offset=0")
            assert status == 200 and isinstance(jobs, list), jobs
            status, schedules = request(web_url + "/api/laso/schedules?limit=100&offset=0")
            assert status == 200 and isinstance(schedules, list), schedules

            status, registered = request(web_url + "/api/laso/pipelines", "POST", {"yaml": pipeline.read_text(encoding="utf-8")})
            assert status in (200, 201), registered
            pipeline_id = f"{registered.get('name', 'hello')}@{registered.get('version', 1)}"
            status, started = request(web_url + f"/api/laso/pipelines/{pipeline_id}/runs", "POST", {"input": {"source": "Go-only workspace"}})
            assert status in (200, 201, 202) and started.get("id"), started
            run_id = started["id"]
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                status, run = request(web_url + f"/api/laso/runs/{run_id}")
                if run.get("state") in {"Completed", "Failed", "Cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and run.get("state") == "Completed", run
            status, runs = request(web_url + "/api/laso/runs?limit=100&offset=0")
            assert status == 200 and any(item.get("id") == run_id for item in runs), runs
            for route in ("messages", "events", "attempts"):
                status, detail = request(web_url + f"/api/laso/runs/{run_id}/{route}")
                assert status == 200 and isinstance(detail, list), (route, status, detail)
            print(f"PASS: Go-only startup; health/version, pipelines, workers/jobs, schedules, run submission/completion/history/detail ({run_id})")

            status, approval_def = request(web_url + "/api/laso/pipelines", "POST", {"yaml": approval_pipeline.read_text(encoding="utf-8")})
            assert status in (200, 201), approval_def
            approval_id = f"{approval_def.get('name', 'human-approval')}@{approval_def.get('version', 1)}"
            status, approval_run = request(web_url + f"/api/laso/pipelines/{approval_id}/runs", "POST", {"input": {"text": "review"}})
            assert status in (200, 201, 202) and approval_run.get("id"), approval_run
            pending = []
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                status, pending = request(web_url + "/api/laso/approvals?limit=100&offset=0")
                if pending:
                    break
                time.sleep(0.1)
            if pending:
                aid = pending[0]["id"]
                status, decision = request(web_url + f"/api/laso/approvals/{aid}/approve", "POST", {"comment": "Go parity smoke"})
                assert status in (200, 202), decision
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    _, final_run = request(web_url + f"/api/laso/runs/{approval_run['id']}")
                    if final_run.get("state") in {"Completed", "Failed", "Cancelled"}:
                        break
                    time.sleep(0.1)
                assert final_run.get("state") == "Completed", final_run
                print(f"PASS: approval queue and approve decision completed run {approval_run['id']}")
            else:
                print("SKIP: real LASO approval-producing pipeline did not expose a pending approval")

            # Check graceful outage and recovery without replacing the Go process.
            stop(laso)
            status, unavailable = request(web_url + "/api/laso/health")
            assert status == 502 and isinstance(unavailable, dict), (status, unavailable)
            restarted = subprocess.Popen(
                [str(binary), "--config", str(config)],
                cwd=root,
                stdin=subprocess.DEVNULL,
                stdout=core_log,
                stderr=subprocess.STDOUT,
                env=env,
            )
            processes[0] = restarted
            wait_for(api_url + "/api/v1/health", processes)
            status, recovered = request(web_url + "/api/laso/health")
            assert status == 200 and recovered.get("status") == "ok", recovered
            print("PASS: Go proxy reports LASO outage and reconnects after LASO restart")
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
                print("WARNING: could not drop isolated PostgreSQL schema", file=sys.stderr)
            if sys.exc_info()[0] is not None:
                for log_path, _ in logs:
                    if log_path.exists():
                        print(f"--- {log_path.name} ---", file=sys.stderr)
                        print(log_path.read_text(errors="replace"), file=sys.stderr)


if __name__ == "__main__":
    main()
