# Go backend migration

LASO-Web runs as one Go server. The server embeds and serves the existing
workspace and session assets, then forwards browser API calls through a narrow,
same-origin adapter to LASO. No Python application server or fallback is part
of a production deployment.

## Retained backend behavior

| Previous Python server behavior | Go implementation |
| --- | --- |
| Read simple `.env` key/value file; process environment wins | `internal/web/config.go` |
| Validate URL, bind, password, host allowlist, and bearer-token lengths | `internal/web/config.go` |
| Loopback defaults; require strong password and allowed hosts remotely | `internal/web/config.go` and `TestRemoteBindRequiresStrongPasswordAndAllowedHosts` |
| Basic authentication, host checks, security headers, and same-origin writes | `internal/web/server.go` and Go HTTP tests |
| Bounded concurrent requests | `internal/web/server.go` request slots |
| JSON-only object writes, body and upstream-response bounds, timeout, no redirects | `internal/web/proxy.go` |
| Restrict methods and paths to the documented LASO API; validate pagination | `internal/web/routes.go` |
| Server-only LASO bearer token and safe upstream error handling | `internal/web/proxy.go` |
| Serve the workspace HTML, scripts, and styles | Embedded `static/*` assets through `main.go` and `internal/web/server.go` |
| Standalone runs, pipeline selection, run history/details, workers/jobs, approvals/decisions, schedules, health/version/system views | Existing browser workspace served by Go plus the parity route allowlist |
| Durable session pages, turns, and replayable SSE | Existing Go session client and LASO adapter |

The Go test suite contains the former Python route/security cases as Go tests,
including adapter allowlisting, the operator-route matrix, authentication,
same-origin validation, body limits, server-side credentials, and redirect
rejection. Python test-server code has been removed. The remaining Python files
under `tests/` are optional integration harnesses that launch only Go/LASO
binaries against isolated test data.

## API coverage and limits

The adapter exposes only routes used by the application and supported by the
current LASO API: health/version, pipeline list/detail/registration and run
creation, run list/detail/events/attempts/messages/cancel/resume, worker and
worker-job lists/details/cancel, approval list/detail/approve/reject,
worker-request list/detail/respond/answer/approve/deny/cancel, schedule
list/detail/enable/disable, and the durable-session operations documented in
[`laso-sessions.md`](laso-sessions.md).

The interface keeps the same limits as the Python adapter: request JSON is
capped at 1 MiB, LASO responses at 4 MiB, normal API requests have an 8-second
upstream timeout, and redirects are not followed. Session SSE uses a separate
streaming transport and is canceled when the browser connection closes. The
operator UI currently lists schedules but does not create or edit them. The
PostgreSQL integration fixtures verify workers/jobs views against the real API's
empty-list result.

## Production startup

`./run.sh` requires Go 1.23 or newer and does not launch another backend when Go
is unavailable. Production can instead install the standalone binary and
[`deploy/systemd/laso-web.service`](../deploy/systemd/laso-web.service). The
binary embeds the static UI. `LASO_TOKEN` stays in Go server configuration and
is sent only from the server to LASO.

The end-to-end harnesses in `tests/integration_laso.py` and
`tests/integration_sessions.py` are test tools, not runtime dependencies. They
use isolated PostgreSQL schemas. The session exercise runs two LASO servers and
two Go frontends against the same database-backed session, including recovery
after one LASO server restarts.
