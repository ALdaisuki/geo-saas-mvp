# Ctrip Host Supervision Design

## Goal

Turn the already verified Ctrip unattended publication path into a restart-safe local distribution. The publication worker and bridge already automate audited preparation, one-time submit and public readback. This design covers their missing Windows host dependencies without weakening platform challenges or publication governance.

## Boundaries

- The supervisor may start Docker Desktop, the dedicated Edge profile and the Ctrip bridge.
- It may restore the CDP transport and report `ready`, `session_required`, `challenge_required`, `unavailable` or `degraded`.
- It must not enter credentials, solve challenges, mint publication grants or bypass the pre-publication audit.
- All profiles, status files and logs stay on the repository data drive. Drive C is rejected for the Edge profile.

## Port Separation

Edge listens only on `127.0.0.1:10015`. Docker reaches a distinct Windows port `10005`, forwarded to `127.0.0.1:10015`. Using the same listen and connect port creates a portproxy loop when Edge is absent, so equal ports are rejected.

The inbound firewall rule permits only the Docker Desktop host gateway range configured by the operator. It must never remain `Any/Any`, because CDP has no application authentication.

## Recovery Order

1. Start Docker Desktop and wait for the engine.
2. Start the dedicated Edge profile and wait for local CDP.
3. repair the separated portproxy and restricted firewall rule.
4. Start the Compose stack or recreate only the bridge when Edge was recovered.
5. Call the tenant-authenticated `/health/ready` endpoint.
6. Persist a credential-free status document for the console and operator.

The scheduled task runs at interactive user logon with highest privileges and a single global mutex. It performs no publication itself; the database-backed bridge poller remains the only submit/readback executor.

## Readiness Semantics

`/health/live` remains an unauthenticated process liveness probe. `/health/ready` requires the tenant bridge bearer. It returns `ready` only when the reviewed CDP session contains the exact Ctrip picture-text publication surface with a complete observation and no login or challenge signal.

Session expiry and challenges are stable stop states, not restart loops. The supervisor records them for human attention while the durable publication job remains unsubmitted or uncertain according to its existing state machine.
