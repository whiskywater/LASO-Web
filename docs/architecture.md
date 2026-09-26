# Architecture

```text
Browser
  │ same-origin HTML/CSS/JavaScript requests
  ▼
LASO-Web
  │ fixed route allowlist; bounded JSON; optional server-side bearer credential
  ▼
LASO `/api/v1`
```

LASO-Web is a separate Python standard-library process. It serves static assets and a narrow API adapter. The adapter maps UI requests to documented LASO endpoints and rejects arbitrary URLs, methods, and paths. It does not store orchestration state or reproduce LASO policy.

The server-side hop prevents browser JavaScript from learning a configured upstream bearer token and avoids requiring cross-origin browser access from LASO. LASO-Web binds to loopback by default. A non-loopback bind requires an explicit password; remote deployments should also use TLS and a reverse proxy. Since LASO's local development identity is unauthenticated, network exposure must be considered carefully at both layers.

## Interface boundary

The current UI consumes the existing health/version, pipelines, runs, run messages/events, approvals, workers, worker jobs, worker requests, and schedules API routes. It refreshes those records periodically; unchanged thread content is not re-rendered, so open activity/details and keyboard focus are not discarded on every poll. Run routes are encoded in the URL fragment so refresh and browser history can restore a selected run without adding a backend route. LASO-Web does not claim SSE/WebSocket streaming or fabricate progress. It does not invent worker assignment, worker health, artifact browsing, or schedule-edit routes. Worker choice remains part of the registered pipeline. LASO owns persistence, policy decisions, orchestration, and API validation; the browser merely renders and requests actions through those interfaces.

## Conversation and capability boundary

The adapter exposes a stable `/api/features` discovery response and routes future conversation actions through `ConversationService` in `conversation_service.py`. Only that service contains the proposed upstream conversation resource mapping. `conversation_models.py` defines typed transport-neutral principal, feature, message, run-receipt, context-status, and layered-settings shapes. It discovers named features and the authenticated principal's capability list from LASO; it does not compare backend versions and never accepts role/capability claims from browser JSON. The browser's Standard/Admin labels are presentation-only projections of LASO-returned capability names.

The public LASO API does not currently expose `/me`, `/capabilities`, or conversation resources. The service therefore reports conversation support unavailable and returns a clear unsupported response for attempted conversation actions. Existing run routes continue through the current bounded adapter unchanged. When LASO implements these resources, the service checks the advertised feature and capability, while LASO remains responsible for authoritative identity, membership, and policy checks on each request. See [the backend handoff](laso-backend-conversation-handoff.md) for the contract and required backend enforcement.

LASO-Web stores no conversation history. Full history, derived context generations, and per-run context snapshots belong to LASO and remain distinct records. The service only forwards conversation operations and renders backend-returned state; it does not select, summarize, or trim model context.

## Request safety

The adapter uses a configured base URL and a compile-time route/method allowlist. Browser input never chooses a host or scheme. Request bodies are JSON objects capped at 1 MiB; responses are capped at 4 MiB; upstream operations have a timeout. Credentials are server-only. Output is rendered with DOM text nodes, not HTML interpolation. State-changing browser requests require JSON and reject a mismatched `Origin` host.

This is process separation, not a sandbox. The LASO-Web service account can connect to the configured LASO endpoint and read its own static files/environment. Deployment owners must protect the environment file, restrict network access, and provide TLS for remote access.
