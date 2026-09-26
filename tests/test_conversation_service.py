import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from conversation_service import ConversationService


class ContractLASOHandler(BaseHTTPRequestHandler):
    calls = []
    response_mode = "normal"

    def _send(self, status, value):
        encoded = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))

    def do_GET(self):  # noqa: N802
        self.__class__.calls.append(("GET", self.path, None))
        if self.path == "/api/v1/capabilities":
            if self.response_mode == "malformed-capabilities":
                return self._send(200, {"features": "conversations", "capabilities": []})
            return self._send(200, {
                "features": ["conversations", "conversation_membership", "conversation_context",
                             "context_compaction", "authenticated_principals", "capability_authorization"],
                "capabilities": ["conversations.create", "conversations.read_own", "conversations.rename_own",
                                 "conversations.archive_own", "runs.create", "conversations.members.read",
                                 "conversations.members.manage", "conversation_context.read", "users.change_role"],
                "policy_revision": "policy-3",
            })
        if self.path == "/api/v1/me":
            return self._send(200, {"id": "principal-1", "display_name": "Standard account"})
        if self.path == "/api/v1/conversations?limit=20&offset=0":
            return self._send(200, {"items": [{"id": "conv-1", "title": "Example", "revision": 4}], "next_cursor": None})
        if self.path == "/api/v1/conversations/conv-1":
            if self.response_mode == "malformed-conversation":
                return self._send(200, {"title": "missing id and revision"})
            return self._send(200, {"id": "conv-1", "title": "Example", "revision": 4})
        if self.path == "/api/v1/conversations/conv-1/messages?limit=20&after=0":
            messages = [
                {"id": "msg-1", "conversation_id": "conv-1", "sequence": 1, "role": "user", "created_at": "2026-01-01T00:00:00Z"},
                {"id": "msg-2", "conversation_id": "conv-1", "sequence": 2, "role": "assistant", "created_at": "2026-01-01T00:00:01Z", "run_id": "run-1"},
            ]
            if self.response_mode == "unordered-messages":
                messages.reverse()
            return self._send(200, {"items": messages, "revision": 4, "next_cursor": None})
        if self.path == "/api/v1/conversations/conv-1/messages/msg-1":
            return self._send(200, {"id": "msg-1", "conversation_id": "conv-1", "sequence": 1,
                                    "role": "user", "created_at": "2026-01-01T00:00:00Z"})
        if self.path == "/api/v1/conversations/conv-1/members":
            return self._send(200, {"items": [{"principal_id": "principal-1", "access": "owner"}]})
        if self.path == "/api/v1/conversations/conv-1/context":
            return self._send(200, {"generation": 2, "revision": 4, "context_budget": 32000,
                                    "represented_messages": 2, "compacted_at": None})
        return self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        body = self._body()
        self.__class__.calls.append(("POST", self.path, body))
        if self.path == "/api/v1/conversations":
            return self._send(201, {"id": "conv-1", "title": body.get("title", ""), "revision": 1})
        if self.path == "/api/v1/conversations/conv-1/turns":
            if self.response_mode == "conflict":
                return self._send(409, {"error": "revision conflict"})
            return self._send(202, {"conversation_id": "conv-1", "user_message_id": "msg-3",
                                    "conversation_revision": 5, "run_id": "run-2", "state": "Queued"})
        if self.path == "/api/v1/conversations/conv-1/members":
            return self._send(201, {"principal_id": body.get("principal_id"), "access": "member"})
        return self._send(404, {"error": "not found"})

    def do_PATCH(self):  # noqa: N802
        body = self._body()
        self.__class__.calls.append(("PATCH", self.path, body))
        return self._send(200, {"id": "conv-1", "title": body.get("title", "Example"),
                                "revision": body.get("expected_revision", 4) + 1})

    def do_DELETE(self):  # noqa: N802
        self.__class__.calls.append(("DELETE", self.path, None))
        return self._send(200, {"archived": True})

    def log_message(self, *_args):
        pass


class ConversationServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), ContractLASOHandler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.config = server.Config(f"http://127.0.0.1:{cls.http.server_port}", "127.0.0.1", 0)

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        ContractLASOHandler.calls.clear()
        ContractLASOHandler.response_mode = "normal"
        self.client = ConversationService(lambda method, path, body: server.call_laso(self.config, method, path, body))

    def test_feature_discovery_and_operations_use_the_laso_contract(self):
        info = self.client.discover()
        self.assertTrue(info["conversations_available"])
        self.assertEqual(info["principal"]["id"], "principal-1")
        self.assertIn("users.change_role", info["capabilities"])
        self.assertEqual(self.client.list_conversations("limit=20&offset=0")["items"][0]["id"], "conv-1")
        self.assertEqual(self.client.create_conversation({"title": "Example", "idempotency_key": "create-1"})["id"], "conv-1")
        self.assertEqual(self.client.get_conversation("conv-1")["revision"], 4)
        self.assertEqual(self.client.rename_conversation("conv-1", {"title": "Renamed", "expected_revision": 4})["revision"], 5)
        self.assertEqual(len(self.client.list_messages("conv-1", "limit=20&after=0")["items"]), 2)
        self.assertEqual(self.client.get_message("conv-1", "msg-1")["sequence"], 1)
        receipt = self.client.submit_turn("conv-1", {
            "message": {"content": "Continue"}, "expected_revision": 4, "idempotency_key": "send-1"
        })
        self.assertEqual(receipt["run_id"], "run-2")
        self.assertEqual(self.client.list_members("conv-1")["items"][0]["principal_id"], "principal-1")
        self.client.add_member("conv-1", {"principal_id": "principal-2", "access": "member"})
        self.client.remove_member("conv-1", "principal-2")
        self.assertEqual(self.client.context_status("conv-1")["generation"], 2)
        self.assertTrue(self.client.archive_conversation("conv-1")["archived"])

        calls = ContractLASOHandler.calls
        self.assertIn(("GET", "/api/v1/capabilities", None), calls)
        self.assertIn(("GET", "/api/v1/me", None), calls)
        self.assertIn(("POST", "/api/v1/conversations/conv-1/turns", {
            "message": {"content": "Continue"}, "expected_revision": 4, "idempotency_key": "send-1"
        }), calls)
        self.assertTrue(any(method == "PATCH" and path == "/api/v1/conversations/conv-1" for method, path, _ in calls))

    def test_missing_discovery_and_forged_browser_capabilities_do_not_enable_conversations(self):
        def unsupported(_method, path, _body):
            if path == "/api/v1/capabilities":
                return 404, {"error": "not found"}
            return 200, {}

        client = ConversationService(unsupported)
        self.assertFalse(client.discover()["conversations_available"])
        with self.assertRaisesRegex(server.WebError, "does not advertise") as raised:
            client.create_conversation({"title": "Fake", "capabilities": ["conversations.create"]})
        self.assertEqual(raised.exception.status, 501)

    def test_malformed_capabilities_and_messages_fail_safely(self):
        ContractLASOHandler.response_mode = "malformed-capabilities"
        with self.assertRaisesRegex(server.WebError, "invalid feature list") as raised:
            self.client.discover()
        self.assertEqual(raised.exception.status, 502)
        ContractLASOHandler.response_mode = "unordered-messages"
        with self.assertRaisesRegex(server.WebError, "out of order") as raised:
            self.client.list_messages("conv-1", "limit=20&after=0")
        self.assertEqual(raised.exception.status, 502)
        ContractLASOHandler.response_mode = "malformed-conversation"
        with self.assertRaisesRegex(server.WebError, "invalid conversation") as raised:
            self.client.get_conversation("conv-1")
        self.assertEqual(raised.exception.status, 502)

    def test_turn_revision_conflict_is_explicit_and_idempotency_is_required(self):
        ContractLASOHandler.response_mode = "conflict"
        body = {"message": {"content": "Continue"}, "expected_revision": 4, "idempotency_key": "send-1"}
        with self.assertRaisesRegex(server.WebError, "changed since this view") as raised:
            self.client.submit_turn("conv-1", body)
        self.assertEqual(raised.exception.status, 409)
        with self.assertRaisesRegex(server.WebError, "idempotency key is required") as raised:
            self.client.submit_turn("conv-1", {"message": {"content": "Continue"}, "expected_revision": 4})
        self.assertEqual(raised.exception.status, 400)

    def test_capability_policy_and_identifier_validation_are_server_owned(self):
        def standard_without_admin(method, path, body):
            if path == "/api/v1/capabilities":
                return 200, {"features": ["conversations", "authenticated_principals", "capability_authorization"],
                             "capabilities": ["conversations.read_own"]}
            if path == "/api/v1/me":
                return 200, {"id": "standard-1"}
            return 200, body or {}

        client = ConversationService(standard_without_admin)
        with self.assertRaisesRegex(server.WebError, "do not permit") as raised:
            client.create_conversation({"title": "No"})
        self.assertEqual(raised.exception.status, 403)
        with self.assertRaisesRegex(server.WebError, "Invalid conversation identifier"):
            client.get_conversation("../other")

    def test_browser_capability_claims_are_rejected_before_upstream_submission(self):
        calls = []

        def backend(method, path, body):
            calls.append((method, path, body))
            if path == "/api/v1/capabilities":
                return 200, {"features": ["conversations", "authenticated_principals", "capability_authorization"],
                             "capabilities": ["conversations.create"]}
            if path == "/api/v1/me":
                return 200, {"id": "principal-1"}
            return 201, {"id": "conv-1", "title": "Test"}

        client = ConversationService(backend)
        with self.assertRaisesRegex(server.WebError, "Unsupported conversation fields") as raised:
            client.create_conversation({"title": "Test", "capabilities": ["users.change_role"]})
        self.assertEqual(raised.exception.status, 400)
        with self.assertRaisesRegex(server.WebError, "idempotency key is required") as raised:
            client.create_conversation({"title": "Test"})
        self.assertEqual(raised.exception.status, 400)
        self.assertFalse(any(method == "POST" for method, _path, _body in calls))


if __name__ == "__main__":
    unittest.main()
