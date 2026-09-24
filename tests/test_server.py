import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


class FakeLasoHandler(BaseHTTPRequestHandler):
    mode = "normal"
    requests = []

    def do_GET(self):  # noqa: N802
        self.__class__.requests.append((self.command, self.path, self.headers.get("Authorization")))
        if self.mode == "redirect":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/should-not-follow")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.mode == "slow":
            time.sleep(0.2)
        if self.mode == "malformed":
            body = b"{not-json"
        else:
            body = json.dumps({"status": "ok", "echo": self.path, "untrusted": "<script>bad()</script>"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_POST(self):  # noqa: N802
        self.__class__.requests.append((self.command, self.path, self.headers.get("Authorization")))
        size = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(size)
        result = {"id": "run-1", "received": json.loads(body)}
        encoded = json.dumps(result).encode()
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        pass


class WebTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeLasoHandler)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        cls.upstream_url = f"http://127.0.0.1:{cls.upstream.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.upstream.server_close()
        cls.upstream_thread.join(timeout=2)

    def setUp(self):
        FakeLasoHandler.mode = "normal"
        FakeLasoHandler.requests.clear()

    def config(self, **kwargs):
        values = {"laso_url": self.upstream_url, "bind": "127.0.0.1", "port": 0, "token": "", "password": ""}
        values.update(kwargs)
        return server.Config(**values)

    def test_config_defaults_and_validates_url_bind_and_credentials(self):
        with patch.dict(os.environ, {}, clear=True):
            config = server.Config.from_env()
        self.assertEqual(config.laso_url, "http://127.0.0.1:8080")
        self.assertEqual((config.bind, config.port), ("127.0.0.1", 8081))
        for url in ("file://example.invalid/resource", "http://user:secret@example.invalid", "http://host/?q=x", "http://host/#fragment"):
            with self.subTest(url=url), patch.dict(os.environ, {"LASO_URL": url}, clear=True):
                with self.assertRaises(ValueError):
                    server.Config.from_env()
        with patch.dict(os.environ, {"LASO_WEB_BIND": "0.0.0.0"}, clear=True):
            with self.assertRaisesRegex(ValueError, "PASSWORD is required"):
                server.Config.from_env()
        with patch.dict(os.environ, {"LASO_WEB_BIND": "0.0.0.0", "LASO_WEB_PASSWORD": "too-short"}, clear=True):
            with self.assertRaisesRegex(ValueError, "between 16 and 1024"):
                server.Config.from_env()
        with patch.dict(os.environ, {"LASO_WEB_BIND": "0.0.0.0", "LASO_WEB_PASSWORD": "a-long-example-password"}, clear=True):
            with self.assertRaisesRegex(ValueError, "ALLOWED_HOSTS is required"):
                server.Config.from_env()
        with patch.dict(os.environ, {"LASO_WEB_BIND": "0.0.0.0", "LASO_WEB_PASSWORD": "a-long-example-password",
                                     "LASO_WEB_ALLOWED_HOSTS": "laso.example.invalid"}, clear=True):
            config = server.Config.from_env()
            self.assertEqual(config.allowed_hosts, ("laso.example.invalid",))

    def test_env_file_is_data_not_shell_code(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / ".env"
            file.write_text("LASO_WEB_PORT=8123\n# comment\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                server.load_env_file(file)
                self.assertEqual(os.environ["LASO_WEB_PORT"], "8123")
            file.write_text("LASO_WEB_PORT=$(touch SHOULD_NOT_EXIST)\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                server.load_env_file(file)
                self.assertEqual(os.environ["LASO_WEB_PORT"], "$(touch SHOULD_NOT_EXIST)")

    def test_route_allowlist_blocks_arbitrary_proxying_and_invalid_queries(self):
        self.assertEqual(server.validate_upstream_path("GET", "/api/v1/health"), "/api/v1/health")
        self.assertEqual(server.validate_upstream_path("POST", "/api/v1/pipelines/hello@1/runs"), "/api/v1/pipelines/hello@1/runs")
        for method, path in (("GET", "http://example.invalid/"), ("GET", "/api/v1/artifacts/x"),
                             ("POST", "/api/v1/workers/worker/start"), ("GET", "/api/v1/runs?next=http://example.invalid"),
                             ("POST", "/api/v1/approvals/a/approve?limit=1&offset=0")):
            with self.subTest(path=path), self.assertRaises(server.WebError):
                server.validate_upstream_path(method, path)

    def test_proxy_forwards_only_configured_server_credential_and_json(self):
        status, result = server.call_laso(self.config(token="server-side-token"), "POST",
                                          "/api/v1/pipelines/hello@1/runs", {"input": {"x": 3}})
        self.assertEqual(status, 202)
        self.assertEqual(result["received"], {"input": {"x": 3}})
        method, path, credential = FakeLasoHandler.requests[-1]
        self.assertEqual((method, path), ("POST", "/api/v1/pipelines/hello@1/runs"))
        self.assertEqual(credential, "Bearer server-side-token")

    def test_malformed_upstream_json_is_a_gateway_error(self):
        FakeLasoHandler.mode = "malformed"
        with self.assertRaisesRegex(server.WebError, "malformed JSON") as raised:
            server.call_laso(self.config(), "GET", "/api/v1/health")
        self.assertEqual(raised.exception.status, 502)

    def test_unreachable_laso_is_a_bounded_gateway_error(self):
        with self.assertRaisesRegex(server.WebError, "Cannot contact LASO") as raised:
            server.call_laso(self.config(laso_url="http://127.0.0.1:1"), "GET", "/api/v1/health")
        self.assertEqual(raised.exception.status, 502)

    def test_upstream_redirect_is_not_followed(self):
        FakeLasoHandler.mode = "redirect"
        with self.assertRaises(server.WebError):
            server.call_laso(self.config(token="do-not-forward"), "GET", "/api/v1/health")
        self.assertEqual(len(FakeLasoHandler.requests), 1)

    def test_upstream_timeout_is_bounded_and_reported(self):
        FakeLasoHandler.mode = "slow"
        started = time.monotonic()
        with patch.object(server, "REQUEST_TIMEOUT", 0.03), self.assertRaises(server.WebError) as raised:
            server.call_laso(self.config(), "GET", "/api/v1/health")
        self.assertEqual(raised.exception.status, 502)
        self.assertLess(time.monotonic() - started, 0.15)

    def test_client_disconnect_while_sending_response_is_quietly_handled(self):
        class DisconnectedClient:
            def write(self, _body):
                raise BrokenPipeError("client closed")

        handler = object.__new__(server.Handler)
        handler.wfile = DisconnectedClient()
        handler.send_response = lambda *_args: None
        handler.send_header = lambda *_args: None
        handler.end_headers = lambda: None
        handler._send(200, b"response", "text/plain")

    def test_http_ui_proxy_origin_and_body_validation(self):
        app = server.WebServer(self.config(password="sixteen-character-password"))
        thread = threading.Thread(target=app.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", app.server_port, timeout=2)
        auth = "Basic " + server.base64.b64encode(b"operator:sixteen-character-password").decode()
        try:
            connection.request("GET", "/", headers={"Authorization": auth})
            response = connection.getresponse()
            page = response.read().decode()
            self.assertEqual(response.status, 200)
            self.assertIn("LASO-Web", page)
            self.assertIn('id="content"', page)
            self.assertIn('data-view="history"', page)
            self.assertIn('src="/model.js"', page)
            self.assertIn("default-src 'self'", response.getheader("Content-Security-Policy"))

            connection.request("GET", "/model.js", headers={"Authorization": auth})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertIn("promptOf", response.read().decode())

            connection.request("GET", "/", headers={"Authorization": auth, "Host": "attacker.invalid"})
            response = connection.getresponse()
            self.assertEqual(response.status, 421)
            response.read()

            connection.request("GET", "/", headers={})
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            self.assertTrue(response.getheader("WWW-Authenticate").startswith("Basic"))
            response.read()

            connection.request("GET", "/api/laso/health", headers={"Authorization": auth})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())["status"], "ok")

            body = json.dumps({"input": {"value": 9}})
            connection.request("POST", "/api/laso/pipelines/example/runs", body,
                               {"Authorization": auth, "Content-Type": "application/json",
                                "Origin": f"http://127.0.0.1:{app.server_port}"})
            response = connection.getresponse()
            self.assertEqual(response.status, 202)
            self.assertEqual(json.loads(response.read())["received"], {"input": {"value": 9}})

            connection.request("POST", "/api/laso/approvals/approval-1/approve", "{\"comment\":\"checked\"}",
                               {"Authorization": auth, "Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 202)
            response.read()

            connection.request("POST", "/api/laso/worker-requests/request-1/answer", "{\"payload\":{\"answer\":\"yes\"}}",
                               {"Authorization": auth, "Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 202)
            response.read()

            connection.request("POST", "/api/laso/pipelines/example/runs", body,
                               {"Authorization": auth, "Content-Type": "application/json", "Origin": "http://evil.invalid"})
            response = connection.getresponse()
            self.assertEqual(response.status, 403)
            response.read()

            connection.request("POST", "/api/laso/workers/anything", body,
                               {"Authorization": auth, "Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()

            connection.request("POST", "/api/laso/pipelines/example/runs", "{}",
                               {"Authorization": auth, "Content-Type": "text/plain"})
            response = connection.getresponse()
            self.assertEqual(response.status, 415)
            response.read()

            with socket.create_connection(("127.0.0.1", app.server_port), timeout=2) as raw:
                raw.sendall((f"POST /api/laso/pipelines/example/runs HTTP/1.0\r\n"
                             f"Host: 127.0.0.1:{app.server_port}\r\nAuthorization: {auth}\r\nContent-Type: application/json\r\n"
                             f"Content-Length: {server.MAX_BODY + 1}\r\n\r\n").encode())
                self.assertIn(b"413 Request Entity Too Large", raw.recv(512))

            connection.request("POST", "/api/laso/pipelines/example/runs", "{bad",
                               {"Authorization": auth, "Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()

            connection.putrequest("POST", "/api/laso/pipelines/example/runs")
            connection.putheader("Authorization", auth)
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Transfer-Encoding", "chunked")
            connection.endheaders()
            connection.send(b"2\r\n{}\r\n0\r\n\r\n")
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read()

            connection.request("GET", "/server.py", headers={"Authorization": auth})
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
        finally:
            connection.close()
            app.shutdown()
            app.server_close()
            thread.join(timeout=2)

    def test_browser_rendering_uses_text_nodes_not_html_interpolation(self):
        javascript = (Path(__file__).resolve().parents[1] / "static" / "app.js").read_text()
        self.assertIn("node.textContent = content", javascript)
        self.assertNotIn("innerHTML", javascript)
        self.assertIn("textContent = message", javascript)


if __name__ == "__main__":
    unittest.main()
