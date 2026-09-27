#!/usr/bin/env python3
"""Two independent Go LASO-Web processes sharing one isolated real LASO session."""

import argparse
import http.client
import json
import os
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(url, method="GET", body=None, timeout=5):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data is not None else {})
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
    if process is None:
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
    args = parser.parse_args()
    binary, web_binary, pipeline = map(lambda value: Path(value).resolve(), (args.server, args.web, args.pipeline))
    if not all(path.is_file() for path in (binary, web_binary, pipeline)):
        raise SystemExit("LASO server, Go LASO-Web binary, or pipeline fixture does not exist")

    processes = []
    with tempfile.TemporaryDirectory(prefix="laso-web-session-integration-") as directory:
        root = Path(directory)
        api_port, port_a, port_b = free_port(), free_port(), free_port()
        config = root / "laso.yaml"
        config.write_text(
            f"data_dir: {json.dumps(str(root / 'state'))}\n"
            f"artifact_root: {json.dumps(str(root / 'state' / 'artifacts'))}\n"
            "storage_backend: sqlite\napi_host: 127.0.0.1\n"
            f"api_port: {api_port}\nworkers: 1\n", encoding="utf-8")
        api_url = f"http://127.0.0.1:{api_port}"
        env = os.environ.copy()
        laso = subprocess.Popen([str(binary), "--config", str(config), "--host", "127.0.0.1", "--port", str(api_port)],
                                cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, env=env)
        processes.append(laso)
        try:
            wait_for(api_url + "/api/v1/health", processes)
            web_urls = []
            for port in (port_a, port_b):
                web_env = env.copy()
                web_env.update({"LASO_URL": api_url, "LASO_WEB_BIND": "127.0.0.1", "LASO_WEB_PORT": str(port),
                                "LASO_WEB_PASSWORD": "", "LASO_WEB_ALLOWED_HOSTS": "", "LASO_TOKEN": ""})
                process = subprocess.Popen([str(web_binary)], cwd=root, stdin=subprocess.DEVNULL,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=web_env)
                processes.append(process)
                url = f"http://127.0.0.1:{port}"
                wait_for(url + "/", processes)
                web_urls.append(url)
            a, b = web_urls

            status, registered = request(a + "/api/laso/pipelines", "POST", {"yaml": pipeline.read_text(encoding="utf-8")})
            assert status in (200, 201), registered
            pipeline_id = f"{registered.get('name', 'hello')}@{registered.get('version', 1)}"
            status, standalone = request(a + f"/api/laso/pipelines/{pipeline_id}/runs", "POST", {"input": {"source": "standalone workspace"}})
            assert status in (200, 201, 202) and standalone.get("id"), standalone
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                status, standalone_run = request(b + f"/api/laso/runs/{standalone['id']}")
                if standalone_run.get("state") in {"Completed", "Failed", "Cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and standalone_run.get("state") == "Completed", standalone_run
            status, runs = request(b + "/api/laso/runs?limit=100&offset=0")
            assert status == 200 and any(run.get("id") == standalone["id"] for run in runs), runs
            status, session = request(a + "/api/laso/sessions", "POST", {"pipeline_id": pipeline_id})
            assert status == 201 and session.get("id"), session
            sid = session["id"]
            status, from_b = request(b + f"/api/laso/sessions/{sid}")
            assert status == 200 and from_b.get("id") == sid, from_b
            page_status, page = request(b + f"/sessions/{sid}")
            assert page_status == 200 and "session.js" in page, page

            first_body = {"idempotency_key": "client-a-turn-1", "input": {"prompt": "first from A"}}
            status, first = request(a + f"/api/laso/sessions/{sid}/turns", "POST", first_body)
            assert status == 202 and first.get("sequence") == 1, first
            retry_status, retry = request(b + f"/api/laso/sessions/{sid}/turns", "POST", first_body)
            assert retry_status == 202 and retry.get("id") == first.get("id"), retry

            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                status, history = request(b + f"/api/laso/sessions/{sid}/turns?limit=100&offset=0")
                if history and history[0].get("state") in {"succeeded", "failed", "cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and len(history) == 1 and history[0].get("state") == "succeeded", history
            run_id = history[0].get("run_id")
            assert run_id, history
            status, run = request(b + f"/api/laso/runs/{run_id}")
            assert status == 200 and run.get("state") == "Completed", run

            # B sees A's events, then disconnects. A creates another turn while B is away.
            event_id, event = read_one_sse_event(b + f"/api/laso/sessions/{sid}/events/stream", 0)
            assert event_id >= 1 and event.get("type"), event
            status, journal = request(a + f"/api/laso/sessions/{sid}/events?after=0&limit=100")
            assert status == 200 and journal, journal
            disconnect_cursor = journal[-1]["sequence"]
            second_body = {"idempotency_key": "client-a-turn-2", "input": {"prompt": "while B disconnected"}}
            status, second = request(a + f"/api/laso/sessions/{sid}/turns", "POST", second_body)
            assert status == 202 and second.get("sequence") == 2, second
            replay_id, replay_event = read_one_sse_event(b + f"/api/laso/sessions/{sid}/events/stream", disconnect_cursor)
            assert replay_id > disconnect_cursor and replay_event.get("turn_id") == second.get("id"), replay_event
            status, from_a = request(a + f"/api/laso/sessions/{sid}/turns?limit=100&offset=0")
            assert status == 200 and [turn.get("sequence") for turn in from_a] == [1, 2], from_a

            # Wait for durable completion, stop LASO, verify the adapter fails
            # boundedly, then restart LASO against the same SQLite directory.
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                status, from_a = request(a + f"/api/laso/sessions/{sid}/turns?limit=100&offset=0")
                if from_a[-1].get("state") in {"succeeded", "failed", "cancelled"}:
                    break
                time.sleep(0.1)
            assert status == 200 and from_a[-1].get("state") == "succeeded", from_a
            stop(laso)
            status, outage = request(b + f"/api/laso/sessions/{sid}")
            assert status == 502 and isinstance(outage, dict), (status, outage)

            laso = subprocess.Popen([str(binary), "--config", str(config), "--host", "127.0.0.1", "--port", str(api_port)],
                                    cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, env=env)
            processes[0] = laso
            wait_for(api_url + "/api/v1/health", processes)
            status, replay_after_restart = read_one_sse_event(b + f"/api/laso/sessions/{sid}/events/stream", disconnect_cursor)
            assert status > disconnect_cursor and replay_after_restart.get("turn_id") == second.get("id"), replay_after_restart
            status, recovered = request(b + f"/api/laso/sessions/{sid}/turns?limit=100&offset=0")
            assert status == 200 and [turn.get("sequence") for turn in recovered] == [1, 2], recovered
            print(f"PASS: two Go clients share LASO session {sid}; idempotency, linkage, ordered history, deep link, SSE reconnect/replay cursor {disconnect_cursor}->{replay_id}, outage recovery, LASO restart replay")
        finally:
            for process in reversed(processes):
                stop(process)


if __name__ == "__main__":
    main()
