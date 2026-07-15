# Brand Agent Profile V1 Design

## Purpose

Brand Agent Profile is the tenant-controlled, brand-scoped writing configuration used by Web operators, Pi Agent and deterministic audit. It gives each customer an explicit place to configure audience, objectives, voice, required points, forbidden claims, CTA and Pi orchestration instructions without turning those instructions into facts or silently learning from publication outcomes.

V1 is industry-neutral and multi-tenant from the first row. Zhongtong International Travel Agency is the first seeded customer, not a schema special case.

## In scope

- strict `geo.brand-agent-profile.v1` contract shared by API, Pi/MCP and audit;
- one active immutable version per tenant/brand;
- Web editor on `/customers` with brand selection, version/hash/effective time, capability-aware writes and explicit Demo non-persistence;
- tenant-scoped HTTP list/read/create routes;
- read-only `geo_brand_profile` MCP tool;
- optional `brandId` on the real Pi prompt workflow;
- `{ id, version, documentHash }` binding in canonical and platform payloads;
- exact historical Profile loading and hash verification during audit;
- default Profile creation during seed and production tenant provisioning.

## Explicitly out of scope

- automatic positive/negative feedback learning;
- long-term brand memory mutation;
- using Profile text as claims, evidence, contacts or platform capability;
- Profile approval workflow or maker-checker review;
- live platform publication, live Doubao/Qwen evaluation, or production image generation.

## Document contract

```json
{
  "schemaVersion": "geo.brand-agent-profile.v1",
  "voice": "克制、清晰、证据优先；先回答问题，再解释依据与边界",
  "audiences": ["正在评估品牌服务并需要核验信息的潜在客户"],
  "objectives": ["帮助读者基于当前证据理解服务事实、适用范围与下一步"],
  "requiredPoints": ["区分已验证事实、适用条件和仍需确认的信息"],
  "forbiddenClaims": ["无证据的保证、排名、独家资质、实时优惠或结果承诺"],
  "callToAction": "请通过当前有效的官方联系方式核验具体服务范围与条件。",
  "agentInstructions": "只选择有当前租户事实与证据支持的文章策略。"
}
```

The schema is strict. Audiences and objectives must be non-empty. Lists are bounded, trimmed and unique. The API computes `documentHash` from canonical JSON; clients cannot submit a hash or version.

## Persistence and transitions

`geo.brand_agent_profiles` carries `(tenant_id, id, brand_id, version, status, document, document_hash, created_by_actor_id, effective_at, retired_at, created_at)`. Composite foreign keys bind brand and actor to the same tenant. Unique indexes enforce `(tenant_id, brand_id, version)` and one `status='active'` row per brand.

The only allowed state change is `active -> retired`, which must set `retired_at`. Document, hash, version, brand, creator and effective time never mutate, and DELETE is rejected. Creation takes a tenant/brand advisory lock, verifies the brand under forced RLS, retires the current row and inserts `max(version)+1` in one transaction.

Migration `0016` backfills version 1 for already provisioned tenants, writes Profile ID/hash into append-only provisioning receipts, restores the receipt trigger, and then makes both columns required. New provisioning creates the Profile and receipt binding atomically.

## Runtime flow

```text
Web tenant manager
  -> POST /api/brands/:brandId/agent-profile
  -> strict schema + server SHA-256
  -> immutable active version

Real Pi prompt with brandId
  -> GET exact active tenant/brand Profile
  -> inject ID/version/hash/document into system prompt
  -> GEO tools select verified facts + closed templates
  -> canonical content stores Profile reference
  -> platform variant preserves reference
  -> audit reloads exact historical Profile and verifies reference + hash
```

The Profile controls strategy, voice and structure only. Facts still come from tenant-scoped verified claims/evidence and contacts. Article templates still control the governed editorial profile. The final closed platform variant remains the audited object.

## Failure behavior

- no active Profile for an explicitly selected `brandId`: reject before provider invocation;
- tenant/brand mismatch: reject through resource-scope authorization;
- malformed Profile row or document: fail parsing, never downgrade to defaults;
- payload/snapshot presence mismatch: `AUDIT_CONTEXT_MISMATCH`;
- ID/version/hash mismatch: `AUDIT_CONTEXT_MISMATCH`;
- malformed snapshot or recomputed document hash mismatch: `AUDIT_BRAND_SNAPSHOT_INVALID`;
- API Profile endpoint unavailable in live Web mode: show endpoint-specific failure, never substitute Demo success.

## Security properties and residual risk

RLS and composite keys prevent cross-tenant rows. Pi cannot choose a Profile by prompt text: application code loads it from the authenticated tenant and selected brand. The MCP tool is read-only and statically allowlisted. Retired versions remain available only through exact repository lookup for historical audit.

`tenant:manage` is powerful: an authorized manager can write hostile or low-quality instructions. V1 relies on deterministic facts, closed rendering and audit to contain the blast radius, but it has no maker-checker approval. A future approval workflow may govern activation; it must preserve immutable versions and cannot be replaced by automatic feedback memory.

## Verification

- contract schema tests cover strict document/reference parsing;
- repository tests cover tenant/brand scope, version increment and exact historical read;
- PostgreSQL tests cover migration, one-active constraint, RLS, provisioning replay and rollback;
- API tests cover capability, CSRF, GET/POST behavior and server-computed hash;
- Pi/MCP tests cover tool inventory, scope checks, prompt injection and fail-closed missing Profile;
- Core tests cover variant preservation, snapshot recomputation and audit mismatch denial;
- Web tests cover live readback, versioned save, `tenant:manage` read-only mode and Demo non-persistence.
