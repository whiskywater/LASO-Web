"""Transport-neutral conversation and effective-settings shapes.

These types describe data exchanged with LASO. They are not persistence
models; LASO owns durable records and validation.
"""

from typing import Any, TypedDict


class Principal(TypedDict, total=False):
    id: str
    display_name: str
    issuer: str
    authenticated_at: str


class CapabilityDocument(TypedDict, total=False):
    features: list[str]
    capabilities: list[str]
    policy_revision: str


class FeatureDiscovery(TypedDict, total=False):
    discovery: str
    principal: Principal | None
    features: dict[str, bool]
    capabilities: list[str]
    conversations_available: bool
    reason: str


class Conversation(TypedDict, total=False):
    id: str
    title: str
    revision: int
    created_at: str
    updated_at: str
    last_message_at: str | None
    owner_id: str
    settings: dict[str, Any]


class ConversationMessage(TypedDict, total=False):
    id: str
    conversation_id: str
    sequence: int
    actor_id: str | None
    role: str
    kind: str
    content: Any
    created_at: str
    run_id: str | None


class ConversationPage(TypedDict, total=False):
    items: list[Conversation]
    next_cursor: str | None
    revision: int


class CreateConversationRequest(TypedDict, total=False):
    title: str
    pipeline_id: str
    settings: dict[str, Any]
    idempotency_key: str


class MessagePage(TypedDict, total=False):
    items: list[ConversationMessage]
    next_cursor: str | None
    conversation_revision: int


class TurnSubmission(TypedDict, total=False):
    message: dict[str, Any]
    expected_revision: int
    idempotency_key: str
    pipeline_id: str
    settings: dict[str, Any]


class TurnReceipt(TypedDict, total=False):
    conversation_id: str
    conversation_revision: int
    user_message_id: str
    run_id: str
    run_context_snapshot_id: str
    state: str


class ContextStatus(TypedDict, total=False):
    conversation_id: str
    conversation_revision: int
    generation_id: str | None
    generation: int
    context_budget: int
    represented_tokens: int
    represented_message_count: int
    source_sequence_start: int | None
    source_sequence_end: int | None
    recent_sequence_start: int | None
    last_compacted_at: str | None
    automatic_compaction: bool
    compaction_policy: str


class RuntimeSettings(TypedDict, total=False):
    """Execution-sensitive settings; LASO validates and enforces these."""

    default_pipeline: str
    allowed_pipelines: list[str]
    model_provider: str
    model: str
    context_budget: int
    automatic_compaction: bool
    compaction_threshold: float
    compaction_policy: str
    maximum_concurrent_runs: int


class DisplayPreferences(TypedDict, total=False):
    """Presentation-only choices; these never affect LASO model context."""

    theme: str
    history_page_size: int
    collapse_technical_details: bool
    compact_message_spacing: bool


class SettingsLayer(TypedDict, total=False):
    system_defaults: RuntimeSettings
    role_defaults: RuntimeSettings
    user_overrides: RuntimeSettings
    conversation_overrides: RuntimeSettings
    effective: RuntimeSettings
    sources: dict[str, str]
