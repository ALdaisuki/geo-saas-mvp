# Multi-tenant GEO SaaS MVP Design

Status: accepted for implementation

Date: 2026-07-13

## Product outcome

Build a multi-tenant GEO operations product that can research, create, audit,
schedule, publish, and measure content for multiple customers. Travel is the
first vertical, not a hard-coded product boundary. Sample travel tenant International
Travel Agency is the first seeded tenant.

The first AI visibility targets are Doubao and Qwen. They are measured as
independent answer systems; Google ranking is not used as a proxy for either.

## MVP scope

The MVP includes:

1. Tenant, brand, contact, user, role, platform account, and policy management.
2. Campaigns and versioned article assets for Toutiao, Sohu, and Ctrip Community.
3. A deterministic pre-publication audit with evidence, blocking findings, and
   policy thresholds.
4. A content hash bound, tenant bound, platform bound, single-use, expiring
   `PublicationGrant` created only from a passing audit.
5. A transactional outbox, idempotent publisher worker, platform rate limits,
   receipts, retries, dead-letter handling, and kill switches.
6. Platform connector contracts plus dry-run connectors. Toutiao and Sohu remain
   `manual_only + dry_run`; all `unattended` and non-Ctrip `assisted` requests are
   rejected. A reviewed `browser_assisted` Ctrip account may consume a narrow
   `assisted` grant and create a durable operator handoff after repeated governance
   checks. This does not operate a browser, submit to Ctrip, or provide external
   platform readback; those remain separately gated capabilities.
7. Doubao and Qwen visibility probes with prompt sets, raw response evidence,
   cited sources, brand/contact accuracy, hallucination, and competitor metrics.
8. A Chinese operations console for customer setup, content review, audit,
   publication operations, and visibility reporting.
9. A Pi Agent orchestration service whose tools are exposed through MCP. The
   deterministic audit and publication authorization remain domain services,
   not model decisions.

## Explicit non-goals

- Circumventing platform authentication, CAPTCHAs, anti-bot controls, or terms.
- Claiming a dry-run receipt is a live publication.
- Bulk generation of near-duplicate pages or fabricated reviews, credentials,
  prices, availability, sources, or guarantees.
- Treating a crawl score, search position, or LLM answer as proof of causality.
- Sharing credentials, data, grants, jobs, or evidence across tenants.

## Architecture

Use a pnpm TypeScript monorepo so Pi Agent, MCP tools, API schemas, workers, and
the web console share typed contracts while remaining independently deployable.

```text
apps/web       React operations console
apps/api       HTTP API, auth, tenant context, domain commands and queries
apps/worker    outbox publication and visibility workers
apps/mcp       MCP server exposing governed GEO tools to Pi Agent
packages/db    PostgreSQL schema, migrations, RLS helpers and seed data
packages/core  domain types, state machines, policies and audit engine
packages/agent Pi Agent runtime, prompts and MCP tool bridge
packages/connectors platform connector contracts and implementations
packages/config shared environment validation
```

PostgreSQL is the production truth source. Every tenant-owned table contains a
non-null `tenant_id`. API requests establish tenant context, and PostgreSQL RLS
is the second isolation boundary. Background jobs carry tenant identity in the
signed job payload and establish the same database context before work.

## Current MVP publication flow

```text
draft
  -> content version frozen
  -> canonical references resolve only through active-policy templates, verified facts, and tenant contacts
  -> server renders an account-derived platform variant; clients cannot submit final variant text
  -> audit requested
  -> compare cross-platform publication history and same-version sibling variants
  -> audit pass (report + evidence + content hash)
  -> single-use PublicationGrant issued
  -> grant consumed; publication job and outbox event committed atomically
  -> worker claims job with lease
  -> connector validates account, grant, hash and idempotency key
  -> dry-run preview generated; no external platform write occurs
  -> immutable unconfirmed Preview receipt recorded
  -> durable readback marked not_required / dry_run_preview_only
```

Live delivery and external readback extend this flow only after a documented
public or partner API connector is implemented and verified. A browser session
or enum value alone cannot activate live delivery. The current API hard-rejects
all non-dry-run execution with `422 PUBLICATION_CAPABILITY_UNSUPPORTED` before
any publication side effect.

Any content mutation invalidates prior audits and grants. A grant cannot cross
tenant, asset version, platform, platform account, or policy revision. Expired,
revoked, or consumed grants cannot enqueue another job.

## State models

Content assets: `draft -> ready_for_audit -> audited -> approved -> queued ->
publishing -> published | failed | blocked | withdrawn`.

Audit reports: `running -> passed | failed | errored`. Reports are immutable;
reruns create a new report.

Publication grants: `active -> consumed | expired | revoked`. Consumption is an
atomic compare-and-set operation.

Publication jobs: `pending -> leased -> succeeded | retry_wait | dead_letter |
cancelled`. Retries use a stable idempotency key and bounded exponential delay.

Campaign automation target model: `shadow -> supervised -> unattended -> paused
| stopped`. In the current MVP, the three seeded platforms remain in `shadow`
with dry-run execution. `supervised` and `unattended` describe future live
capabilities and cannot bypass the API hard gate.

## Audit policy

Publishable content uses a closed canonical reference union. Title and summary
blocks may reference only an active-policy template, verified claim, or tenant
contact; body claim/contact blocks additionally declare paragraph or bullet
presentation, and tags reference policy template IDs. The rendered text and
claim/contact metadata must match those references exactly. Legacy free text is
readable for migration but cannot produce a new platform variant or grant.

Variant creation accepts only `contentVersionId` and `channelAccountId`. The
server derives the platform, recompiles the effective active policy with
canonical-hash and exact-object provenance checks, and renders the platform
profile. A tenant/version/account advisory lock makes an identical retry reuse
the deterministic variant. Near-duplicate candidates include completed preview
or confirmed history across platforms plus draft/frozen siblings from the same
content version, covering the parallel first-wave case.

The deterministic audit checks at least:

- Brand name and configured phone/WeChat contact accuracy.
- Required source evidence for factual claims and time-sensitive offers.
- Forbidden guarantees, fabricated qualifications, medical/financial promises,
  and tenant-specific prohibited language.
- Near-duplicate similarity within the tenant and campaign.
- Platform title/body/link/image constraints.
- GEO answer structure: direct answer, scoped details, entity clarity, evidence,
  freshness, and useful next action.
- Disclosure and provenance metadata for generated or materially transformed
  content where policy requires it.

Blocking findings prevent grant issuance. A model may suggest fixes but cannot
waive a deterministic block.

## Automation safety

Unattended publishing is controlled independently per tenant, campaign,
platform, account, and topic. Each scope has quotas, cooldowns, concurrency,
error budgets, and a kill switch. Automatic pause triggers include:

- Incorrect contact details or brand identity.
- Duplicate-content threshold breach.
- Platform authentication or risk-control challenge.
- Elevated rejection/error rates.
- Visibility probes showing harmful misinformation or negative amplification.
- Missing or inconsistent post-publication readback.

Future browser-assisted delivery, if separately implemented and approved, must
run in an isolated worker with an allowlisted origin, encrypted session secret,
bounded navigation, screenshot evidence, redacted logs, and no CAPTCHA bypass.
It is not present in the current MVP. Documented API connectors remain the
preferred prerequisite for any future live capability.

## AI visibility evaluation

Probe suites are versioned per industry and intent. The travel seed suite covers
generic recommendations, location/origin needs, senior-friendly travel, first
international trip guidance, brand facts, contact lookup, competitor comparison,
and negative/hallucination checks.

Each run records provider/model, prompt version, request/response timestamps, raw
answer, citations or source URLs, brand mentions, answer position, contact facts,
competitors, sentiment, hallucination findings, and evaluator version. Metrics
include brand hit rate, contact accuracy, cited-domain share, competitor share,
harmful error rate, indexing/readback latency, and platform publication health.

Provider adapters must distinguish official API responses, browser-observed
responses, and manually imported evidence. They must never label one as another.

## Seed tenant

The seed is versioned data rather than prompt text:

- Legal/display name: Example Travel Services / 示例国际旅行服务
- 24-hour hotline: `4000000001`
- WeChat contacts: `TRAVEL_DEMO_01`, `TRAVEL_DEMO_02`
- Industry: travel
- Default mode: shadow
- Default connectors: dry-run

## Delivery gates

The MVP is complete only when a clean environment can:

1. Start PostgreSQL, API, worker, MCP server, and web console from documented
   commands.
2. Authenticate an operator and demonstrate isolation between two seeded tenants.
3. Create an article, fail a bad-contact audit, pass a corrected audit, issue a
   grant, enqueue once, reject reuse, publish through all three dry-run
   connectors, and persist distinct receipts.
4. Run a versioned Doubao/Qwen probe suite through configured adapters or a
   clearly labeled fixture adapter, then display evidence and metrics.
5. Pause publication automatically when a configured circuit breaker trips.
6. Pass unit, integration, RLS, API, worker idempotency, and browser smoke tests.

Live platform publishing and live Doubao/Qwen calls are not shipped by this MVP.
They require separate connector implementation, external accounts, credentials,
provider availability, and renewed verification. Configuration alone cannot
enable them. The MVP must expose capability status and remain fully testable
without misrepresenting fixture, Preview, dry-run, or `not_required` readback as
external execution evidence.
