"""LASO conversation integration boundary.

Conversation persistence and policy belong to LASO. This module contains the
upstream resource contract in one place and exposes operation-oriented methods
to the HTTP adapter; callers do not assemble LASO conversation URLs directly.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from urllib.parse import quote

from server import WebError
from conversation_models import (
    CapabilityDocument,
    ContextStatus,
    Conversation,
    ConversationPage,
    ConversationMessage,
    CreateConversationRequest,
    FeatureDiscovery,
    MessagePage,
    TurnReceipt,
    TurnSubmission,
)

Transport = Callable[[str, str, dict[str, Any] | None], tuple[int, object]]

READ_CONVERSATION = frozenset({
    "conversations.read_own",
    "conversations.read_shared",
    "conversations.read_all",
})
FEATURE_NAMES = frozenset({
    "conversations",
    "conversation_membership",
    "conversation_context",
    "context_compaction",
    "authenticated_principals",
    "capability_authorization",
})
RUNTIME_SETTING_NAMES = frozenset({
    "default_pipeline", "allowed_pipelines", "model_provider", "model", "context_budget",
    "automatic_compaction", "compaction_threshold", "compaction_policy", "maximum_concurrent_runs",
})


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise WebError(502, f"LASO returned an invalid {label}")
    return value


def _string_set(value: object, label: str) -> frozenset[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise WebError(502, f"LASO returned invalid {label}")
    return frozenset(value)


class ConversationService:
    """Typed application service over LASO's future conversation API."""

    def __init__(self, transport: Transport):
        self._transport = transport

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> object:
        try:
            status, value = self._transport(method, path, body)
        except WebError:
            raise
        if status == 401:
            raise WebError(401, "LASO authentication is required")
        if status == 403:
            raise WebError(403, "LASO denied this operation")
        if status == 409:
            raise WebError(409, "Conversation changed since this view; reload before continuing")
        if status == 429:
            raise WebError(429, "LASO is at capacity; retry after it becomes available")
        if status >= 500:
            raise WebError(502, "LASO could not complete the request")
        if status >= 400:
            messages = {
                400: "LASO rejected the conversation request.",
                404: "LASO could not find that conversation or operation.",
                409: "Conversation changed since this view; reload before continuing",
                422: "Conversation settings or membership do not satisfy LASO policy.",
            }
            raise WebError(status, messages.get(status, "LASO rejected the conversation request"))
        return value

    def discover(self) -> FeatureDiscovery:
        """Read backend features and the authenticated principal, never browser claims."""
        capabilities_status, raw_capabilities = self._transport("GET", "/api/v1/capabilities", None)
        if capabilities_status == 404:
            return self._unavailable("Connected LASO does not advertise API capabilities.")
        if capabilities_status in {401, 403}:
            return self._unavailable("LASO did not provide an authenticated principal.", "unauthenticated")
        if capabilities_status >= 400:
            self._request("GET", "/api/v1/capabilities")
        caps: CapabilityDocument = _object(raw_capabilities, "capability response")
        features = _string_set(caps.get("features"), "feature list")
        permissions = _string_set(caps.get("capabilities"), "principal capability list")

        me_status, raw_me = self._transport("GET", "/api/v1/me", None)
        if me_status == 404:
            return self._unavailable("Connected LASO does not expose an authenticated principal.")
        if me_status in {401, 403}:
            return self._unavailable("LASO did not provide an authenticated principal.", "unauthenticated")
        if me_status >= 400:
            self._request("GET", "/api/v1/me")
        principal = _object(raw_me, "principal response")
        if not isinstance(principal.get("id"), str) or not principal["id"].strip():
            raise WebError(502, "LASO returned an invalid principal identity")

        required_features = {"conversations", "authenticated_principals", "capability_authorization"}
        ready = required_features.issubset(features)
        reason = "" if ready else "LASO has not enabled all conversation and principal-policy features."
        return {
            "discovery": "available",
            "principal": {"id": principal["id"], "display_name": principal.get("display_name", "")},
            "features": {name: name in features for name in FEATURE_NAMES},
            "capabilities": sorted(permissions),
            "conversations_available": ready,
            "reason": reason,
        }

    @staticmethod
    def _unavailable(reason: str, discovery: str = "unsupported") -> FeatureDiscovery:
        return {
            "discovery": discovery,
            "principal": None,
            "features": {name: False for name in FEATURE_NAMES},
            "capabilities": [],
            "conversations_available": False,
            "reason": reason,
        }

    def _authorized(self, permission: str | frozenset[str], feature: str = "conversations",
                    also_require: frozenset[str] = frozenset()) -> FeatureDiscovery:
        info = self.discover()
        if not info["conversations_available"] or not info["features"].get(feature, False):
            raise WebError(501, info["reason"] or f"LASO does not support {feature}.")
        allowed = info["capabilities"]
        required = {permission} if isinstance(permission, str) else permission
        if not required.intersection(allowed) or not also_require.issubset(allowed):
            raise WebError(403, "LASO capabilities do not permit this conversation operation")
        return info

    @staticmethod
    def _fields(body: dict[str, Any], allowed: frozenset[str], label: str) -> dict[str, Any]:
        unexpected = set(body) - allowed
        if unexpected:
            raise WebError(400, f"Unsupported {label} fields: {', '.join(sorted(unexpected))}")
        return body

    @staticmethod
    def _settings(value: object) -> None:
        if value is not None and (not isinstance(value, dict) or set(value) - RUNTIME_SETTING_NAMES):
            raise WebError(400, "Settings contain unsupported fields")

    @staticmethod
    def _id(value: str) -> str:
        if not value or len(value) > 128 or "/" in value or "\\" in value:
            raise WebError(400, "Invalid conversation identifier")
        return quote(value, safe="-_.@")

    @staticmethod
    def _items(value: object, label: str) -> dict[str, Any]:
        result = _object(value, label)
        items = result.get("items")
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise WebError(502, f"LASO returned invalid {label} items")
        return result

    @staticmethod
    def _conversation(value: object) -> dict[str, Any]:
        result = _object(value, "conversation")
        conversation = result.get("conversation", result)
        if not isinstance(conversation, dict) or not isinstance(conversation.get("id"), str):
            raise WebError(502, "LASO returned an invalid conversation")
        return conversation

    @staticmethod
    def _message(value: object, conversation_id: str) -> ConversationMessage:
        message = _object(value, "conversation message")
        if (not isinstance(message.get("id"), str) or not isinstance(message.get("sequence"), int)
                or message["sequence"] < 1 or not isinstance(message.get("role"), str)
                or message.get("conversation_id") != conversation_id):
            raise WebError(502, "LASO returned an invalid conversation message")
        return message

    def list_conversations(self, query: str = "") -> ConversationPage:
        self._authorized(READ_CONVERSATION)
        path = "/api/v1/conversations" + ("?" + query if query else "")
        return self._items(self._request("GET", path), "conversation list")

    def create_conversation(self, body: CreateConversationRequest) -> Conversation:
        self._authorized("conversations.create")
        self._fields(body, frozenset({"title", "pipeline_id", "settings", "idempotency_key"}), "conversation")
        self._settings(body.get("settings"))
        if not isinstance(body.get("idempotency_key"), str) or not body["idempotency_key"].strip():
            raise WebError(400, "An idempotency key is required")
        return self._conversation(self._request("POST", "/api/v1/conversations", body))

    def get_conversation(self, conversation_id: str) -> Conversation:
        self._authorized(READ_CONVERSATION)
        return self._conversation(self._request("GET", f"/api/v1/conversations/{self._id(conversation_id)}"))

    def rename_conversation(self, conversation_id: str, body: dict[str, Any]) -> Conversation:
        self._authorized("conversations.rename_own")
        self._fields(body, frozenset({"title", "metadata", "settings", "expected_revision"}), "conversation")
        self._settings(body.get("settings"))
        if not isinstance(body.get("expected_revision"), int):
            raise WebError(400, "An expected conversation revision is required")
        return self._conversation(self._request("PATCH", f"/api/v1/conversations/{self._id(conversation_id)}", body))

    def archive_conversation(self, conversation_id: str) -> object:
        self._authorized("conversations.archive_own")
        return self._request("DELETE", f"/api/v1/conversations/{self._id(conversation_id)}")

    def list_messages(self, conversation_id: str, query: str = "") -> MessagePage:
        self._authorized(READ_CONVERSATION)
        path = f"/api/v1/conversations/{self._id(conversation_id)}/messages" + ("?" + query if query else "")
        result = self._items(self._request("GET", path), "conversation message list")
        sequences = [message.get("sequence") for message in result["items"]]
        if (any(not isinstance(sequence, int) or sequence < 1 for sequence in sequences)
                or sequences != sorted(sequences) or len(sequences) != len(set(sequences))):
            raise WebError(502, "LASO returned conversation messages out of order")
        if any(not isinstance(message.get("id"), str) or not isinstance(message.get("role"), str)
               for message in result["items"]):
            raise WebError(502, "LASO returned an invalid conversation message")
        return result

    def get_message(self, conversation_id: str, message_id: str) -> ConversationMessage:
        self._authorized(READ_CONVERSATION)
        path = f"/api/v1/conversations/{self._id(conversation_id)}/messages/{self._id(message_id)}"
        return self._message(self._request("GET", path), conversation_id)

    def submit_turn(self, conversation_id: str, body: TurnSubmission) -> TurnReceipt:
        self._authorized(READ_CONVERSATION, also_require=frozenset({"runs.create"}))
        self._fields(body, frozenset({"message", "expected_revision", "idempotency_key", "pipeline_id", "settings"}), "turn")
        self._settings(body.get("settings"))
        if not isinstance(body.get("idempotency_key"), str) or not body["idempotency_key"].strip():
            raise WebError(400, "An idempotency key is required")
        if not isinstance(body.get("expected_revision"), int) or not isinstance(body.get("message"), dict):
            raise WebError(400, "A message and expected conversation revision are required")
        self._fields(body["message"], frozenset({"content", "attachments"}), "user message")
        if "content" not in body["message"]:
            raise WebError(400, "Message content is required")
        path = f"/api/v1/conversations/{self._id(conversation_id)}/turns"
        result = _object(self._request("POST", path, body), "turn response")
        if not isinstance(result.get("run_id"), str) or not isinstance(result.get("user_message_id"), str):
            raise WebError(502, "LASO returned an invalid conversation turn")
        return result

    def list_members(self, conversation_id: str) -> dict[str, Any]:
        self._authorized(READ_CONVERSATION, "conversation_membership",
                         frozenset({"conversations.members.read"}))
        path = f"/api/v1/conversations/{self._id(conversation_id)}/members"
        return self._items(self._request("GET", path), "conversation member list")

    def add_member(self, conversation_id: str, body: dict[str, Any]) -> object:
        self._authorized(READ_CONVERSATION, "conversation_membership",
                         frozenset({"conversations.members.manage"}))
        self._fields(body, frozenset({"principal_id", "access"}), "membership")
        if not isinstance(body.get("principal_id"), str) or not body["principal_id"]:
            raise WebError(400, "A member principal ID is required")
        return self._request("POST", f"/api/v1/conversations/{self._id(conversation_id)}/members", body)

    def remove_member(self, conversation_id: str, principal_id: str) -> object:
        self._authorized(READ_CONVERSATION, "conversation_membership",
                         frozenset({"conversations.members.manage"}))
        path = f"/api/v1/conversations/{self._id(conversation_id)}/members/{self._id(principal_id)}"
        return self._request("DELETE", path)

    def context_status(self, conversation_id: str) -> ContextStatus:
        self._authorized(READ_CONVERSATION, "conversation_context",
                         frozenset({"conversation_context.read"}))
        path = f"/api/v1/conversations/{self._id(conversation_id)}/context"
        result = _object(self._request("GET", path), "context status")
        generation = result.get("generation")
        if generation is not None and not isinstance(generation, (str, int)):
            raise WebError(502, "LASO returned an invalid context generation")
        return result


def conversation_route(
    method: str,
    path: str,
    query: str,
    body: dict[str, Any] | None,
    service: ConversationService,
) -> tuple[int, object] | None:
    """Map the adapter's stable client routes onto service operations."""
    import re

    if path == "/api/features":
        if query:
            raise WebError(400, "Feature discovery does not accept query parameters")
        if method == "GET":
            return 200, service.discover()
        raise WebError(405, "Feature discovery is read-only")
    if path == "/api/conversations":
        if method == "GET":
            return 200, service.list_conversations(query)
        if method == "POST":
            return 201, service.create_conversation(body or {})
        raise WebError(405, "Method is not available for conversations")
    match = re.fullmatch(r"/api/conversations/([A-Za-z0-9_.@-]{1,128})(?:/(messages|turns|members|context)(?:/([A-Za-z0-9_.@-]{1,128}))?)?", path)
    if not match:
        return None
    conversation_id, child, item_id = match.groups()
    if query and (child != "messages" or item_id is not None):
        raise WebError(400, "This conversation operation does not accept query parameters")
    if child is None:
        if method == "GET":
            return 200, service.get_conversation(conversation_id)
        if method == "PATCH":
            return 200, service.rename_conversation(conversation_id, body or {})
        if method == "DELETE":
            return 200, service.archive_conversation(conversation_id)
    elif child == "messages" and method == "GET":
        return 200, service.list_messages(conversation_id, query) if item_id is None else service.get_message(conversation_id, item_id)
    elif child == "turns" and method == "POST":
        return 202, service.submit_turn(conversation_id, body or {})
    elif child == "members":
        if item_id is None and method == "GET":
            return 200, service.list_members(conversation_id)
        if item_id is None and method == "POST":
            return 201, service.add_member(conversation_id, body or {})
        if item_id is not None and method == "DELETE":
            return 200, service.remove_member(conversation_id, item_id)
    elif child == "context" and item_id is None and method == "GET":
        return 200, service.context_status(conversation_id)
    raise WebError(404, "Conversation operation is not available")
