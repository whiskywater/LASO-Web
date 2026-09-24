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

The current UI consumes the existing health/version, pipelines, runs, run messages/events, approvals, workers, worker jobs, worker requests, and schedules API routes. It refreshes those records periodically; LASO-Web does not claim SSE/WebSocket streaming or fabricate progress. It does not invent worker assignment, worker health, artifact browsing, or schedule-edit routes. Worker choice remains part of the registered pipeline. LASO owns persistence, policy decisions, orchestration, and API validation; the browser merely renders and requests actions through those interfaces.

## Request safety

The adapter uses a configured base URL and a compile-time route/method allowlist. Browser input never chooses a host or scheme. Request bodies are JSON objects capped at 1 MiB; responses are capped at 4 MiB; upstream operations have a timeout. Credentials are server-only. Output is rendered with DOM text nodes, not HTML interpolation. State-changing browser requests require JSON and reject a mismatched `Origin` host.

This is process separation, not a sandbox. The LASO-Web service account can connect to the configured LASO endpoint and read its own static files/environment. Deployment owners must protect the environment file, restrict network access, and provide TLS for remote access.
