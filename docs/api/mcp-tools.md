# GEO MCP Tools and Evidence Boundaries

## Transport and authority

`agent-mcp` exposes Streamable HTTP `POST /mcp`, JSON `POST /agent/runs`, and unauthenticated `GET /health/live` on container port `9021`. Both POST endpoints require an explicit `Content-Length`, reject transfer encoding, are limited to 1 MiB, require a configured Host, allow an Origin only when it is configured, and require a bearer token from `MCP_PRINCIPALS_JSON`.

The bearer credential is mapped to an API email/password/tenant login. Seed users cannot satisfy this login. Each tool then checks the principal capability, input `tenantId`, and referenced resource scope through the API. Tool schemas are a static allowlist; arbitrary names and dynamically discovered tools are denied.

Pi Agent v0.73.1 does not contain built-in MCP support. `agent-mcp` embeds a restricted Pi runner next to the GEO MCP server and an optional background batch Producer in the same process. The runner uses a static allowlist of eleven GEO tools and three narrow Plastic Promise wrappers. GEO tools pass deterministic principal, capability, tenant, and API resource-scope authorization. Governance wrappers still require the authenticated tenant and capability; `context_supply` is additionally forced to `project:geo-saas:tenant:<tenantId>` with `project_policy=strict` and project-only retrieval, so it cannot use the model's arguments to select another tenant memory scope. Both the API and `agent-mcp` connect to the external Plastic Promise endpoint during startup.

## Tool inventory

| Tool                           | Principal capability | Main input                                                                           | Effect                                                                                    |
| ------------------------------ | -------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `geo_tenant_context`           | `tenant:read`        | `tenantId`                                                                           | Discover tenant, brands, contacts, accounts, capabilities, Campaigns and policy summaries |
| `geo_template_catalog`         | `content:read`       | `tenantId`                                                                           | Read the versioned 20-plus governed article strategy catalog                              |
| `geo_brand_profile`            | `content:read`       | `tenantId`, `brandId`                                                                | Read the active immutable Brand Agent Profile for one scoped brand                        |
| `geo_fact_lookup`              | `content:read`       | `tenantId`, `brandId`, `query`, optional `limit`                                     | Read tenant facts and evidence                                                            |
| `geo_draft_proposal`           | `content:write`      | tenant/brand/campaign, brief, optional catalog `articleTemplateId` and `fixtureMode` | Create a canonical API content item/version proposal                                      |
| `geo_variant_preview`          | `content:write`      | tenant, content version, account, platform                                           | Create an immutable account/platform variant                                              |
| `geo_audit_request`            | `audit:run`          | tenant, variant, idempotency key                                                     | Run exact deterministic audit; cache returned grant in the MCP session registry           |
| `geo_publication_request`      | `publish:request`    | tenant, variant, account, execution level, idempotency key                           | Consume a grant previously returned in this process and enqueue a job                     |
| `geo_visibility_request`       | `visibility:run`     | tenant, query-set version, `doubao` or `qwen`, sample count, idempotency key         | Request the API fixture visibility path                                                   |
| `geo_media_production_request` | `content:write`      | tenant, content version, platform, role, 1-3 claim IDs, idempotency key              | Request the API's governed fixture media path                                             |
| `geo_media_job_status`         | `content:read`       | tenant and media job ID                                                              | Read declared media capability, job state, and immutable asset                            |

`geo_publication_request` cannot create its own grant. The audit must pass, the actor must be eligible, the in-process pending grant must still be present/unexpired, and Plastic Promise must return a passing pre-check plus an `allow` defense decision. An `allow` value is not sufficient by itself: the defense result must name exactly `geo_publication_request`, classify it as `high` or `critical` risk, require trust of at least `0.60`, and include `external_publish` in `manifest.side_effects`; the manifest name must match the tool. Missing or inconsistent classification returns `defense_semantics_invalid` and fails closed. Restarting agent-MCP clears its pending map. Requesting `unattended` in the schema does not make it allowed: governance, account capability, database grant logic, automation control and connector policy still apply.

`geo_template_catalog` returns the same `geo.article-templates.v1` catalog exposed to the live web application. `geo_draft_proposal.articleTemplateId` must name an item in that shared catalog. A selected template determines the governed editorial profile and is persisted in the canonical payload and its hash; an unknown ID is rejected before content is written. Omitting the ID preserves brief-based profile selection for backward-compatible automation.

`geo_tenant_context` is the tenant-scoped discovery entry point, so Pi does not need a user to supply internal brand, Campaign or policy UUIDs blindly. Tenant, brand, contact, account and declared capability summaries require only `tenant:read`. Active Brand Agent Profiles and Campaign summaries are included only when the authenticated principal also has `content:read`; policy summaries and their operative audit thresholds are included only with `audit:read`. Missing optional capabilities produce empty arrays instead of bypassing the downstream API guard. The result is descriptive context only and does not grant content, audit or publication authority.

`geo_brand_profile` returns only the selected tenant-scoped brand's active `geo.brand-agent-profile.v1` document together with immutable ID, version and SHA-256. A real Pi prompt may include an optional `brandId`; when present, `agent-mcp` loads and validates the active Profile before invoking the provider and injects the exact structured document plus reference into the system prompt. Missing, retired, cross-brand or mismatched Profiles fail before model execution. The Profile may guide strategy, voice and structure, but it is not a fact/evidence source and cannot relax closed-content rendering, deterministic audit, grants or connector capability.

`geo_draft_proposal` does not accept model-authored title, summary, body, tags, contacts, or claim text. It loads the active strict `geo.audit-policy.v2` bundle, current verified facts, and active tenant contacts, then sends a canonical closed-reference content version to the API. The `brief` is orchestration context only; it is not copied into publishable text. `fixtureMode=true` labels the deterministic proposal path and is not a replacement free-text payload.

`geo_variant_preview` uses `platform` only as an account-scope assertion. Its downstream API POST contains exactly `{ contentVersionId, channelAccountId }`; no model/client payload or platform value crosses that write boundary. The API derives the platform and renders title, summary, body and tags from the active policy profile while preserving the canonical claim/contact references. The response payload is therefore server-generated. Same-version/account retries reuse the deterministic variant, and audit history includes cross-platform publication history plus same-version sibling variants when evaluating near duplicates.

The media tools do not accept a prompt, provider/model choice, source URL, storage key, credential, or arbitrary media metadata. `geo_media_production_request` can only select a source version, target platform/role, exact verified claim IDs, and idempotency key; the API derives the VisualBrief and all provenance. Media production defaults to disabled. The only implemented provider is the deterministic `fixture-png-v1` path with `networkUsed=false`, so successful tool output proves pipeline integrity only and is not a production-ready image. No configuration enables a live provider in this snapshot.

## Agent run endpoint

With the default `AGENT_PROVIDER=fixture`, `POST /agent/runs` invokes `FixturePiAgentRunService` and accepts only this strict request shape:

```json
{
  "workflow": "draft_to_publication",
  "tenantId": "00000000-0000-4000-8000-000000000001",
  "brandId": "00000000-0000-4000-8000-000000000002",
  "campaignId": "00000000-0000-4000-8000-000000000003",
  "channelAccountId": "00000000-0000-4000-8000-000000000004",
  "platform": "toutiao",
  "topic": "Verified destination guidance",
  "articleTemplateId": "step-by-step-guide",
  "idempotencyKey": "agent-run-001"
}
```

The request `tenantId` must match the authenticated principal. The fixture flow runs context -> template/Profile -> facts -> draft -> variant -> audit -> publication request through the same allowlisted tools and hard-codes `executionLevel=dry_run`. `articleTemplateId` is optional only for backward compatibility; the Web gateway always supplies the customer selection.

Real Pi mode is selected only when `AGENT_PROVIDER` names a provider known to Pi, `AGENT_MODEL` names one of that provider's registered models, and `AGENT_API_KEY` is injected. Unknown providers/models or a missing key fail process startup. In this mode the endpoint accepts only:

```json
{
  "workflow": "prompt",
  "brandId": "10000000-0000-4000-8000-000000000301",
  "prompt": "Create and audit a tenant-scoped article using only verified facts."
}
```

A successful response is `{ "capability": { "mode", "provider", "model" }, "result": ... }`. The health response exposes the selected non-secret capability. A Pi provider failure returns sanitized `502 AGENT_PROVIDER_FAILED`, rather than a false successful response with empty text. Runs default to a 120-second limit (`AGENT_RUN_TIMEOUT_MS`, allowed range 1 second to 15 minutes); expiry returns `504 AGENT_RUN_TIMEOUT` and aborts the Pi loop. Only one run may be active for the same tenant/actor pair; another returns `409 AGENT_RUN_ACTIVE`. After a timeout, the in-process lock remains until the underlying runner actually settles, so a slow ignored abort cannot overlap a second state-changing run. This is an in-process guard, not a distributed quota or general rate limiter.

Real Pi means a real model loop is orchestrating the same static tools. It does **not** mean that Toutiao, Sohu, Ctrip Community, Doubao, or Qwen is being called through a real platform API. The three publishing platforms remain `manual_only` plus `dry_run`; Doubao/Qwen remain fixture runs or explicit manual imports.

The real Pi system prompt enforces the operational order rather than relying on a customer prompt to know internal IDs: start with `geo_tenant_context`, inspect `geo_template_catalog` and `geo_brand_profile`, load verified evidence with `geo_fact_lookup`, create the closed draft with `geo_draft_proposal`, render through `geo_variant_preview`, and only then call `geo_audit_request`. Resource IDs must come from tenant-scoped tool results. Profile text can guide selection and voice but cannot be promoted to fact text.

## Background batch Producer

`AUTOMATION_PRODUCER_ENABLED=true` starts a long-running scheduler after the HTTP server binds. It round-robins only configured API principals whose current session includes `automation:execute`; claim failures are isolated per principal so one disabled tenant cannot starve the others. Each claimed run carries an API-issued tenant gate and an actor-bound database lease. Heartbeats and every draft/target checkpoint re-evaluate tenant/Campaign/control/circuit gates. The Producer never accepts an execution level from a batch and always requests `dry_run`.

The Producer persists the canonical draft before any target, then persists `variant_ready`, the real audit run ID plus artifact ID, and `awaiting_delivery` independently for every account. It polls only the publication job bound to that target and records `preview_completed` only when the job reports the Dry-run Preview terminal state. Audit artifact IDs are never substituted for audit run IDs; both are parsed and checked independently. Process restart relies on database lease expiry and stable idempotency keys, while `awaiting_delivery` runs resume by readback rather than reissuing publication.

Configuration is bounded by `AUTOMATION_PRODUCER_CONCURRENCY` (1-16), poll, lease, heartbeat and delivery-poll intervals. `AUTOMATION_PRODUCER_ID` should remain stable across restarts for diagnosis. Shutdown stops acquisition, aborts active work, reconciles uncertain state and closes the governance transport. `/health/live` exposes only the enable/running flag, last tick, active count and sanitized failure code; it contains no prompt, credential, lease token or tenant payload.

## Publication governance handoff

Publication governance has two explicit stages. The Pi/runtime `pre_authorization` stage has no authoritative grant row or audit artifact, so its `audit_pre_check` action description marks `publicationContext.availability=deferred_to_api_grant_consumption`. It is a proposal gate, not proof that a grant can be consumed.

The fixture/model drafting context call is separate from that publication decision. Its Plastic Promise project ID is derived from the authenticated tenant by application code, never accepted from the prompt, and uses strict project retrieval. Empty tenant-specific memory is preferable to falling back to another tenant or global project memory.

At the API `grant_consumption` stage, the tenant-scoped repository loads the grant and its immutable audit artifact before any grant/job/outbox side effect. The API sends a whitelisted context to `audit_pre_check`: grant ID/status/issue/expiry metadata plus artifact identity, tenant/variant/account/platform bindings, payload/fact/policy/audit hashes, policy version, status, findings, and timestamps. The action description is redacted and never contains the publication bearer token or token hash. Plastic Promise `audit_pre_check` must pass, and `defense` must both allow the action and return the exact high-risk external-publication semantics described above. Malformed, denied, semantically downgraded, or unavailable governance fails closed.

## Publishing evidence boundary

| Value                | Meaning                                                         | Valid claim                                                                          |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `fixture`            | deterministic test/generated input                              | test behavior only                                                                   |
| `preview`            | hashed rendered draft/connector response with `confirmed=false` | no external write occurred                                                           |
| `manual_import`      | human supplied observation/readback data                        | a human recorded this data; provenance must be reviewed                              |
| `browser_screenshot` | authenticated browser UI capture                                | UI state at a time; not sufficient alone for unattended API capability               |
| `api_response`       | response from a verified platform endpoint                      | one API exchange; must still reconcile account/content/status                        |
| `platform_readback`  | independent platform-side readback                              | strongest confirmation when bound to account, external ID/URL and exact content hash |

Current default connectors for `toutiao`, `sohu` and `ctrip_community` are `DryRunConnector`. They perform no network write and return preview receipts with `confirmed=false`, no external ID/URL and no publication time. A manual package (`article.md`, instructions, `media-manifest.json`, and exact hash-verified base64 attachments) is an assisted handoff, not a live receipt. Seeded channel accounts allow only `dry_run`.

`browser_assisted` may support human-assisted execution but never unattended execution. Only independently verified `public_api` or `partner_api` capability with publish and reconciliation evidence can become eligible for unattended mode, and all audit/grant/Kill Switch gates still apply.

## Visibility evidence boundary

| API path/mode                 | Stored method/type         | Interpretation                                                      |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `/api/visibility-runs`        | `fixture` / `fixture`      | Synthetic Doubao/Qwen-labelled answers for deterministic tests      |
| `/api/visibility-runs/import` | `manual` / `manual_import` | Human captured answer, URLs, product surface, model and search mode |
| Official API                  | not implemented            | No claim permitted                                                  |
| Browser sampling              | not implemented            | No claim permitted                                                  |

Every real observation must retain provider product surface, model/version, search mode (`on|off|unknown`), locale, geography, prompt/query-set version, raw answer, citations and observation timestamp. Doubao/Qwen retrieval behavior must be measured directly; Google rank, one answer or fixture metrics cannot stand in for repeated domestic product observations.
