# GEO SaaS MVP implementation plan

Date: 2026-07-13

Branch: `codex/geo-saas-mvp`

Worktree: `D:\GEO\.worktrees\geo-saas-mvp`

## Completion contract

The plan implements the complete product described in
`docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md`. A phase is complete
only when its listed test or runtime evidence exists. Dry-run, fixture, manual,
browser-assisted, partner API, and public API outcomes remain visibly distinct.

## Phase 1: repository and contracts

Create:

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- `eslint.config.js`, `.prettierrc.json`, `.editorconfig`
- `.env.example`, `README.md`, `AGENTS.md`
- `packages/config`
- `packages/contracts`
- `apps/api`, `apps/worker`, `apps/agent-mcp`, `apps/web`

Pin the Pi and MCP dependencies verified in exemplar research. Use ESM,
TypeScript strict mode, NodeNext for server packages, and browser module
resolution for the web app. Root scripts must support `dev`, `build`, `test`,
`typecheck`, `lint`, `db:migrate`, and `db:seed`.

Contracts define stable IDs, roles/capabilities, content/audit/publication
states, connector capabilities/execution levels, visibility providers/surfaces,
and API input/output schemas.

Verification:

```powershell
pnpm install --frozen-lockfile=false
pnpm typecheck
pnpm test
```

## Phase 2: deterministic core

Create `packages/core` with:

- RFC 8785 canonical payload hashing and constant-time token hash checks.
- Content/variant state guards.
- Deterministic audit rules and versioned policy bundles.
- Contact and entity consistency checks.
- Evidence/freshness checks and prohibited-claim rules.
- Duplicate fingerprint and similarity thresholds.
- Platform constraint checks for Toutiao, Sohu, and Ctrip Community.
- GEO usefulness structure checks that do not reward keyword stuffing.
- Grant issuance/consumption validation.
- Retry classification, publication transition guards, and circuit-breaker
  decisions.
- Visibility metric reducers with repeated-sample confidence metadata.

Tests start first for bad Sample travel tenant phone/WeChat details, post-audit mutation,
cross-tenant grant use, expired/reused grants, ambiguous connector outcomes,
duplicate campaigns, and harmful visibility signals.

Verification:

```powershell
pnpm --filter @geo/core test
pnpm --filter @geo/core typecheck
```

## Phase 3: PostgreSQL truth source and tenant isolation

Create `packages/db` with explicit SQL migrations and Kysely repositories.

Tables:

- Identity: `users`, `tenants`, `tenant_memberships`, `service_principals`,
  `api_keys`, `sessions`.
- Tenant settings: `brands`, `tenant_contacts`, `policy_bundles`,
  `automation_controls`, `channel_accounts`.
- Content: `campaigns`, `claim_facts`, `evidence_sources`, `content_items`,
  `content_versions`, `media_assets`, `publication_variants`.
- Governance: `audit_runs`, `audit_artifacts`, `publication_grants`,
  `audit_log`.
- Delivery: `publication_jobs`, `publication_attempts`,
  `publication_receipts`, `outbox_events`, `inbox_events`,
  `idempotency_records`, `circuit_breakers`.
- Measurement: `query_sets`, `query_set_versions`, `visibility_runs`,
  `visibility_observations`, `visibility_metrics`.

All tenant tables use non-null tenant IDs, tenant-scoped unique constraints,
tenant-scoped composite foreign keys, and forced RLS. Runtime roles cannot own
tables or bypass RLS. Repository entry points require a tenant/actor transaction
context. Dispatcher functions claim outbox work without granting broad table
access.

Seed:

- Example Travel Services / 示例国际旅行服务.
- Hotline `4000000001`.
- WeChat `TRAVEL_DEMO_01`, `TRAVEL_DEMO_02`.
- Travel policy/query-set version 1.
- Three dry-run platform accounts.
- Shadow automation mode.
- A second synthetic tenant used only to prove isolation.

Tests use a real PostgreSQL engine. The repository ships Docker Compose for
normal environments and a Windows-compatible local test bootstrap for this
workspace, because Docker is not installed here. Tests must prove cross-tenant
select/insert/update denial using the actual runtime role.

Verification:

```powershell
pnpm db:test:start
pnpm db:migrate
pnpm db:seed
pnpm --filter @geo/db test:integration
pnpm db:test:stop
```

## Phase 4: API, identity, and authorization

Create `apps/api` with Fastify, Zod/OpenAPI, secure cookies, Argon2 password
hashing, membership-scoped roles, CSRF/origin protection, structured errors,
request IDs, and redacted logs.

Routes:

- `/health`, `/ready`, `/capabilities`
- `/auth/login`, `/auth/logout`, `/auth/session`
- `/tenants`, `/tenants/:id`, contacts, members, policies, channel accounts
- campaigns, facts/evidence, content items/versions, rendered variants
- audit request/report and grant revocation
- publication request/job/attempt/receipt/cancellation
- automation mode, quotas, kill switches, circuit breakers
- query sets, visibility run/import/observations/metrics
- dashboard summaries and audit log

There is no public create-grant route. A passing deterministic audit invokes the
policy service, which may issue a grant. Publication requests accept only a
frozen variant ID and an idempotency key.

Tests prove authentication, capability checks, tenant mismatch rejection,
idempotency request-hash conflicts, audit/grant behavior, and response redaction.

Verification:

```powershell
pnpm --filter @geo/api test
pnpm --filter @geo/api typecheck
```

## Phase 5: connectors, outbox worker, and circuit breakers

Create `packages/connectors` and `apps/worker`.

Connector SPI:

- `probeCapabilities`
- `validateSession`
- `renderDraft`
- `preflight`
- `submitDraft`
- `publish`
- `pollStatus`
- `reconcile`
- `captureEvidence`

Implement Toutiao, Sohu, and Ctrip Community dry-run connectors. Each creates an
immutable preview and simulated receipt labeled `DRY_RUN`; none produces an
external network write. Add manual publication-package export. Browser-assisted
and API implementations remain disabled until evidence-backed account
capability is configured.

Worker behavior:

- Fair tenant-aware outbox claims with leases and `SKIP LOCKED`.
- Inbox/idempotency deduplication.
- Stable attempt identity and bounded exponential retry.
- `UNCERTAIN -> RECONCILING` for request/response ambiguity.
- Global/tenant/platform/account/campaign/topic quotas and kill switches.
- Automatic open/half-open/closed circuit breakers.
- Post-publication readback jobs and negative-signal pause.
- Immutable attempts, receipts, evidence hashes, and audit-log entries.

Tests run concurrent consumers, expired leases, duplicate events, ambiguous
responses, capability downgrades, circuit trips, and all three dry-run receipts.

Verification:

```powershell
pnpm --filter @geo/connectors test
pnpm --filter @geo/worker test
```

## Phase 6: Pi Agent and MCP

Create `packages/agent` and `apps/agent-mcp`.

Pin:

- `@mariozechner/pi-agent-core@0.73.1`
- `@mariozechner/pi-ai@0.73.1`
- `typebox@1.1.24`
- `@modelcontextprotocol/sdk@1.29.0`
- compatible Zod 4

Pi tools are static, TypeBox-backed, sequential where state changes, and call
the authenticated application API. Exposed actions include tenant context,
fact/evidence lookup, draft proposal, variant preview, audit request,
publication request, and visibility-run request. Pi never receives database,
browser, connector, grant-issuance, or arbitrary HTTP tools.

Connect the Plastic Promise Streamable HTTP endpoint through a separate static
allowlist for `context_supply`, `audit_pre_check`, and `defense`. Validate tenant,
principal, resource scope, argument semantics, and destination before every
call. Convert MCP `isError` results to failures and redact tokens/details from
agent history.

Expose GEO application tools through an MCP server with authenticated tenant
sessions. Add a fixture model path so the orchestration flow is testable without
external model credentials, while clearly reporting provider mode.

Tests cover tool-schema contracts, MCP errors, redaction, sequential execution,
tenant mismatch, denied arbitrary tools, and the end-to-end draft-to-publication
request path.

Verification:

```powershell
pnpm --filter @geo/agent test
pnpm --filter @geo/agent-mcp test
```

## Phase 7: Doubao and Qwen visibility evaluation

Create `packages/visibility` with adapter contracts for:

- Fixture evidence.
- Manual import of browser-observed evidence.
- Configured official/OpenAI-compatible provider APIs where the exact model and
  search capability are known.

Never infer Google-equivalent search. Every observation records provider,
product surface, model, search mode, locale/geo, prompt-set version, raw answer,
citations, evidence type/hash, extractor version, brand/contact facts,
competitors, sentiment, and harmful errors.

Ship a versioned travel prompt pack covering generic intent, departure city,
senior travelers, first international trip, Sample travel tenant brand/contact queries,
competitor comparisons, and hallucination/negative controls. Repeat samples and
retain blank controls.

Metrics: mention rate, share of voice, citation rate, source diversity, answer
position, contact accuracy, competitor share, harmful error rate, volatility,
and sample count. Automatic publishing pauses on configured harmful thresholds;
it does not increase volume based on a single score.

Verification:

```powershell
pnpm --filter @geo/visibility test
```

## Phase 8: operations console

Create `apps/web` with React, Vite, React Router, TanStack Query, Lucide icons,
and a restrained Chinese operational interface.

Views:

- Login and tenant switcher.
- Overview with capability status, audit blocks, queue health, circuit state,
  publication health, and Doubao/Qwen evidence metrics.
- Customers/brands/contacts/policies/members.
- Campaign and article workspace with platform variants and evidence.
- Audit report and immutable payload/hash comparison.
- Publication queue, attempts, receipts, readback, quotas, and kill switches.
- Visibility query sets, runs, raw answers, citations, contact errors, and
  competitor comparison.
- Settings for platform accounts and connector capability evidence.

Do not use nested cards or a marketing landing page. Controls use icons,
tooltips, tabs, toggles, status labels, and stable responsive dimensions. No
visible copy claims a dry-run or fixture is live.

Use Playwright screenshots at desktop and mobile sizes to verify no overlap,
truncation, blank states, or misleading capability labels.

Verification:

```powershell
pnpm --filter @geo/web test
pnpm --filter @geo/web build
pnpm e2e:web
```

## Phase 9: packaging and end-to-end acceptance

Create:

- `compose.yaml` for PostgreSQL, Redis, MinIO, API, worker, agent-MCP, and web.
- Multi-stage Dockerfiles and health checks.
- `.env.example` with separate development/test/production requirements.
- Database backup/restore and kill-switch runbooks.
- Platform onboarding checklist requiring API/partner evidence.
- Security and threat-model documentation.
- OpenAPI and MCP tool documentation generated from code.

End-to-end acceptance proves:

1. Two tenants cannot read or mutate one another's data.
2. A wrong Sample travel tenant contact fails audit.
3. Corrected content creates a new variant, passes audit, and receives a
   short-lived one-time grant.
4. One idempotent publication request consumes the grant atomically; reuse and
   payload mutation fail.
5. Toutiao, Sohu, and Ctrip dry-run workers produce separate immutable receipts.
6. A configured negative visibility signal opens a circuit and pauses matching
   unattended publication work.
7. Fixture/manual/provider observations are visibly and structurally distinct.
8. API, worker, MCP server, and web console start from documented commands.

Final verification:

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm e2e
git diff --check
git status --short
```

Any test not runnable in this Windows environment is recorded as unverified,
not silently treated as passing. The standard Compose path still ships and is
validated statically; a real PostgreSQL path is mandatory for RLS completion.
