# Continuous conversations: LASO API contract

## Current boundary

LASO-Web is a client of LASO, not a conversation database. The public LASO
`/api/v1` contract currently exposes `GET /runs`, `GET /runs/{id}`, and
run-scoped `GET /runs/{id}/messages` and `/events`, plus run creation and
controls. It does not expose conversations, conversation membership, a stable
ordered conversation transcript, or a way to submit a new turn against a
conversation. The current development identity is unauthenticated. See the
[LASO API reference](https://github.com/Registered-Agent-Attorney/LASO/blob/main/docs/access.md).

The run and message records LASO already stores are useful execution/audit
records, but grouping runs by browser state, reusing a worker's external
session ID, or replaying prior run messages from LASO-Web would create a second
and incomplete definition of conversation state. LASO-Web therefore does not
claim continuous conversations until LASO offers the contract below. It must
not store canonical conversation transcripts in localStorage, frontend memory,
or a LASO-Web database.

## Minimum LASO HTTP API

All authorization decisions must be made by LASO from its authenticated
principal and conversation membership/policy. A caller-supplied `owner_id`,
role, or actor field must never grant access. Collection and item reads must
use the same policy as message submission.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/conversations?limit=&offset=&cursor=` | List conversations visible to the authenticated principal, ordered by `updated_at` descending with stable pagination. |
| `POST` | `/api/v1/conversations` | Create a conversation; accept a title and permitted pipeline/settings selection. Derive owner and initial membership from identity/policy. |
| `GET` | `/api/v1/conversations/{id}` | Read title, metadata, membership-visible summary, revision, and timestamps. |
| `PATCH` | `/api/v1/conversations/{id}` | Rename or change permitted metadata/settings, guarded by capability policy and an expected revision. |
| `DELETE` | `/api/v1/conversations/{id}` | Optional soft-delete/archive, subject to policy and retention rules. |
| `GET` | `/api/v1/conversations/{id}/messages?after=&limit=` | Read the canonical chronological message history. Return stable sequence numbers and opaque message IDs; pagination must not reorder records. |
| `POST` | `/api/v1/conversations/{id}/messages` | Append a user message and start a run using LASO's effective context for this conversation. Require an idempotency key and expected conversation revision. Return the message ID, run ID, and accepted conversation revision. |
| `GET` | `/api/v1/conversations/{id}/events?after=` | Optional event feed for cross-client updates. It may be SSE later; polling must remain a supported fallback. |

Message responses need at least `id`, `conversation_id`, monotonically
increasing `sequence`, `actor_id` (when available), `role` or typed message
kind, content/content reference, `created_at`, and optional `run_id`. Tool and
system records must be distinguishable from user and assistant messages.
Assistant output must be appended by LASO and linked to the originating run.
Concurrent sends with stale revisions should receive a conflict response and
must not silently fork the conversation. Retries with the same idempotency key
must return the original accepted message/run pair instead of creating a
duplicate turn.

If reads are too large, LASO may add cursor pagination and a compact summary to
the conversation list. The message endpoint remains the source of the full
retained history; it must not return only the effective model context.

## Durable context and compaction

LASO must retain original messages independently from derived model context.
Compaction is performed in LASO at a serialized conversation revision and
creates a durable generation/checkpoint containing:

* conversation ID and monotonically increasing generation;
* source-message sequence range and source revision represented;
* compacted summary/context payload, provenance, and creation time;
* effective context budget and compaction policy/version;
* the recent uncompressed messages retained after the checkpoint.

Every run records the conversation ID, triggering message ID, the context
generation/revision it consumed, and the effective pipeline/model selection.
The full original transcript remains queryable after compaction. A client can
display context status and request a permitted policy change, but it must not
trim, summarize, or choose an alternative prompt history locally. Replaying an
old run must use the recorded run inputs, not rebuild context from a browser's
current state.

## Storage shape

The names can follow LASO's storage conventions; these logical records are the
minimum needed to implement the contract without overloading run messages:

* `Conversation`: ID, title, creator/owner principal, metadata, effective
  settings, revision, created/updated/deleted timestamps.
* `ConversationMembership`: conversation ID, principal ID, membership role or
  capability grants, created/updated timestamps. Membership authorization
  remains LASO policy, not UI visibility.
* `ConversationMessage`: ID, conversation ID, sequence, actor principal,
  message kind/role, durable payload or artifact reference, timestamp, related
  run ID, and idempotency key. Appends are transactional and sequence ordered.
* `ConversationContextGeneration`: conversation ID, generation, source
  sequence/revision range, derived summary/context, budget, policy version,
  timestamps, and provenance.
* `ConversationRun`: conversation ID, user message ID, run ID, consumed context
  generation/revision, and effective execution settings. A unique run
  relationship prevents ambiguous transcript ordering.

SQLite should preserve single-process ownership; PostgreSQL may support
multiple service instances. Both need transactional sequence allocation,
revision checks, uniqueness for idempotency keys, and access-policy enforcement.
The run/message audit log remains intact and linked to the conversation.

## Identity, capabilities, and settings

LASO needs a generic principal and capability/policy interface before the web
application can safely provide multiple roles. A deployment's authentication
adapter establishes principal identity. LASO maps policy roles to capabilities
such as `conversations.create`, `conversations.read_own`,
`conversations.read_all`, `conversations.rename_own`, `runs.create`,
`runs.read_own`, `runs.read_all`, `approvals.decide`, `workers.view`,
`configuration.view`, and `configuration.edit`. Collection filtering and
item/action checks must enforce these capabilities inside LASO. LASO-Web may
map those generic capabilities into Standard/Admin presentation, but cannot
override backend denial or treat a browser-supplied role as authority.

The initial LASO-Web presentation can map the generic capabilities this way:

| LASO-Web role | Capability intent |
| --- | --- |
| Standard | Create conversations and runs; read, rename, and delete conversations/runs the LASO principal owns or is allowed to access; view/decide only approvals LASO assigns; change safe personal preferences. |
| Admin | Standard capabilities plus explicitly authorized `read_all`, user/role management, system status, operational views, and role/system configuration changes. |

This table is a target mapping, not an active local role check. The current
LASO development API does not authenticate principals or enforce ownership, so
implementing it only in LASO-Web would be misleading and unsafe. After LASO
supports identities, Standard/Admin operations must be hidden or disabled in
the UI according to returned capabilities and independently rejected by the
server adapter when the authenticated principal lacks the required capability.
Role changes must revoke or refresh the affected principal's active sessions
so a previously granted capability cannot remain usable.

Configuration resolution should be explicit and returned as effective status:

```text
system defaults -> role defaults -> principal overrides -> conversation overrides
```

Settings such as allowed/default pipeline, context budget, automatic compaction
policy, model/provider, and concurrent-run limits must be validated and
enforced by LASO. LASO-Web settings can request changes only through authorized
LASO operations; local display preferences remain client-side and are not
execution policy.

Until LASO authenticates requests and enforces conversation/run ownership, a
shared LASO bearer token behind LASO-Web is one backend identity. It cannot
provide safe Standard/Admin separation or per-user run visibility by itself.
The current LASO-Web shared Basic credential is an operator gate only.

## Completion checks

Before LASO-Web can call continuous conversations complete, integration tests
against a real LASO service need to verify:

1. Create a conversation, append turns, reload the page, and recover the same
   ID and full ordered history from LASO.
2. A second independent client authenticated as the same authorized principal
   sees the same conversation ID, revision, and ordered history.
3. A follow-up message uses the same conversation and a fresh conversation
   creates an independent history.
4. Concurrent/stale writes and retried idempotency keys do not reorder or
   duplicate turns.
5. A user outside the membership policy cannot list, read, rename, or append to
   the conversation by calling endpoints directly.
6. Compaction leaves all source messages intact and records the exact context
   generation consumed by each associated run.
7. Role changes and expired/malformed credentials are enforced by LASO and
   take effect on subsequent requests.

Until those backend APIs exist, LASO-Web's run workspace remains available and
honest about being run-scoped; it does not offer a local substitute for a
conversation or claim that worker session resumption is equivalent.
