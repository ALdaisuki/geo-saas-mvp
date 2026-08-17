# Editorial and Media Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the five-profile article pipeline and add a tenant-scoped, fact-bound,
provider-neutral media production backend whose immutable provenance is part of the final
publication audit.

**Architecture:** Canonical article and media planning stay in pure TypeScript domain code.
`@geo/media` owns provider and content-addressed object-store interfaces; the API owns durable
job orchestration and PostgreSQL persistence. Pi receives two static media tools, while final
platform variants, deterministic audits, single-use grants, and dry-run connectors retain
their existing authority boundaries.

**Tech Stack:** Node.js 24, TypeScript 6, Zod 4, Fastify, Kysely/PostgreSQL 18, MCP SDK 1.29,
Vitest, pnpm 10.

## Global Constraints

- Work only in `D:\GEO\.worktrees\geo-saas-mvp` on `codex/geo-saas-mvp`.
- The Plastic Promise service runs only from `F:\Agent\Memory system`; do not modify that
  repository while implementing GEO.
- Every tenant-owned row, object key, API route, and MCP call carries tenant scope.
- Toutiao, Sohu, and Ctrip Community remain `manual_only + dry_run`.
- Fixture media is always labeled `fixture`; real providers remain disabled by default.
- Pi cannot choose arbitrary URLs, prompts, providers, object keys, browsers, grants, or
  connector operations.
- Phone and WeChat values are never rendered into generated pixels.
- Final platform payload changes, including media metadata or bytes, invalidate prior audits
  and grants through the canonical payload hash.
- Keep duplicate threshold `0.86`; production scale does not justify near-duplicate content.
- Do not copy or link AGPL implementation code from `ai-visibility-audit`.

---

### Task 1: Complete the five-profile editorial data flow

**Files:**

- Modify: `apps/agent-mcp/src/http-api-client.ts`
- Modify: `apps/agent-mcp/src/http-api-client.test.ts`
- Modify: `packages/core/src/platform-variant.test.ts`
- Create: `packages/core/src/editorial-profile.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`

**Interfaces:**

- Consumes: `editorialProfileForBrief(brief)` and `renderEditorialSourcePayload(input)` from
  `@geo/core`.
- Produces: source payloads where `payload.editorialProfile === contentType` and 15 distinct
  profile/platform renderings.

- [ ] **Step 1: Replace old fixtures with failing profile-aware expectations**

Use this source helper in Core tests:

```ts
function sourcePayload(profile: EditorialProfile = "guide"): PublicationVariantPayload {
  return renderEditorialSourcePayload({
    editorialProfile: profile,
    policy: policy(),
    factSnapshot: snapshot,
    contacts,
  });
}
```

Add a table test for the five representative briefs:

```ts
const cases = [
  ["日本签证材料办理指南", "guide"],
  ["签证材料怎么准备？", "question_answer"],
  ["跟团游与自由行对比", "comparison"],
  ["低价团避坑与风险提醒", "risk_avoidance"],
  ["上海旅行社电话微信咨询", "local_service"],
] as const;
```

- [ ] **Step 2: Run focused tests and record the expected failures**

Run:

```powershell
pnpm --filter @geo/core test
pnpm --filter @geo/agent-mcp test -- --run src/http-api-client.test.ts
pnpm --filter @geo/api test -- --run src/app.test.ts
```

Expected before implementation: Core platform fixtures fail for missing profile; Agent/API
expect old `generic.*` templates.

- [ ] **Step 3: Wire one profile decision through the Agent draft request**

In `proposeDraft()` construct the snapshot first, then use one value for both fields:

```ts
const editorialProfile = editorialProfileForBrief(input.brief);
const payload = renderEditorialSourcePayload({
  editorialProfile,
  policy,
  factSnapshot,
  contacts: currentContacts as readonly TenantContact[],
});
// POST body
contentType: editorialProfile,
payload,
```

Delete the duplicated `contentTypeForBrief()` classifier and the old hand-built generic
canonical payload.

- [ ] **Step 4: Enforce API content type/profile consistency**

Refine `contentSchema` so new non-`evidence` records must declare a profile equal to
`contentType`. Legacy reads remain supported because `publicationVariantPayloadSchema` keeps
`editorialProfile` optional.

- [ ] **Step 5: Prove 5 x 3 distinct output without threshold relaxation**

Assert 15 unique `(title, bodyMarkdown, tags)` hashes, unchanged facts/contacts, and the
existing `DEFAULT_AUDIT_POLICY.duplicateThreshold === 0.86`.

- [ ] **Step 6: Run and commit the editorial increment**

Run the three focused commands from Step 2 plus `pnpm --filter @geo/core typecheck` and
`pnpm --filter @geo/agent-mcp typecheck`. Commit:

```powershell
git add apps/agent-mcp/src/http-api-client.ts apps/agent-mcp/src/http-api-client.test.ts `
  apps/api/src/app.ts apps/api/src/app.test.ts packages/core/src/editorial-profile.test.ts `
  packages/core/src/platform-variant.test.ts
git commit -m "feat: complete five-profile editorial production"
```

### Task 2: Define strict media and visual-brief contracts

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/index.test.ts`
- Create: `packages/core/src/media-production.ts`
- Create: `packages/core/src/media-production.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Produces: `VisualBrief`, `MediaReference`, `MediaInspectionReference`,
  `buildVisualBrief()`, `verifyVisualBrief()`, and `mediaSnapshotHash()`.
- Consumed by: platform renderer, audit, provider package, API service, and PostgreSQL
  repository.

- [ ] **Step 1: Add failing strict-schema tests**

Cover generated, licensed-stock, and tenant-owned provenance; unique non-empty fact IDs;
HTTPS license/source URLs; positive byte/dimension values; prompt/hash pairing; exact
inspection asset hash; unknown-key rejection.

The core shape is:

```ts
interface VisualBrief {
  schemaVersion: "geo.visual-brief.v1";
  editorialProfile: EditorialProfile;
  platform: Platform;
  role: "cover" | "inline";
  aspectRatio: "1:1" | "4:3" | "16:9";
  factIds: readonly string[];
  prompt: string;
  negativePrompt: string;
  altText: string;
  caption: string;
}
```

`MediaReference` contains ID, SHA-256, MIME type, byte length, dimensions, platform, role,
alt/caption, ordered fact IDs, full visual brief/hash, rights snapshot, source-specific
provenance, and inspection evidence.

- [ ] **Step 2: Implement deterministic brief rendering from verified facts**

`buildVisualBrief()` accepts only editorial profile, platform, role, and ordered verified
facts. It renders contact-free prompt/negative prompt/alt/caption. It rejects zero facts,
duplicates, unsupported platforms, and fact text containing no usable characters.

The negative prompt always includes:

```text
文字、水印、二维码、电话号码、微信号、价格、证件、夸张承诺、虚构人物背书
```

- [ ] **Step 3: Add canonical verification helpers**

`verifyVisualBrief()` rebuilds the brief from the audit snapshot and returns deterministic
issue IDs rather than a model score. `mediaSnapshotHash(media)` hashes a stable sort by
`platform`, `role`, and media ID.

- [ ] **Step 4: Run and commit contracts/core media domain**

```powershell
pnpm --filter @geo/contracts test
pnpm --filter @geo/contracts typecheck
pnpm --filter @geo/core test -- --run src/media-production.test.ts
pnpm --filter @geo/core typecheck
git add packages/contracts/src packages/core/src
git commit -m "feat: add fact-bound media production contracts"
```

### Task 3: Add provider-neutral generation and immutable object storage

**Files:**

- Create: `packages/media/package.json`
- Create: `packages/media/tsconfig.json`
- Create: `packages/media/tsconfig.typecheck.json`
- Create: `packages/media/vitest.config.ts`
- Create: `packages/media/src/types.ts`
- Create: `packages/media/src/fixture-provider.ts`
- Create: `packages/media/src/content-addressed-store.ts`
- Create: `packages/media/src/index.ts`
- Create: `packages/media/src/media.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

```ts
interface ImageGenerationProvider {
  readonly descriptor: {
    readonly id: string;
    readonly mode: "fixture" | "live";
    readonly model: string;
  };
  generate(input: ImageGenerationRequest): Promise<ImageGenerationResult>;
}

interface MediaObjectStore {
  put(input: {
    tenantId: string;
    sha256: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<{ storageKey: string; byteLength: number }>;
  get(input: { tenantId: string; storageKey: string }): Promise<Uint8Array>;
}
```

- [ ] **Step 1: Write provider/store failure tests**

Test deterministic fixture bytes, valid PNG dimensions, mismatched expected hash, invalid
MIME, timeout propagation, traversal-resistant object keys, no overwrite, same-hash replay,
and cross-tenant reads.

- [ ] **Step 2: Implement deterministic fixture PNG output**

Generate a valid solid-color PNG with dimensions selected from the brief (`1280x720` for
`16:9`, `1200x900` for `4:3`, `1024x1024` for `1:1`). Provider metadata is exactly
`fixture / fixture-png-v1`; no external network call occurs.

- [ ] **Step 3: Implement content-addressed filesystem storage**

Use `<root>/<tenant UUID>/<sha[0..2]>/<sha>.<ext>`, `wx` creation, and byte comparison on
replay. Never accept a caller-supplied path. Reject a read when the recomputed SHA differs.

- [ ] **Step 4: Keep real providers disabled**

The package exports no live adapter. Config validation added later accepts fixture only unless
both an implemented provider and explicit live capability flag exist.

- [ ] **Step 5: Run and commit**

```powershell
pnpm install --lockfile-only
pnpm --filter @geo/media test
pnpm --filter @geo/media typecheck
git add packages/media pnpm-lock.yaml
git commit -m "feat: add deterministic media provider and object store"
```

### Task 4: Make platform rendering and audit media-aware

**Files:**

- Modify: `packages/core/src/platform-variant.ts`
- Modify: `packages/core/src/platform-variant.test.ts`
- Modify: `packages/core/src/audit.ts`
- Modify: `packages/core/src/audit.test.ts`
- Modify: `packages/core/src/grant.test.ts`
- Modify: `packages/core/src/audit-policy-document.ts`
- Modify: `packages/core/src/audit-policy-document.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/index.test.ts`

**Interfaces:**

- Consumes: strict `MediaReference[]`, `verifyVisualBrief()`, and `mediaSnapshotHash()`.
- Produces: platform variants containing only media for that exact platform and audit findings
  bound to the exact bytes/provenance/inspection snapshot.

- [ ] **Step 1: Add failing platform-selection and audit tests**

Create one cover reference per platform. Assert that each final variant contains only its
platform asset. Add blocking tests for unknown fact IDs, tampered prompt/alt/caption/hash,
bad license, wrong platform, missing or failed inspection, OCR contact text, and duplicate
media IDs.

- [ ] **Step 2: Preserve media through canonical source validation**

Remove the `sourcePayload.media.length === 0` invariant. Validate each source reference once,
then filter with:

```ts
media: input.sourcePayload.media.filter((item) => item.platform === input.platform),
```

- [ ] **Step 3: Replace `content.media.unsupported` with deterministic findings**

The audit uses exact fact IDs and hashes. OCR text containing an approved phone/WeChat still
blocks because contact text in generated pixels is prohibited by policy, not merely checked
for correctness.

- [ ] **Step 4: Add explicit brand and media snapshot hashes to the audit artifact contract**

Extend `AuditEvaluation`/`AuditArtifact` and canonical hash computation with
`brandSnapshotHash` and `mediaSnapshotHash`. A brand snapshot contains the audited brand ID,
canonical/display names, and aliases. Existing empty-media artifacts use the canonical
empty-array hash.

- [ ] **Step 5: Prove media mutation invalidates a grant**

Issue an artifact/grant for one media SHA, change one byte/hash in the payload, and assert
artifact integrity or grant validation fails before publication enqueue.

- [ ] **Step 6: Run and commit**

```powershell
pnpm --filter @geo/core test
pnpm --filter @geo/core typecheck
git add packages/core/src
git commit -m "feat: audit immutable platform media provenance"
```

### Task 5: Persist media jobs, attempts, assets, bindings, and inspections

**Files:**

- Create: `packages/db/migrations/0014_media_production_governance.sql`
- Modify: `packages/db/src/types.ts`
- Modify: `packages/db/tests/migration-contract.test.ts`
- Modify: `packages/db/tests/postgres.integration.test.ts`
- Modify: `apps/api/src/repository.ts`
- Modify: `apps/api/src/postgres-repository.ts`
- Modify: `apps/api/src/postgres-repository.test.ts`

**Interfaces:**

- Produces repository methods `createMediaJob`, `getMediaJob`, `recordMediaAttempt`,
  `completeMediaJob`, `failMediaJob`, `listMediaAssets`, and `getMediaAsset`.
- `completeMediaJob` atomically inserts immutable metadata/bindings/inspection and a successor
  content version containing the media reference. Object bytes are written before this
  transaction and may be safely orphaned by hash if the transaction fails.
- `loadAuditContext` produces closed brand, fact/source, and media snapshots rather than
  loading every tenant evidence record.

- [ ] **Step 1: Write migration contract tests**

Require `media_generation_jobs`, `media_generation_attempts`, hardened `media_assets`,
`content_media_bindings`, and `media_inspections`; tenant composite FKs; forced RLS; append-only
triggers; no runtime UPDATE/DELETE on immutable tables; and idempotency uniqueness.

- [ ] **Step 2: Write PostgreSQL behavior tests**

Prove cross-tenant denial, same-key/same-hash replay, same-key/different-hash conflict, job
state transitions, append-only attempts/assets/inspections, same bytes with different rights
snapshots, and successor-version creation without mutating the source version.

- [ ] **Step 3: Implement migration and Kysely table types**

Existing media rows migrate to a `legacy` database source class and remain unpublishable.
Remove the old `(tenant_id, sha256)` uniqueness because rights snapshots are distinct; use a
provenance-hash uniqueness key instead.

- [ ] **Step 4: Implement in-memory and PostgreSQL repository parity**

Keep idempotency and transition checks in both implementations. Load only facts, evidence
sources, media, and inspections referenced by the final payload when building audit context.

- [ ] **Step 5: Run and commit**

```powershell
pnpm --filter @geo/db test
pnpm --filter @geo/db typecheck
pnpm --filter @geo/db test:integration
pnpm --filter @geo/api test -- --run src/postgres-repository.test.ts
git add packages/db apps/api/src/repository.ts apps/api/src/postgres-repository.ts `
  apps/api/src/postgres-repository.test.ts
git commit -m "feat: persist governed media production jobs"
```

### Task 6: Expose bounded API and Pi/MCP media operations

**Files:**

- Create: `apps/api/src/media-production-service.ts`
- Create: `apps/api/src/media-production-service.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/app.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `packages/config/src/index.ts`
- Modify: `packages/config/src/index.test.ts`
- Modify: `.env.example`
- Modify: `apps/agent-mcp/src/api-client.ts`
- Modify: `apps/agent-mcp/src/http-api-client.ts`
- Modify: `apps/agent-mcp/src/http-api-client.test.ts`
- Modify: `apps/agent-mcp/src/tool-specs.ts`
- Modify: `apps/agent-mcp/src/handlers.ts`
- Modify: `apps/agent-mcp/src/agent-mcp.test.ts`
- Modify: `packages/agent/src/pi-tools.ts`

**Interfaces:**

- API: `POST /api/content-versions/:id/media-jobs`, `GET /api/media-jobs/:id`,
  `GET /api/media-assets?contentVersionId=<uuid>`.
- MCP: `geo_media_production_request` and `geo_media_job_status` only.

- [ ] **Step 1: Add failing API/MCP authorization tests**

Prove capability checks, tenant scope, Kill Switch, verified claim membership, no arbitrary
provider/prompt/URL/object key, idempotency conflict, fixture truth label, and read-only status.

- [ ] **Step 2: Implement `MediaProductionService` orchestration**

The request body accepts only:

```ts
{
  platform: "toutiao" | "sohu" | "ctrip_community";
  role: "cover" | "inline";
  claimIds: string[];
  idempotencyKey: string;
}
```

The service loads the source payload/profile and verified facts, builds the brief, creates the
job, invokes the configured fixture provider, stores bytes, records the attempt/inspection,
and creates the successor content version.

- [ ] **Step 3: Add truthful config and capability reporting**

Add `GEO_MEDIA_PROVIDER=disabled|fixture` (default `disabled`) and
`GEO_MEDIA_OBJECT_ROOT`. Reject unknown/live values. `/capabilities` reports disabled or
fixture mode.

- [ ] **Step 4: Add exactly two static Pi/MCP tools**

Pi supplies scoped IDs and enums only. It cannot supply a raw prompt, provider, URL, storage
key, or credential. Existing publication tool order and grant handling remain unchanged.

- [ ] **Step 5: Run and commit**

```powershell
pnpm --filter @geo/config test
pnpm --filter @geo/api test
pnpm --filter @geo/api typecheck
pnpm --filter @geo/agent test
pnpm --filter @geo/agent-mcp test
pnpm --filter @geo/agent-mcp typecheck
git add .env.example packages/config apps/api apps/agent-mcp packages/agent
git commit -m "feat: expose governed media production through API and MCP"
```

### Task 7: Export complete image-and-article packages and verify samples

**Files:**

- Modify: `packages/connectors/src/manual-export.ts`
- Modify: `packages/connectors/src/types.ts`
- Modify: `packages/connectors/src/connectors.test.ts`
- Modify: `apps/api/src/manual-publication-package.ts`
- Modify: `apps/api/src/manual-publication-package.test.ts`
- Create: `packages/core/src/sampleTravel-samples.test.ts`
- Modify: `tests/e2e/src/publication-flow.test.ts`
- Modify: `README.md`
- Modify: `docs/api/http-api.md`
- Modify: `docs/api/mcp-tools.md`

**Interfaces:**

- Manual package includes article text, `media-manifest.json`, exact binary attachments, MIME,
  byte length, and SHA-256. Preview receipts remain unconfirmed dry-run evidence.
- Sample travel tenant sample matrix covers five profiles and three platforms.

- [ ] **Step 1: Write failing export-integrity tests**

Assert every manifest entry has one exact-byte attachment, recomputed hash matches, missing or
extra bytes fail closed, and the article payload hash includes the same media reference.

- [ ] **Step 2: Extend manual package without claiming live delivery**

Represent binary attachments as base64 plus explicit MIME/hash in API JSON; decode only when
writing a local package. Keep connector `capability: manual_only`, `execution: dry_run`, and
receipt confirmation false.

- [ ] **Step 3: Generate the Sample travel tenant 5 x 3 test matrix**

Use only verified sample facts and contacts `4000000001`, `TRAVEL_DEMO_01`, and `TRAVEL_DEMO_02`. Assert no
other phone/WeChat token appears and generated-image OCR is empty.

- [ ] **Step 4: Run focused E2E and document capability truth**

```powershell
pnpm --filter @geo/connectors test
pnpm --filter @geo/api test -- --run src/manual-publication-package.test.ts
pnpm --filter @geo/e2e test:e2e
```

Document real provider and live platform delivery as unavailable until separately configured
and verified.

- [ ] **Step 5: Run the full repository gate**

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @geo/db test:integration
pnpm e2e
pnpm e2e:web
pnpm build
git diff --check
```

Expected: all commands pass. If Docker-dependent clean startup cannot run because Docker is
unavailable, record that as residual environment verification rather than a passing result.

- [ ] **Step 6: Commit and push**

```powershell
git add packages/connectors apps/api/src/manual-publication-package* `
  packages/core/src/sampleTravel-samples.test.ts tests/e2e README.md docs/api
git commit -m "feat: complete governed image and article production"
git push origin codex/geo-saas-mvp
```
