---
status: accepted
date: 2026-07-13
topic: geo-agent-publishing
---

# GEO agent and publishing engineering patterns

## Decision summary

The MVP will use a TypeScript modular monolith with separate API, worker, web,
and agent/MCP processes. Pi is an orchestration runtime only. Deterministic
domain services own audit verdicts, grant issuance, idempotency, publication,
and circuit breakers.

No target platform currently has enough public evidence to classify its article
publisher as a supported public API. Toutiao, Sohu, and Ctrip Community start as
`DRY_RUN`, `MANUAL_ONLY`, or explicitly authorized `BROWSER_ASSISTED`
capabilities. `UNATTENDED` requires a documented public or partner API.

## Exemplars and three-question analysis

### Pi Agent and MCP

Sources:

- [Pi Agent v0.73.1 README](https://github.com/badlogic/pi-mono/blob/v0.73.1/packages/agent/README.md)
- [Pi Coding Agent v0.73.1 README](https://github.com/badlogic/pi-mono/blob/v0.73.1/packages/coding-agent/README.md)
- [MCP TypeScript SDK v1.29.0](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.29.0)
- npm registry metadata checked on 2026-07-13

Problem solved: `@mariozechner/pi-agent-core` provides model/tool orchestration,
state, transport abstraction, and lifecycle hooks without importing a coding
agent's shell and filesystem powers. The MCP SDK supplies a supported client for
Plastic Promise and a server for GEO application tools.

Core pattern: pin `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and
`typebox` to `0.73.1`, and `@modelcontextprotocol/sdk` to `1.29.0`. Pi does not
ship MCP integration. A narrow bridge converts explicitly selected MCP calls
into TypeBox-backed `AgentTool` definitions. Governance and state-changing
tools execute sequentially and pass through tenant/scope authorization before
each call. `isError` MCP results become tool failures and all details are
redacted before entering agent history.

Not directly reusable: `@mariozechner/pi-coding-agent` includes general-purpose
file, shell, extension, and session behavior that the SaaS runtime neither needs
nor should expose. Dynamic conversion of every discovered MCP schema is also
out of scope for MVP because schema compatibility and authorization semantics
cannot be inferred from tool names alone.

### Crawlie

Source: [spronta/crawlie](https://github.com/spronta/crawlie), repository HEAD
`992083f3dc44584e5145294ad5dfe1b424fa5d6b` observed on 2026-07-13. License:
MIT, as inspected during repository research.

Problem solved: crawl websites and expose crawl, robots, sitemap, structured
data, SEO, and GEO-oriented technical checks through a CLI/MCP surface.

Core pattern: keep collection evidence separate from scoring, preserve source
URLs and crawl metadata, and expose narrow crawl operations as tools.

Not directly reusable: it is not a tenant isolation, publication authorization,
platform connector, or SaaS identity system. Its GEO score cannot authorize a
publication or prove impact on Doubao/Qwen.

### Auto GEO

Source: [shadowresearch/auto-geo](https://github.com/shadowresearch/auto-geo),
repository HEAD `2ec033d6e91ce0a0f768bc1868efca5562a04a68` observed on 2026-07-13.
License: MIT, as inspected during repository research.

Problem solved: provide a local iterative `doctor -> write -> fix -> check ->
history` workflow and structured payloads for improving GEO-oriented pages.

Core pattern: retain the explicit diagnose/generate/fix/verify loop, version
inputs and outputs, and make each transformation inspectable.

Not directly reusable: its file workspace and CLI assumptions do not implement
multi-tenant authorization, an immutable audit artifact, an outbox, or external
publication reconciliation.

### AI Visibility Audit

Source:
[syntropicsignal-ai/ai-visibility-audit](https://github.com/syntropicsignal-ai/ai-visibility-audit),
repository HEAD `61ca447bd4e12232286c801b37877bf7886d542d` observed on 2026-07-13.
License: AGPL-3.0, as inspected during repository research.

Problem solved: organize prompts, runs, raw answers, brands, cited sources, and
analysis for AI visibility measurement.

Core pattern: version query sets, retain raw provider evidence, parse brand and
source observations separately, and calculate aggregate metrics from immutable
runs.

Not directly reusable: the project is closer to a single workspace than a
production tenant model. Its AGPL license also means no source code is copied
into this product without a deliberate licensing decision; only general
architectural ideas are independently implemented.

### Google/Medium AI SEO guidance

The referenced Medium article could not be reliably fetched during research.
It is treated as commentary, not normative evidence. Only claims independently
supported by Google's official documentation are adopted: content must be
crawlable and indexable, structured data must match visible content, content
should be useful and clear, and spam policies still apply. These are web quality
inputs, not a ranking recipe for Doubao or Qwen.

### Multi-tenant transactional publication

Problem solved: prevent cross-tenant access, post-audit mutation, duplicate
external writes, false success receipts, and uncontrolled retry storms.

Core pattern:

- Every business table has `tenant_id NOT NULL`; tenant-local uniqueness and
  references include `tenant_id`.
- PostgreSQL uses `ENABLE` plus `FORCE ROW LEVEL SECURITY`; runtime roles neither
  own tables nor have `BYPASSRLS`.
- Requests use transaction-local tenant/actor settings derived from the
  authenticated membership, not from a caller-provided tenant parameter.
- A `ContentVersion` is a closed reference graph: title/summary/body/tags can
  resolve only through active-policy templates, verified claims, and active
  tenant contacts. Stored final text must equal the deterministic render.
- Variant creation accepts only content-version and account IDs. The server
  derives the platform and renders the platform-specific `PublicationVariant`;
  a client or model cannot submit final variant prose. Audit targets that exact
  final variant and account rather than a generic article.
- A tenant/version/account advisory lock and deterministic payload comparison
  make same-binding retries reuse one variant. Near-duplicate evaluation covers
  cross-platform completed publication history and the same content version's
  draft/frozen siblings, including the first parallel rendering wave.
- The active strict policy document is compiled from its canonical database
  hash. Private process-local `WeakMap` provenance binds audit execution to the
  exact frozen compiler output, so a spread/clone cannot retain authority by
  copying `sourceHash`.
- RFC 8785 canonical JSON and SHA-256 bind payload, facts/evidence, policy
  version, audit artifact, tenant, account, and platform.
- Consuming a short-lived one-time grant, creating the immutable publication
  job, and appending its outbox event happen in one transaction.
- Future external delivery is modeled as at-least-once. Ambiguous responses
  enter `UNCERTAIN` and reconcile before retry; the product never promises
  exactly-once behavior that a platform cannot support. The current connectors
  do not perform external delivery.
- Redis may optimize limits, but database counters remain the hard fallback.
  Kill switches and circuit breakers exist at global, tenant, platform,
  account, campaign, and topic scopes.

Not directly reusable: a generic queue library cannot supply these invariants.
They belong in the database schema, conditional updates, domain policies, and
concurrency tests.

## Platform capability research

Research date: 2026-07-13.

### Toutiao

First-party surface:
[Toutiao Creator Platform](https://mp.toutiao.com/profile_v4/). No public article
publishing API with a normal developer authorization contract was found. The
official frontend contains RPA recognition telemetry, so unattended browser
automation is a high-risk capability and is not enabled by default.

### Sohu

First-party surface: [Sohu Creator Platform](https://mp.sohu.com/mpfe/v4/). The
site supports content publishing and its current frontend includes login,
mobile verification, Tencent CAPTCHA, and internal post modules. Internal
browser endpoints are not a public API contract. No public article publishing
API with a documented application flow was found.

### Ctrip Community

First-party surface: [Ctrip Open Platform](https://open.ctrip.com/), currently
redirecting to the affiliate platform. Its public material covers affiliate,
commission, and order capabilities and does not establish a Ctrip Community
content publishing API. Creator authentication and automation terms remain
unknown and require an authenticated account review or written partner terms.

## Future connector capability model

This vocabulary describes how a future connector may prove capability; it is
not a declaration that those capabilities exist. In the current MVP, Toutiao,
Sohu, and Ctrip Community are all `MANUAL_ONLY` with `L0 DRY_RUN`. Requests for
`assisted` or `unattended` execution fail with
`422 PUBLICATION_CAPABILITY_UNSUPPORTED` before grant consumption, job creation,
or outbox insertion. There is no live browser worker or external platform
readback path.

Connectors report capability independently of platform name:

```text
PUBLIC_API        documented public authorization and publish contract
PARTNER_API       contract supplied after commercial approval
BROWSER_ASSISTED  isolated human-authenticated session; no CAPTCHA bypass
MANUAL_ONLY       export a complete, audited publication package
DISABLED          policy, risk, or account state forbids external writes
```

Execution levels are:

```text
L0 DRY_RUN       preview, audit package, and simulated receipt only
L1 ASSISTED      human login/challenge handling and explicit final publish step
L2 UNATTENDED    PUBLIC_API or PARTNER_API only, with reconciliation and limits
```

The future connector SPI includes `probeCapabilities`, `validateSession`,
`renderDraft`, `preflight`, `submitDraft`, `publish`, `pollStatus`, `reconcile`,
and `captureEvidence`. Receipts always identify execution level and evidence
type, so a fixture, preview, screenshot, or draft cannot be presented as a live
publication.

## Domestic answer-system measurement

Doubao and Qwen both expose model/agent ecosystems with search or retrieval
capabilities, but that does not make either a Google-compatible ranking system.
Provider, product surface, model, search toggle, locale, geography, prompt-set
version, citations, raw answer, and observation method must be captured for
every run. Repeated samples, competitors, and blank controls are required.

Metrics include brand mention rate, share of voice, citation rate, source
diversity, average answer position, contact accuracy, competitor share,
positive/negative sentiment rates, structured hallucination-finding rate,
harmful error rate, and confidence intervals. Competitor names come from the
tenant's active brand-scoped truth records, not a process-global list. A single
answer or synthetic GEO score cannot directly increase
publication volume; doing so would amplify model variance into repetitive
content.

## Adopted implementation boundaries

1. Start as a modular monolith with `api`, `worker`, `web`, and `agent-mcp`
   processes. Do not introduce Kafka, Temporal, or microservices for MVP.
2. Use PostgreSQL RLS and explicit SQL migrations rather than assuming an ORM
   tenant filter is sufficient.
3. Treat platform automation capability as runtime data with supporting
   evidence, not a compile-time promise.
4. Keep Pi outside the authorization root: it can draft and request operations,
   but cannot issue grants or directly drive publisher browsers.
5. Store travel-specific rules in a versioned domain pack. Core campaign,
   content, audit, publication, and visibility models remain industry-neutral.
6. Keep durable dry-run readback declarations and negative-signal circuit
   breakers in MVP. Add external post-publication readback only with a future
   verified live connector; publication-time audit alone would be insufficient
   for unattended operation.
