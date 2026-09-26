# LASO backend handoff: conversation and principal API

This document is a concrete minimum contract for the LASO backend work that
unblocks continuous conversations in LASO-Web. It describes generic runtime
primitives: principals, capabilities, conversations, messages, context
generations, and run snapshots. It does not prescribe a chat product or an
administrative UI.

The public API today exposes run-scoped messages/events and unauthenticated
local development identity. It does not expose these conversation or principal
resources. LASO-Web keeps its current run workspace and treats conversation
operations as unavailable until LASO advertises and enforces this contract.

## 1. Request identity and feature discovery

All endpoints are under `/api/v1` and use JSON. The same authenticated LASO
principal must be resolved on every request by LASO's configured authentication
adapter. The existing LASO-Web static bearer token represents one shared
backend identity and cannot identify different browser users. A multi-user
deployment therefore needs a supported way for LASO-Web's server-side adapter
to make each request as the authenticated user (for example, a validated
deployment identity assertion or a user-scoped token held server-side). Do not
accept a principal ID, role, or capability list from a request body or arbitrary
browser header as proof of identity.

### `GET /api/v1/me`

Returns identity established by LASO authentication middleware:

```json
{
  "id": "principal_opaque_id",
  "display_name": "Alex Example",
  "issuer": "configured-identity-provider",
  "authenticated_at": "2026-09-26T12:00:00Z"
}
```

`id` is stable within its issuer/tenant. Display name is informational and is
not an authorization key. Do not return tokens, password material, or
credential-bearing metadata.

### `GET /api/v1/capabilities`

This is feature discovery and current-principal authorization discovery in one
response. Feature names describe backend operations implemented by this LASO
deployment. Capability names are the permissions of the principal on this
request. They are separate namespaces.

```json
{
  "features": [
    "authenticated_principals",
    "capability_authorization",
    "conversations",
    "conversation_membership",
    "conversation_context",
    "context_compaction"
  ],
  "capabilities": [
    "conversations.create",
    "conversations.read_own",
    "conversations.rename_own",
    "runs.create"
  ],
  "policy_revision": "opaque-policy-revision"
}
```

Names are advertised individually; clients must not compare backend version
numbers. Feature presence never grants a principal permission. Capability
presence in a response helps clients present available actions; LASO must
re-check the authenticated principal, resource membership, and capability on
every collection, item, and state-changing operation. An absent endpoint is a
normal feature-unavailable response for older LASO servers.

Initial feature names are:

* `authenticated_principals`
* `capability_authorization`
* `conversations`
* `conversation_membership`
* `conversation_context`
* `context_compaction`

The set should grow as backend operations become available. A partial feature
set is valid; for example, conversation reads may be enabled before membership
management. LASO-Web must check the individual feature and principal capability
needed for each operation.

## 2. Capability names

Capabilities are generic strings resolved by LASO policy for the authenticated
principal. The initial useful set includes:

```text
conversations.create
conversations.read_own
conversations.read_shared
conversations.read_all
conversations.rename_own
conversations.archive_own
conversations.members.read
conversations.members.manage
conversation_context.read
runs.create
runs.read_own
runs.read_all
approvals.view
approvals.decide
workers.view
schedules.view
system.view
configuration.view
configuration.edit
users.view
users.create
users.disable
users.change_role
```

LASO does not need to know the frontend labels `Standard` or `Admin`. Those are
client presentation mappings. LASO policy must perform object-level checks too:
`conversations.read_own` does not allow reading a conversation owned by a
different principal, and a visible conversation does not necessarily grant
membership-management rights. Membership can add narrowly scoped access, but
does not bypass a global capability requirement.

## 3. Conversation resources

### `GET /api/v1/conversations?limit=50&offset=0`

List only conversations visible to the authenticated principal. Stable order is
`updated_at DESC, id ASC`; the same page request against the same revision must
not reorder records. Initial pagination uses `limit` (1–100) and `offset`
(nonnegative); a later cursor API can be added without changing the resource
identity. Return:

```json
{
  "items": [
    {
      "id": "conv_opaque_id",
      "title": "Review deployment plan",
      "revision": 8,
      "created_at": "2026-09-26T12:00:00Z",
      "updated_at": "2026-09-26T12:15:00Z",
      "last_message_at": "2026-09-26T12:15:00Z"
    }
  ],
  "next_cursor": null
}
```

Do not include content previews unless the caller can read the corresponding
messages. A collection query is always policy-filtered; filtering only in the
client is insufficient.

### `POST /api/v1/conversations`

Create a conversation. Suggested request:

```json
{
  "title": "Review deployment plan",
  "pipeline_id": "review@2",
  "settings": {"context_budget": 32000},
  "idempotency_key": "create-client-generated-opaque-key"
}
```

Fields are optional when LASO has defaults except `idempotency_key`, which is
required. The authenticated principal becomes creator/owner; clients cannot
choose an owner. LASO validates selected pipeline and settings against effective
configuration and policy. Return `201` with the
conversation resource and initial `revision` (starting at 1). The authenticated
principal and `idempotency_key` are unique for creation retries; replaying the
same request returns the original conversation, while reusing a key with a
different body returns `409`.

### `GET /api/v1/conversations/{conversation_id}`

Return the conversation metadata, effective permitted settings, revision, and
the authenticated principal's available conversation-specific actions (or rely
on `/capabilities` plus operation checks). Enforce access on the item itself.

### `PATCH /api/v1/conversations/{conversation_id}`

Rename or update permitted metadata/settings. Suggested request:

```json
{
  "title": "Updated title",
  "expected_revision": 8,
  "settings": {"default_pipeline": "review@2"}
}
```

Reject stale `expected_revision` with `409`; do not silently overwrite a newer
change. Only accept fields LASO policy permits for this principal. Increment
the conversation revision transactionally when a change succeeds.

### Archive/delete

`DELETE /api/v1/conversations/{conversation_id}` performs a policy-checked soft
archive by default and requires `conversations.archive_own` or a more specific
backend policy grant. Original messages and run audit records remain retained
under LASO's retention rules. Permanent erasure, if supported, should be a
separate privileged retention operation; ordinary chat deletion should not
silently rewrite run history.

## 4. Ordered messages and turn submission

### `GET /api/v1/conversations/{conversation_id}/messages?limit=100&after=0`

Return canonical full history ordered by strictly increasing positive
conversation `sequence`, not only the current model context:

```json
{
  "items": [
    {
      "id": "msg_opaque_id",
      "conversation_id": "conv_opaque_id",
      "sequence": 12,
      "actor_id": "principal_opaque_id",
      "role": "user",
      "kind": "message",
      "content": {"text": "Continue the review"},
      "created_at": "2026-09-26T12:15:00Z",
      "run_id": null
    }
  ],
  "conversation_revision": 8,
  "next_cursor": null
}
```

`role` distinguishes `user`, `assistant`, `tool`, and `system`; `kind` can
further identify typed tool calls/results, approvals, or other orchestration
records. Assistant and tool output is appended by LASO and linked to the
originating run. Message IDs are immutable. `sequence` is allocated by LASO in
the transaction that appends the message. Pagination preserves this order and
the original message content remains available after context compaction.

### `POST /api/v1/conversations/{conversation_id}/turns`

Append one user message and create its LASO run atomically with respect to the
conversation's ordering/revision. Suggested request:

```json
{
  "message": {"content": {"text": "Continue the review"}},
  "expected_revision": 8,
  "idempotency_key": "client-generated-opaque-key",
  "pipeline_id": "review@2",
  "settings": {}
}
```

The role and actor are derived from the authenticated principal; do not accept
`role`, `actor_id`, or `owner_id` as authority. Require
`conversations.read_own`/shared membership for this object plus `runs.create`.
If the caller omits `pipeline_id`, use the permitted effective default. LASO
resolves configuration and builds context in the same serialized conversation
revision boundary.

Return `202`:

```json
{
  "conversation_id": "conv_opaque_id",
  "conversation_revision": 9,
  "user_message_id": "msg_opaque_id",
  "run_id": "run_opaque_id",
  "run_context_snapshot_id": "rcs_opaque_id",
  "state": "Queued"
}
```

The assistant result is appended to the canonical conversation when LASO
produces it. It does not need to be synthesized by LASO-Web. The run keeps the
existing run lifecycle, messages, events, approvals, and operational APIs.

#### Ordering, concurrent clients, and retry rules

* Turn submission locks/serializes updates for one conversation and checks
  `expected_revision` in the same transaction as sequence allocation and run
  linkage. The first accepted client advances the revision; a concurrent stale
  client receives `409` with the current revision and must reload history.
* `(conversation_id, authenticated_principal_id, idempotency_key)` is unique.
  Repeating the same key and canonical request returns the original accepted
  user-message/run/snapshot IDs. Reusing the key with different content returns
  `409`.
* Accepted user turns receive one monotonically increasing message sequence.
  Assistant/tool records receive later sequence numbers in deterministic
  append order. Asynchronous execution does not reorder accepted user turns.
* The backend must document whether a second user turn can be accepted while
  the previous run is active. The initial simple policy may serialize turns
  until the prior turn reaches a terminal/waiting state; whichever policy is
  chosen must be explicit and return `409`/`423` when violated.
* A run's `run_id` and context snapshot linkage are durable before `202` is
  returned. Recovery/retry uses these records and never rebuilds an old run's
  context from the latest transcript.

## 5. Shared membership

Membership is optional for private-only deployments. If the
`conversation_membership` feature is advertised:

* `GET /api/v1/conversations/{id}/members` lists only members the caller is
  permitted to inspect. Include principal ID, access level or scoped grants,
  and timestamps; never include credentials.
* `POST /api/v1/conversations/{id}/members` accepts `principal_id` plus an
  access level or narrow grant set. The authenticated principal, policy, and
  conversation owner determine whether it is allowed. Never trust a submitted
  grant to exceed caller authority.
* `DELETE /api/v1/conversations/{id}/members/{principal_id}` revokes membership
  subject to owner/admin policy. Subsequent item/message/turn requests check
  membership again.

Possible member response:

```json
{
  "items": [
    {"principal_id": "principal_opaque_id", "access": "member", "added_at": "2026-09-26T12:00:00Z"}
  ]
}
```

## 6. Context and compaction

Three durable concepts must remain distinct:

1. **Full history:** immutable ordered source messages. Compaction never deletes
   or edits them.
2. **Derived context generation:** an immutable summary/context projection for
   one conversation revision and effective budget. It records generation ID,
   generation number, source message sequence range/IDs, policy and summarizer
   version, token/message counts represented, recent uncompressed range,
   creation time, and prior generation linkage.
3. **Run context snapshot:** an immutable per-run manifest pinning the exact
   context generation plus any uncompressed messages/content references,
   effective budget, pipeline/model/provider and configuration revisions,
   prompt/template revisions, and the resulting context payload hash or stored
   immutable artifact reference. Each run points to exactly one snapshot.

Compaction is initiated and performed by LASO under the same per-conversation
serialization/revision rules as turn submission. LASO-Web may display status or
request a supported policy setting; it never summarizes, trims, or selects the
authoritative context locally.

### `GET /api/v1/conversations/{conversation_id}/context`

Return safe status metadata for the current effective context, for example:

```json
{
  "conversation_id": "conv_opaque_id",
  "conversation_revision": 9,
  "generation_id": "ctxgen_opaque_id",
  "generation": 3,
  "context_budget": 32000,
  "represented_tokens": 21640,
  "represented_message_count": 18,
  "source_sequence_start": 1,
  "source_sequence_end": 10,
  "recent_sequence_start": 11,
  "last_compacted_at": "2026-09-26T12:12:00Z",
  "automatic_compaction": true,
  "compaction_policy": "policy-reference"
}
```

The precise context payload may be sensitive and need not be exposed by this
status endpoint. The original messages remain readable through the messages
endpoint under the caller's conversation-read policy.

### `GET /api/v1/conversations/{conversation_id}/messages/{message_id}`

Return one immutable message using the same authenticated principal and
conversation membership checks as message-list reads. Include its canonical
conversation sequence and related run ID when present; do not permit a direct
message-ID lookup to bypass conversation authorization.

Recommended durable records (or equivalent backend storage structures):

* `Conversation`: owner, title, metadata/settings, revision, timestamps.
* `ConversationMembership`: principal, conversation, scoped access and audit
  timestamps.
* `ConversationMessage`: immutable ID/sequence/actor/kind/content/time/run link
  and idempotency key for accepted user turns.
* `ConversationContextGeneration`: immutable derived context and source range.
* `RunContextSnapshot`: immutable exact context manifest and effective config
  linked to one run.

SQLite remains single-process owned; transactional per-conversation writes and
unique idempotency constraints are required. A multi-instance PostgreSQL
implementation must serialize per-conversation revision/sequence allocation
across instances. Run creation and snapshot linkage cannot be a partial
success.

## 7. Configuration precedence and enforcement

Expose effective settings, source/precedence, and validation errors as generic
runtime configuration. Resolution order:

```text
system defaults -> role defaults -> principal overrides -> conversation overrides
```

Settings that change execution or security must be enforced by LASO on each
conversation turn:

| Setting | LASO responsibility |
| --- | --- |
| Default/allowed pipeline | Validate membership and use the resolved pipeline for run creation. |
| Model/provider | Resolve only configured/authorized providers and persist the effective selection with the run snapshot. |
| Context budget | Enforce against model/runtime constraints and record in context generation/snapshot. |
| Automatic compaction and threshold/policy | Execute in LASO; persist policy version and outcome. |
| Maximum concurrent runs | Enforce in the runtime, including distributed instances. |
| Membership/capability grants | Enforce on every request; never infer from UI role labels. |

LASO-Web can enforce only client-local behavior such as collapsed technical
details, color scheme, and non-authoritative display page size. Even history
page size is a presentation/query preference; it must not trim or suppress
authoritative model context.

## 8. Error and pagination contract

Use LASO's existing JSON error convention where possible. Minimum statuses:

| Status | Meaning |
| --- | --- |
| `400` | Invalid body/query, unknown setting, or malformed ID. |
| `401` | No valid authenticated principal. |
| `403` | Principal lacks a required global capability. |
| `404` | Resource absent or intentionally concealed by membership policy. |
| `409` | Stale revision, idempotency-key/body mismatch, or disallowed concurrent turn. Include current revision where policy permits. |
| `422` | Structurally valid request violates effective policy/configuration. |
| `429` | Runtime/concurrency capacity limit. |
| `503` | Durable storage unavailable; no partial turn acceptance. |

List endpoints return stable ordered `items`, a `next_cursor` (nullable), and
the relevant conversation revision. Initial `limit`/`offset` pagination must
be bounded and deterministic. Message sequence is the ordering authority;
timestamps alone do not establish turn order.

## 9. Backend acceptance tests

Before LASO-Web enables conversation actions, LASO should verify:

1. An unauthenticated request cannot obtain a principal or use conversation
   APIs; malformed and expired credentials fail closed.
2. Capabilities/features come from LASO policy/runtime state, not request data;
   a forged body/header cannot grant permission.
3. A Standard-like principal can create/read/continue only authorized own or
   shared conversations; direct HTTP attempts to admin/global operations are
   denied by LASO.
4. A principal with explicit global capabilities can read/manage only the
   operations those capabilities grant.
5. Two independent clients see the same conversation, revision, and ordered
   history; stale simultaneous submissions cannot both claim the same
   expected revision.
6. Idempotent retry returns the original turn/run/snapshot, while reusing its
   key with a different body conflicts.
7. Full history remains unchanged after compaction; generations identify exact
   source ranges; each run snapshot pins the exact context and configuration
   it consumed.
8. Process restart and the configured storage mode preserve messages,
   memberships, generations, and run links.

Only after these LASO APIs are available and exercised end-to-end should
LASO-Web enable multi-device continuous chat. The web adapter will use one
conversation service boundary and keep its existing run workspace available
for LASO servers that do not advertise these features.
