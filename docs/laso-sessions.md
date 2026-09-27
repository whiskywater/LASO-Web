# Durable LASO sessions in LASO-Web

## Responsibility boundary

LASO owns the durable session ID, pipeline association, ordered accepted turns,
turn execution, run linkage, and event journal. LASO-Web reads those records and
renders them as a conversation. It has no transcript database, localStorage
history, local context assembly, or process-local pub/sub. A reload or another
LASO-Web process reads the same session from LASO.

LASO sessions are generic runtime sessions. They are not web accounts, user
profiles, memberships, or a product's conversation authorization model. LASO-Web
does not create those concepts. The current LASO development identity is
unauthenticated, so a shared web password is only a gateway credential: a
gateway user who knows a session ID can access it. Do not expose either service
publicly without deployment-owned identity/authorization, network controls, and
TLS.

## API contract consumed

The Go adapter validates and forwards only its supported LASO routes. Session
chat uses:

* `GET /api/v1/sessions?limit=&offset=` to discover compatibility and list
  recent sessions.
* `POST /api/v1/sessions` with `{"pipeline_id":"name@version"}`.
* `GET /api/v1/sessions/{id}` to reopen the same session URL.
* `GET /api/v1/sessions/{id}/turns?limit=&offset=` for durable ordered history.
* `POST /api/v1/sessions/{id}/turns` with an idempotency key and pipeline input.
* `GET /api/v1/sessions/{id}/events/stream` for durable event replay and live
  observation.

The current session API has no persisted title/rename operation. The sidebar
uses the first durable turn as a display label (or pipeline and date while
empty). It does not claim that label is editable or persisted independently.
Messages currently use the pipeline input shape `{"prompt":"..."}`. Pipelines
with a different schema should use the existing run workspace's custom input
or a future session composer that understands the schema.

The page initially loads the latest ordered page of turns and fetches earlier
pages from LASO on demand. It does not keep the entire transcript in browser
storage.

The Go web server checks the actual session list route instead of inferring
support from `/version`; current public LASO main does not publish a capability
discovery endpoint. Older LASO servers return an explanatory unavailable state
for chat while existing run/workspace routes remain usable. SSE failures are
shown/retried separately from session history. No unmerged capability,
context-generation, or reduction PR is required for session turns.

## SSE, reconnect, and multiple clients

Each browser opens its own same-origin Go adapter stream. The adapter forwards
`Last-Event-ID` to LASO and copies the SSE body without buffering or routing it
through a process-local event bus. This works across LASO-Web replicas when
they share the same LASO deployment; LASO's durable event journal supplies
cross-instance replay.

LASO event IDs are monotonically increasing per-session decimal sequence
numbers. LASO documents replay as at-least-once; an event can be seen twice
across a disconnect. The browser stores a cursor in memory using exact integer
precision, ignores duplicate/out-of-order IDs, ignores heartbeat comments, and
advances over unknown event types. On each event it reloads the canonical turn
list from LASO rather than building a local transcript from event payloads. A
full browser reload begins replay from cursor zero, which safely catches up
from the durable journal without localStorage. Temporary API outages reconnect
with backoff; a 429 stream-admission response honors `Retry-After`.

The current event stream reports accepted/claimed/started/completed/failed
execution lifecycle, not model token chunks. The UI waits for LASO's durable
turn result and does not fabricate streaming output. A turn's `run_id` remains
available as secondary Run details that link to the existing run workspace.

LASO's context-generation and run-context provenance can be shown later from
their Core API. LASO-Web does not summarize, trim, or select effective model
context. LASO owns provider continuation and any future context reduction.

## Running the Go application

Go 1.23 or newer is required. `./run.sh` prefers Go when installed and falls
back to the Python compatibility workspace otherwise. To build/deploy an
immutable binary:

```sh
go test ./...
go test -race ./...
go build -trimpath -o laso-web .
LASO_URL=http://127.0.0.1:8080 LASO_WEB_BIND=127.0.0.1 ./laso-web
```

The existing `deploy/systemd/laso-web.service` still runs the Python
compatibility server. `deploy/systemd/laso-web-go.service` is the Go unit
example. Configuration variables are the same, including the server-only
`LASO_TOKEN`, exact allowed-host list, loopback default, and the requirement
for a strong password plus host allowlist on non-loopback binds. Use TLS in a
reverse proxy for Basic authentication. Do not publish the bearer token to
frontend responses.

## Known API and product limitations

* LASO has no session title/rename API on the audited public main; labels are
  derived from durable messages.
* LASO development identity has no per-principal ownership enforcement. Sharing
  a session ID is not secure access control.
* The Go chat composer currently submits `prompt` input; arbitrary pipeline
  schemas need a composer affordance.
* Current main has no `/capabilities` API. The adapter probes session support
  by performing a bounded session-list request; it does not invent a capability
  advertisement.
* Context generation/automatic reduction APIs on open LASO PRs are not treated
  as present. They remain runtime-owned work.
* The two-client test verifies independent Go frontends against one durable API
  fixture; the opt-in real LASO integration script exercises the actual LASO
  server and SQLite. Production multi-process sharing requires LASO's
  PostgreSQL mode and deployment authorization configured for that deployment.
