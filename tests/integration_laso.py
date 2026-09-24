#!/usr/bin/env python3
"""Opt-in end-to-end smoke against a real LASO server with isolated SQLite state."""

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(url, method="GET", body=None):
    encoded = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=encoded, method=method,
                                 headers={"Content-Type": "application/json"} if encoded else {})
    with urllib.request.urlopen(req, timeout=3) as response:
        return response.status, json.loads(response.read())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True, help="Path to laso-server binary")
    parser.add_argument("--pipeline", required=True, help="Path to a public, deterministic pipeline YAML fixture")
    args = parser.parse_args()
    binary, pipeline = Path(args.server).resolve(), Path(args.pipeline).resolve()
    if not binary.is_file() or not pipeline.is_file():
        raise SystemExit("LASO server binary or pipeline fixture does not exist")
    with tempfile.TemporaryDirectory(prefix="laso-web-integration-") as directory:
        root = Path(directory)
        api_port, web_port = free_port(), free_port()
        config = root / "laso.yaml"
        config.write_text(
            f"data_dir: {json.dumps(str(root / 'state'))}\n"
            f"artifact_root: {json.dumps(str(root / 'state' / 'artifacts'))}\n"
            "storage_backend: sqlite\n"
            "api_host: 127.0.0.1\n"
            f"api_port: {api_port}\n"
            "workers: 1\n", encoding="utf-8")
        process = subprocess.Popen([str(binary), "--config", str(config), "--host", "127.0.0.1", "--port", str(api_port)],
                                   cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
        web = None
        thread = None
        try:
            api_url = f"http://127.0.0.1:{api_port}"
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise RuntimeError("LASO server exited before becoming healthy")
                try:
                    request(api_url + "/api/v1/health")
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
            else:
                raise RuntimeError("LASO server health did not become ready")
            config_obj = server.Config(api_url, "127.0.0.1", web_port)
            web = server.WebServer(config_obj)
            thread = threading.Thread(target=web.serve_forever, daemon=True)
            thread.start()
            web_url = f"http://127.0.0.1:{web.server_port}/api/laso"
            status, health = request(web_url + "/health")
            assert status == 200 and health.get("status") == "ok", health
            status, registered = request(web_url + "/pipelines", "POST", {"yaml": pipeline.read_text(encoding="utf-8")})
            assert status in (200, 201) and isinstance(registered, dict), registered
            pipeline_name = registered.get("name", "hello")
            pipeline_version = registered.get("version", 1)
            status, started = request(web_url + f"/pipelines/{pipeline_name}@{pipeline_version}/runs", "POST", {"input": {}})
            assert status in (200, 202) and started.get("id"), started
            run_id = started["id"]
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                _, run = request(web_url + f"/runs/{run_id}")
                if run.get("state") in {"Completed", "Failed", "Cancelled"}:
                    break
                time.sleep(0.1)
            assert run.get("state") == "Completed", run
            print(f"PASS: LASO health, pipeline registration, and run {run_id} completed through LASO-Web")
        finally:
            if web:
                web.shutdown()
                web.server_close()
            if thread:
                thread.join(timeout=2)
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


if __name__ == "__main__":
    main()
