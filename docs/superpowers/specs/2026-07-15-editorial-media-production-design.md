# Editorial and Media Production Increment

Status: accepted from the existing product direction and the user's explicit request to
prioritize backend image-and-article production

Date: 2026-07-15

## Outcome

Extend the accepted multi-tenant GEO SaaS design with a production-shaped editorial and
media pipeline. The increment must produce five materially different article structures,
create fact-bound visual briefs, preserve immutable media provenance, and make the final
platform payload the only object that can pass the publication audit.

The first tenant remains Example Travel Services. Travel-specific sample
content is test data, not a product boundary. Toutiao, Sohu, and Ctrip Community remain
`manual_only` and `dry_run`; this increment does not claim live delivery.

## Evidence and license boundary

The implementation uses the following references as design inputs:

- `spronta/crawlie` (MIT): reuse evidence-first collection, explicit crawl policy, and
  reproducible source snapshots. Reviewed at `992083f3dc44`.
- `shadowresearch/auto-geo` (MIT): reuse the diagnose, propose, check, and history workflow
  shape without importing a second application architecture. Reviewed at `2ec033d6e91c`.
- `syntropicsignal-ai/ai-visibility-audit` (AGPL-3.0): independently implement only general
  measurement and audit ideas. Do not copy, adapt, vendor, import, or link its source into
  the proprietary SaaS. Reviewed at `61ca447bd4e1`.
- Zac Smith's Medium article: treat it as commentary. Claims about Google are accepted only
  when independently supported by official Google Search documentation. No special AI SEO
  schema or AI-only text file is assumed; crawlability, visible text, source quality,
  structured-data consistency, and useful images remain ordinary search fundamentals.

Doubao and Qwen continue to be measured as distinct answer systems. Google behavior is not
used as a proxy for either product.

Every audit rule carries an evidence class and source/version reference: official search
guidance, documented platform constraint, domestic-answer-engine observation, or internal
experiment. Experimental heuristics such as ideal answer length, heading form, entity
density, or predicted citation uplift must remain tunable measurements, not universal hard
requirements.

## Approaches considered

### 1. Generate images inside the Pi drafting prompt

This is small but rejected. It has no durable job state, retry boundary, provider truth,
binary hash, license record, or reliable way to invalidate an audit after an image changes.

### 2. Durable provider-neutral media jobs and immutable assets

Selected. Pi can request a bounded operation, while deterministic domain code creates the
visual brief, records the job, calls an allowlisted provider, stores a content-addressed
result, and binds a complete media snapshot into the article payload.

### 3. Separate media microservice

Deferred. It provides isolation but adds deployment, authentication, event, and consistency
work before the single-process API/worker boundary has become a bottleneck. The provider and
object-store interfaces preserve this future option.

## Editorial production

Every canonical source payload declares exactly one editorial profile:

- `guide`
- `question_answer`
- `comparison`
- `risk_avoidance`
- `local_service`

The Agent selects the profile from the brief with deterministic rules and renders the source
payload through the active policy. It must not construct fixed generic title, summary, body,
or tag references. Platform variants retain the selected profile while applying platform
templates. Tests must prove that all five profiles produce different titles, summaries,
body structures, and tags from the same verified fact set without weakening the duplicate
threshold.

Article text remains a closed reference compilation from active-policy templates, verified
facts, and active tenant contacts. A language model may propose a brief or choose among
allowlisted operations, but it cannot insert an unaudited factual sentence into the final
payload.

Structured generation records schema version, model/prompt version, input/output hashes,
warnings, and a bounded repair history. Schema or provenance failures are hard failures;
quality heuristics can request a limited repair but cannot loop indefinitely or relax a
publication block.

`ContentBlueprint` records the selected profile, brief hash, audience/intent keys, ordered
claim IDs, contact IDs, and section plan. It contains controlled identifiers rather than
free-form factual copy. The blueprint makes the planning decision reproducible and prevents
the media prompt from becoming a second, hidden article-generation path.

## Media model

### Visual brief

`VisualBrief` is a deterministic, versioned object derived from:

- tenant and source content version;
- editorial profile and image role (`cover` or `inline`);
- one target aspect ratio;
- an ordered, non-empty set of verified fact IDs;
- bounded style directives that do not add factual claims.

The prompt, negative prompt, alt text, and caption are rendered from those inputs. Generated
pixels must not contain phone numbers, WeChat IDs, prices, credentials, guarantees, or body
copy. Sample travel tenant contact values stay in canonical article text, where exact matching is
auditable.

### Generation provider

`ImageGenerationProvider` is a narrow interface that reports provider ID, model, execution
mode, input hash, output bytes, MIME type, dimensions, and provider metadata. The MVP ships a
clearly labeled deterministic fixture provider. Real providers remain disabled until their
credentials, capability contract, data handling, and output rights are configured and
verified. A fixture result must never be labeled as a live provider result.

### Immutable media asset

Each successful output creates one immutable `MediaAsset` containing:

- tenant, source content version, job, role, and intended platform/rendition;
- source class (`generated`, `licensed_stock`, or `tenant_owned`);
- SHA-256, MIME type, dimensions, and content-addressed storage key;
- alt text, caption, visual brief, visual brief hash, and ordered verified fact IDs;
- provider, model, execution mode, prompt, prompt hash, parameters hash, and generation time
  for generated assets;
- source URL, rights basis, license name/URL, attribution, and verification time where
  applicable.

Media rows and their fact bindings are append-only. Replacement creates a new asset and a new
content version. The canonical payload carries a complete immutable media reference, so the
payload hash changes when the bytes, crop, metadata, prompt, rights, or fact binding changes.

Generation jobs and attempts are separate append-oriented records. A job owns idempotency,
state, lease, retry, and kill-switch decisions; each attempt records the exact provider/model,
request/response hashes, provider request ID, timing, and failure. `ContentMediaBinding`
records ordered cover/inline placement and canonical alt/caption blocks. `MediaInspection`
records immutable OCR and visual-review evidence bound to one exact asset hash.

Object bytes are stored through a `MediaObjectStore` under content-addressed keys with
overwrite disabled. Database immutability alone is insufficient if a storage key can later
resolve to different bytes.

## Data flow

```text
verified facts + active contacts + active policy
  -> ContentBlueprint -> editorial source payload
  -> VisualBrief (closed fact references)
  -> ImageGenerationJob (idempotent, durable)
  -> allowlisted provider
  -> content-addressed bytes + immutable MediaAsset
  -> new content version containing MediaReference
  -> platform renderer selects the platform rendition
  -> deterministic final-payload audit
  -> single-use PublicationGrant
  -> existing dry-run/manual publication flow
```

The first implementation may process the fixture provider synchronously through the same
service used by a future worker. Job state and idempotency remain durable so moving execution
to the worker does not change the contract.

## Audit contract

The hard publication audit validates, at minimum:

1. Media IDs and hashes are unique and structurally valid.
2. Every media fact ID is present in both the final payload claims and the captured verified
   fact snapshot.
3. Alt text, caption, prompt, prompt hash, and visual brief hash match deterministic rendering.
4. Generated assets contain provider/model/mode and generated-rights provenance; stock assets
   contain an HTTPS source and verified license; tenant-owned assets contain a rights basis.
5. The selected platform has an explicit rendition with allowed MIME type and dimensions.
6. Any required visual review artifact is present, current, bound to the exact media SHA, and
   passed by an allowlisted evaluator version.

A vision model can flag an image that appears to depict the wrong place, person, logo, text,
or unsafe claim. Its assessment is immutable evidence, not a waiver. Policy deterministically
blocks publication when required review is missing, stale, mismatched, or failed. The system
does not claim that deterministic metadata checks alone prove pixel-level truth.

Audit v2 records explicit brand, fact/source, and media snapshot hashes in addition to the
final payload and policy hashes. The media hash is also transitively present in the payload,
but the explicit snapshot hash makes provenance inspection and incident analysis direct.
Only facts and sources referenced by the payload enter the closed audit snapshot. Any media
mutation invalidates the artifact and its grant without a second invalidation mechanism.

## API and Pi/MCP surface

Backend routes provide:

- create/list/get media generation jobs;
- list/get immutable media assets;
- create a media-backed successor content version;
- report provider capability truth and fixture/live mode.

The existing controlled research collector is wired through tenant source policies so new
facts can retain crawl evidence. It must not reopen arbitrary URL fetching. Manual publication
packages gain a media manifest and exact-byte attachments; a text-only export cannot be
reported as a complete image-and-article package.

Pi receives only static, tenant-scoped tools for requesting a visual brief/job and reading its
result. It receives no arbitrary HTTP, object-store, provider-credential, file-system, or
browser tool. Publication remains a separate governed request and cannot be triggered by the
image provider.

## Failure handling

- Invalid or unverified fact references fail before a job is created.
- Reusing an idempotency key with a different request hash returns a conflict.
- Provider timeout or invalid bytes marks the job failed without creating an asset.
- Object-store failure does not create a successful asset or successor content version.
- Missing license/provenance, unsupported rendition, or failed visual review blocks audit.
- Kill switches and paused/stopped automation prevent both article and media generation.

## Verification

Focused tests must prove:

- five briefs map to and render five distinct editorial profiles;
- all three platform variants retain the profile and verified facts;
- a fixture job is deterministic, idempotent, tenant-scoped, and clearly labeled;
- media provenance and fact binding are immutable and included in the payload hash;
- prompt/alt/caption tampering, unknown facts, bad licenses, mismatched hashes, missing review,
  and wrong-platform renditions fail the audit;
- changing one media byte or crop prevents reuse of an old audit/grant;
- API and MCP reject cross-tenant IDs and arbitrary provider/tool names;
- representative Sample travel tenant samples contain only the configured hotline and WeChat contacts.

Run package tests, type checks, PostgreSQL integration, backend E2E, web E2E, build, and
`git diff --check`. Docker Compose remains a separate environment verification when Docker is
available.

## Explicit non-goals

- Live publishing to Toutiao, Sohu, or Ctrip Community.
- CAPTCHA, anti-bot, browser-session, or platform-policy bypass.
- Claiming a fixture image is a real provider result.
- Generating testimonial faces, fake documents, credentials, tickets, prices, or contact text.
- Letting a vision model waive a deterministic provenance, license, contact, or fact block.
- Copying AGPL implementation code into the proprietary service.
