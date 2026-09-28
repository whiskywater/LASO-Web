# PostgreSQL-backed LASO integration

LASO-Web continues to use LASO's HTTP API. The data path is:

```text
Browser -> LASO-Web (Go) -> LASO API -> PostgreSQL
```

LASO-Web does not connect to PostgreSQL, inspect its schema, or contain database credentials. The PostgreSQL lane exercises the same configured LASO endpoint used in production.

## What the lane covers

The `PostgreSQL integration candidate` workflow starts PostgreSQL 16 as an isolated GitHub Actions service, creates a run-specific database role and database, then checks out and builds LASO commit `4547620abb6f30f3163a10dcb08fe52588499659` ([LASO PR #20](https://github.com/Registered-Agent-Attorney/LASO/pull/20), `integration/postgres-durable-sessions`). This is an explicit temporary pin while the PostgreSQL/session integration stack is under review. After that stack lands on LASO `main`, update the workflow to a reviewed `main` commit and retain this lane.

The browser harness starts two independent LASO processes in `multi_instance` mode against the same database and schema, then starts two independently configured Go LASO-Web processes. Chromium uses separate browser contexts and authenticated clients. LASO processes start one at a time so the first process applies clean-database migrations before the second connects. CI uses separate fresh databases for two scenarios: the full multi-instance sessions/operator suite, and a context-reduction scenario where two browser clients alternate six turns through their separate Go frontends and LASO processes. The context test checks that both browsers render every turn, then verifies durable generation metadata and final run snapshot linkage. The ordinary suite covers session replay/close/restart, system/run/operator pages, approval decisions, and the schedules empty state.

The split records a known LASO PR #20 integration limitation: when the context-reduction scenario and the rest of the suite reuse one PostgreSQL database, reduction and cross-instance turns complete, but after the later LASO restart a subsequent standalone run can remain `Queued` instead of executing. Both scenarios pass against fresh isolated databases. LASO-Web cannot release LASO-owned runtime/worker state; LASO core should test a normal run after reduction plus session/service restart in a database containing prior reduced sessions before this stack is treated as fully validated together.

The PostgreSQL service is isolated per CI job. The database, application role, and LASO schema use unique workflow run/attempt names. The generated connection string is passed only to LASO server configuration; the test harness removes the PostgreSQL integration variables from Go LASO-Web child processes.

## Local reproduction

Requirements: Go 1.23+, Node.js 22, CMake/Ninja, LASO's C++ and PostgreSQL development packages, PostgreSQL 16, and Playwright Chromium dependencies. Use fresh sibling clones of LASO-Web and LASO. Start an isolated local PostgreSQL instance, create a fresh role/database, and choose an unused schema. Do not point this harness at a shared or production database.

Build LASO at the pinned candidate and the Go frontend:

```sh
git clone --no-checkout https://github.com/Registered-Agent-Attorney/LASO.git ../LASO
git -C ../LASO fetch origin 4547620abb6f30f3163a10dcb08fe52588499659
git -C ../LASO checkout --detach 4547620abb6f30f3163a10dcb08fe52588499659
cmake -S ../LASO -B ../LASO/build-postgres-e2e -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=OFF -DLASO_INSTALL_SYSTEMD_UNIT=OFF
cmake --build ../LASO/build-postgres-e2e --target laso-server --parallel 2
go build -trimpath -o build/laso-web .
npm ci
npx playwright install --with-deps chromium
```

Set the connection details for a dedicated database and schema. Use environment variables in the invoking shell; the test logs do not print the DSN.

```sh
export LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55429 dbname=laso_web_full user=laso_web_test password=local_test_only'
export LASO_E2E_POSTGRES_SCHEMA=laso_web_full
export LASO_E2E_LASO_COUNT=2
export LASO_SOURCE_DIR=../LASO
export LASO_E2E_LASO_SERVER=../LASO/build-postgres-e2e/bin/laso-server
export LASO_E2E_WEB=build/laso-web
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright-browsers"
npm run test:e2e
```

For the focused multi-instance reducer scenario, create a second fresh database/schema owned by the same isolated test role and run just that case:

```sh
LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55429 dbname=laso_web_context user=laso_web_test password=local_test_only' \
LASO_E2E_POSTGRES_SCHEMA=laso_web_context \
LASO_E2E_LASO_COUNT=2 LASO_E2E_CONTEXT_REDUCTION=1 \
npm run test:e2e -- --grep 'PostgreSQL candidate'
```

The harness chooses ephemeral loopback ports and temporary LASO state/config/log directories. It gives each LASO process a separate local data directory and shared PostgreSQL database/schema; artifacts use one isolated shared test root. `LASO_E2E_POSTGRES_CTL`, `LASO_E2E_POSTGRES_DATA`, `LASO_E2E_POSTGRES_PORT`, and `LASO_E2E_POSTGRES_SOCKET` optionally enable stopping/restarting a PostgreSQL cluster during the outage/recovery browser scenario. The harness accepts these controls only for a cluster data directory located inside the isolated workspace. Local browser acceptance checks that an API read returns an upstream gateway error while PostgreSQL is stopped. In the tested LASO candidate, the LASO processes need a restart after PostgreSQL returns before successful queries resume; the test then verifies the browser connection state and read recovery. It separately restarts LASO and verifies durable session history. CI does not control/restart its PostgreSQL service; it tests LASO process restart and database-backed recovery.

The CI provisioning uses PostgreSQL 16 with a per-job `laso_ci` owner connection and a unique least-scope application role/database. Repeated LASO startup against the same schema checks already-applied migration startup. The workflow does not directly migrate from a historical pre-PR20 schema; LASO core owns migration compatibility tests.

## Capability and context compatibility

LASO PR #20 advertises its implemented features through LASO's version response. The Go server centralizes this as an authenticated same-origin read endpoint at `/api/laso/capabilities`, with the shape `{ "advertised": true|false, "capabilities": [...] }`. This is a LASO-Web adapter route, not a second LASO API. Capability names pass through unchanged. When an older LASO responds without that field or does not support the version route, support remains unknown and the current session API probe remains the compatibility fallback; LASO-Web does not claim unadvertised functionality.

The session UI honors explicit `sessions.durable: false` or `sessions.sse: false` advertisements with a compatibility state. Additional generation, snapshot, or reduction data is not required by the general chat flow. The harness checks context-generation and run-context-snapshot metadata through LASO's read-only APIs. LASO retains the full history; LASO owns reduction, immutable generations, and run snapshots. LASO-Web does not receive or persist the derived context payload and does not reduce history locally.

## Current-main compatibility and limitations

The existing browser acceptance workflow remains a separate lane against LASO `main` commit `3cf8bed43d841086d58716bad223e08d6bf22a74` with SQLite. It verifies compatibility with the currently merged core. The PostgreSQL workflow validates the PR #20 candidate. Shipping Go LASO-Web contains no PR number, branch name, database configuration, or PostgreSQL client behavior and continues to support the normal configured LASO HTTP endpoint.

The browser harness can restart a task-owned local PostgreSQL cluster for an end-to-end local recovery scenario. The hosted service cannot be restarted from the job, so hosted CI validates service/database persistence across LASO process restarts rather than PostgreSQL service restart. The schedules browser scenario verifies the supported empty-list state; LASO's deterministic browser fixture does not create a schedule. LASO core owns database migration, worker fencing, and PostgreSQL cross-instance correctness tests.
