# PostgreSQL-backed LASO integration

The integration lane validates LASO-Web's Python production server against the
PostgreSQL durable-session candidate. The production request path remains:

```text
Browser -> Python LASO-Web -> LASO API -> PostgreSQL
```

LASO-Web has no PostgreSQL driver, DSN setting, database tables, or direct
connection. PostgreSQL is provisioned only for LASO and the integration test.

## Candidate and CI lanes

The `Python PostgreSQL integration candidate` workflow checks out the exact
LASO PR #20 candidate commit
`4547620abb6f30f3163a10dcb08fe52588499659` (branch
`integration/postgres-durable-sessions`) as a temporary test pin. When this
stack lands on LASO `main`, move the workflow to a reviewed current-main commit
and keep the backend-API integration lane. LASO-Web's production code has no
PR number, branch name, commit check, or candidate-specific behavior.

CI provisions PostgreSQL 16, creates run/attempt-specific application role,
databases, and schema names, then starts two LASO processes in
`multi_instance` mode. LASO instances start in sequence so the first applies
clean-database migrations before the second connects. The harness then starts
two independent `python3 server.py` processes, each configured with its own
LASO endpoint. Playwright uses separate Chromium browser contexts with Basic
authentication. PostgreSQL credentials are passed only to LASO configuration
and stripped from the Python web-process environments.

The main PostgreSQL browser suite exercises the two Python frontends and two
LASO processes against one durable store: shared ordered turns, SSE visibility,
replay after a frontend-process interruption with the browser-held cursor,
deep-link reload, close/read-only history, LASO restart,
standalone runs/history/details, workers, approval/decision, schedules empty
state, mobile interactions, and outage display. The isolated context case uses
a second fresh database with automatic reduction configured, alternates turns
between both browser/frontend/backend paths, and checks context-generation and
run-snapshot metadata without exposing payloads. Repeated service startup
against an already migrated database is included in the setup/restart path.

The other browser workflow checks compatibility against LASO `main` commit
`3cf8bed43d841086d58716bad223e08d6bf22a74` using SQLite. That build does not
advertise capabilities; the Python adapter returns `advertised: false` and the
session page falls back to actual route probing instead of claiming support.

## Local reproduction

Requirements: Python 3.10+, Node.js 22, CMake/Ninja, LASO C++ build
dependencies, PostgreSQL 16, and Playwright Chromium dependencies. Use fresh
clones and a disposable PostgreSQL instance. Create a unique role, database,
and schema; do not use a shared or production database.

Build LASO PR #20 and install browser dependencies:

```sh
git clone https://github.com/Registered-Agent-Attorney/LASO.git ../LASO
git -C ../LASO fetch origin 4547620abb6f30f3163a10dcb08fe52588499659
git -C ../LASO checkout --detach 4547620abb6f30f3163a10dcb08fe52588499659
cmake -S ../LASO -B ../LASO/build-postgres-e2e -G Ninja \
  -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=OFF -DLASO_INSTALL_SYSTEMD_UNIT=OFF
cmake --build ../LASO/build-postgres-e2e --target laso-server --parallel 2
npm ci
npx playwright install --with-deps chromium
```

Set isolated credentials in the environment (the harness does not print them):

```sh
export LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55439 dbname=laso_web_test user=laso_web_test password=local_test_only'
export LASO_E2E_POSTGRES_SCHEMA=laso_web_test
export LASO_E2E_LASO_COUNT=2
export LASO_SOURCE_DIR=../LASO
export LASO_E2E_LASO_SERVER=../LASO/build-postgres-e2e/bin/laso-server
npm run test:e2e
```

The harness chooses free loopback ports and task-temporary LASO state, config,
and log directories. For the context-reduction case use a second new database
and schema and set `LASO_E2E_CONTEXT_REDUCTION=1`, then run:

```sh
LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55439 dbname=laso_web_context user=laso_web_test password=local_test_only' \
LASO_E2E_POSTGRES_SCHEMA=laso_web_context LASO_E2E_LASO_COUNT=2 \
LASO_E2E_CONTEXT_REDUCTION=1 \
npm run test:e2e -- --grep 'PostgreSQL candidate'
```

Optional `LASO_E2E_POSTGRES_CTL`, `LASO_E2E_POSTGRES_DATA`,
`LASO_E2E_POSTGRES_PORT`, and `LASO_E2E_POSTGRES_SOCKET` can enable a local
PostgreSQL stop/start failure scenario. The harness accepts restart controls
only for a cluster data directory located under the isolated workspace. Hosted
CI does not control its PostgreSQL service; it tests LASO process restarts and
persistent database-backed recovery. Local stop/restart testing found that the
PR #20 LASO processes needed a restart after PostgreSQL returned before their
API reads recovered.

## Core follow-up required

Do not combine or silently hide this observed LASO PR #20 issue. On a fresh
database with automatic reduction enabled, run the two-client context scenario
(six long turns), then the shared-session/restart scenario, and then submit a
standalone `hello-pipeline` run through LASO-Web. The first two scenarios pass,
but the later standalone run can remain `Queued` after LASO process restart.
The isolated ordinary/operator database and isolated reduction database pass
individually. LASO Core should reproduce the follow-on standalone run against a
database that already contains reduced sessions and has undergone LASO restart,
then repair worker/queue recovery before the entire same-database stack can be
considered validated together. LASO-Web cannot safely repair this runtime state.

To reproduce the combined ordering from a fresh dedicated database, configure
that test database/schema as above, then run the entire suite with:

```sh
LASO_E2E_CONTEXT_REDUCTION=1 LASO_E2E_LASO_COUNT=2 \
LASO_E2E_POSTGRES_DSN='host=127.0.0.1 port=55439 dbname=laso_web_repro user=laso_web_test password=local_test_only' \
LASO_E2E_POSTGRES_SCHEMA=laso_web_repro npm run test:e2e
```

The observed run in this pass used LASO
`4547620abb6f30f3163a10dcb08fe52588499659`, PostgreSQL 16.15, the
`recent-turns` reducer with `threshold_bytes: 1800`, `target_bytes: 1600`,
`max_input_bytes: 16384`, and `timeout_ms: 30000`. The context-generation test
and shared-session/restart test passed; the next standalone `hello` run remained
`Queued` at the browser's 30-second completion assertion. The issue is not
converted to a passing assertion and is not hidden by the passing isolated CI
lanes.

The PostgreSQL lane also does not mutate schedules: its deterministic fixture
validates the supported empty-list state. LASO owns migration compatibility,
worker fencing, cross-instance ordering, and database recovery semantics.
