---
status: draft
date: 2026-07-15
topic: governed-editorial-media-production
---

# Editorial and Media Production Exemplar Research

## Research question

Which concrete patterns from the four user-selected references improve a multi-tenant GEO
article and image backend without weakening tenant isolation, evidence provenance, final-payload
auditing, or truthful capability reporting?

Reviewed snapshots:

| Reference                                | Snapshot                    | License boundary                                                          |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `shadowresearch/auto-geo`                | `2ec033d6e91c`              | MIT; retain notice if substantial code is copied                          |
| `spronta/crawlie`                        | `992083f3dc44`              | MIT in repository LICENSE/README; inspect bundled dependencies separately |
| `syntropicsignal-ai/ai-visibility-audit` | `61ca447bd4e1`              | AGPL-3.0; clean-room ideas only for this proprietary service              |
| Zac Smith Medium article                 | 2026-07-07 article snapshot | Commentary; no reusable code license was identified                       |

The Medium body was member-truncated. Its visible thesis was checked against official Google
Search documentation rather than reconstructing or copying the author's skill.

## Auto-GEO

### What exactly does it do?

Auto-GEO separates readiness, generation, repair, measurement, and history:

- `cli/doctor.ts:21-28,184-199` runs a fixed check set, computes pass percentage, emits top
  fixes, and gives stable exit semantics. A score is a readiness report, not a citation result.
- `cli/schema.ts:246-269` defines image blocks structurally; `cli/schema.ts:293-349` applies
  strict word-count and promotional-language checks to answer capsules and FAQ entries.
- `cli/fix.ts:57-84,254-266` defaults to two repair retries and performs a final canonical
  schema parse even after provider-level validation.
- `cli/history.ts:22-32,114-161` saves check runs, compares only like-for-like engines, and
  reports newly cited and lost queries.
- CLI modules keep structured JSON outcomes separate from terminal formatting and file
  rendering.

### How does this project differ?

Auto-GEO is a local CLI that can ask a model to rewrite copy. This SaaS has tenant-owned
facts, contacts, policies, RLS, immutable audits, publication grants, workers, and three
platform variants. Model output cannot become final factual copy merely because it passes a
shape schema. The target answer systems are Doubao and Qwen, so Google-oriented heuristics
cannot be treated as provider facts.

### Adapt, redesign, or skip

Adapt:

- `doctor -> propose -> check -> history` becomes research/readiness, blueprint/render,
  final-payload audit, and visibility history.
- Stable structured outcomes, dry-run labels, cost/capability truth, bounded repair, and final
  schema revalidation.

Redesign:

- A `ContentBlueprint` selects only policy keys and verified fact/contact IDs.
- Repair can change structure or selection but cannot invent a fact, relax a hard finding, or
  loop beyond the policy limit.

Skip as hard policy:

- Forty-to-sixty-word capsules, question-form H2s, FAQ schema, entity-density bands, image
  cadence, and claimed citation-uplift percentages. They remain versioned experiments because
  the repository does not establish them as universal Google, Doubao, or Qwen requirements.

## Crawlie

### What exactly does it do?

Crawlie provides a bounded, evidence-first collection engine:

- `crates/crawlie-core/src/crawler.rs:368-567` resolves host, client, robots, sitemap, page cap,
  and concurrency before the fetch loop.
- `crawler.rs:649-737` enforces concurrency, max pages, max body bytes, depth, host policy, and
  robots decisions during traversal.
- `crawler.rs:571-589` treats sitemap protocol limits as explicit issues.
- `crates/crawlie-core/src/pagestore.rs:1-10,145-181` streams every fetched page into SQLite
  with compact indexed columns and a full serialized blob rather than retaining the crawl in
  memory.
- `pagestore.rs:264-287,368-434` derives exact/near duplicates and cross-page analysis from the
  stored artifact, then streams pages back for audit.
- The core, CLI, desktop, and MCP crates are separate consumers of the same engine.

### How does this project differ?

The GEO SaaS already has a controlled research collector, PostgreSQL truth source, tenant
source policies, raw HTML/robots evidence, and a static Pi/MCP tool surface. It must defend
against SSRF and tenant leakage, not crawl arbitrary operator URLs. Image production also
needs binary storage and rights evidence, which Crawlie does not provide.

### Adapt, redesign, or skip

Adapt:

- Persist immutable source evidence once, then compute gaps, diffs, facts, and audit inputs
  from that evidence.
- Resolve every crawl limit and destination policy before network I/O.
- Keep research core independent from HTTP and MCP adapters.

Redesign:

- Use exact HTTPS host allowlists, DNS/private-address rejection, redirect revalidation, and
  tenant RLS already present in `@geo/research` and migration `0013`.
- Bind captured evidence to `VerifiedFactPack` and only load sources referenced by the final
  payload into the audit snapshot.

Skip:

- Arbitrary user URLs and generic site-wide crawling through Pi. Pi may reference only a
  tenant-owned source policy and origin-relative path.

## AI Visibility Audit

### What exactly does it do?

This source was inspected only to document public behavior; no implementation is reused:

- `api/app/providers/base.py:14-47,91-106` defines immutable geo context, a normalized provider
  response, and an asynchronous provider interface.
- `base.py:50-87` assigns stable error kinds for auth, model, rate-limit, API, malformed, and
  empty-result failures.
- `api/app/services/metrics.py:23-58` separates empty metrics from aggregate visibility and
  citation rates.
- `metrics.py:58-124` derives sentiment and competitor-oriented recommendations from persisted
  analyses rather than from a single readiness score.
- Provider-specific modules preserve raw response, citation/search data, and geographic
  context behind the common contract.

### How does this project differ?

The source is AGPL-3.0 and cannot be copied or linked into a closed commercial SaaS without
accepting the applicable source-availability obligations. This project already has its own
TypeScript contracts, adapters, raw evidence model, evaluator versioning, multi-tenant RLS,
and Doubao/Qwen truth labels.

### Adapt, redesign, or skip

Adapt by clean-room reimplementation:

- Provider-neutral observation contracts, independent error budgets, raw response/citation
  retention, geo/model/search-mode identity, sentiment, competitor share, and time series.

Redesign:

- Keep fixture, manual observation, browser evidence, and official API evidence as separate
  source types. Never infer a search capability from a product or model name.

Skip:

- Source, prompts, schemas, UI structure, database migrations, and provider implementation from
  the AGPL repository.

## Medium thesis and official Google guidance

### What exactly does it claim?

The accessible article thesis is that official search guidance can be encoded as a versioned
AI SEO skill instead of remaining an informal checklist. It does not provide a licensed,
production image provenance system.

Official Google guidance confirms:

- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
  do not require special AI files, special schema, or extra technical requirements beyond
  ordinary Search eligibility and controls.
- [Helpful content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
  remains user-first rather than search-engine-first.
- [Spam policies](https://developers.google.com/search/docs/essentials/spam-policies#scaled-content)
  identify scaled content created mainly to manipulate rankings without added value as abuse.
- [Image SEO guidance](https://developers.google.com/search/docs/appearance/google-images)
  supports visible textual context, relevant high-quality images, and descriptive metadata;
  it does not supply generated-image truth or license provenance.

### How does this project differ?

Google indexing is neither Doubao nor Qwen retrieval. This system also controls article
generation, media bytes, publication payloads, and downstream measurement, so it must govern
the full chain rather than only site markup.

### Adapt, redesign, or skip

Adapt:

- Make each rule versioned and traceable to official guidance, documented platform behavior,
  domestic-engine observation, or internal experiment.

Redesign:

- Run final-payload and media audits immediately before grant issuance, then measure Doubao and
  Qwen outcomes independently with repeated observations and controls.

Skip:

- Any promise that ordinary Google ranking, one schema type, one answer length, or one GEO
  score predicts domestic answer-engine visibility.

## Combined implementation pattern

```text
bounded research evidence
  -> VerifiedFactPack
  -> ContentBlueprint
  -> five-profile canonical source
  -> VisualBrief
  -> durable provider-neutral media job
  -> immutable bytes, rights, attempts, and inspections
  -> platform-specific article/media rendition
  -> deterministic final-payload audit and grant
  -> dry-run/manual delivery truth
  -> repeated Doubao/Qwen observation and history
```

Hard constraints use schema and deterministic rules. Quality heuristics generate warnings or
bounded repair requests. Real visibility measurements remain separate from readiness. No
model score can waive tenant, source, contact, license, duplicate, hash, or capability blocks.

## Integration map

| Pattern                    | Integration point                              | Estimated increment             | Gate                                      |
| -------------------------- | ---------------------------------------------- | ------------------------------- | ----------------------------------------- |
| Five editorial profiles    | `@geo/core`, Agent HTTP client, API validation | 4-6 focused files plus tests    | Always enabled                            |
| Rule evidence class        | audit policy document and compiled policy      | 2-4 files plus migration path   | Active policy hash                        |
| Controlled research wiring | API/repository and static MCP tool             | 4-6 files plus tests            | Tenant source policy                      |
| Media job/provider SPI     | new media core plus API repository             | 6-10 files plus migration/tests | `GEO_MEDIA_PROVIDER=fixture` initially    |
| Content-addressed bytes    | `MediaObjectStore`                             | 2-4 files plus tests            | Overwrite disabled                        |
| Real image provider        | provider adapter and config                    | Not in this increment           | `GEO_MEDIA_LIVE_ENABLED=false` by default |
| Visual inspection          | immutable inspection record and audit input    | 3-5 files plus tests            | Required policy evaluator version         |
| Media package export       | connector manual export                        | 2-3 files plus tests            | Exact asset hash match                    |

## Quality review

- Every adopted pattern cites a source file or official document.
- Marketing-style percentages and structural recipes are explicitly experimental.
- AGPL code is excluded from the implementation boundary.
- The design reuses existing research, audit, RLS, outbox, and static MCP architecture rather
  than introducing a duplicate crawler or authorization service.
- Fixture, dry-run, manual, browser-observed, official API, and live provider states remain
  distinguishable in contracts and evidence.
- Image generation, rights, object storage, and cross-modal inspection are identified as a
  new domain because none of the references implements that production chain.
