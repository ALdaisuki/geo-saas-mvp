# HTTP API

Source of truth: `apps/api/src/app.ts` and its Zod schemas. `GET /openapi.json` exposes an OpenAPI 3.1 route inventory generated from Fastify's registered routes. It documents paths, authentication, CSRF headers and the structured error envelope; request/response payload schemas remain authoritative in Zod until they are emitted into the generated document.

## Transport and authentication

- API container port: `4100`.
- Liveness: `GET /health/live`; readiness: `GET /health/ready`.
- API version: `2026-07-16`. Clients may send `x-geo-api-version`; an unsupported value returns `406 API_VERSION_UNSUPPORTED`. Every response includes the supported version in that header.
- OpenAPI route inventory: `GET /openapi.json` (public).
- `POST /api/auth/login` accepts email, password and optional tenant slug.
- Successful login sets `geo_session` (HttpOnly) and `geo_csrf` cookies. Production cookies are Secure and SameSite=Strict.
- State-changing authenticated routes require `x-csrf-token` matching the CSRF cookie/session hash.
- Responses set `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
- Errors use `{ "error": { "code", "message", "requestId", "details"? } }`.
- API startup requires a successful connection to `PLASTIC_PROMISE_MCP_URL`. Non-loopback governance endpoints must use HTTPS; an optional complete Authorization header is supplied separately.

The API is tenant-scoped after login. `DATABASE_IDENTITY_URL` uses `geo_identity_login`, which has no table privileges and, among `geo` application functions, may execute only the security-definer `geo.find_login_identity(text)` and `geo.find_login_identity_by_user(uuid)` functions. The first resolves login credentials and memberships by email; the second refreshes memberships for an already authenticated user before tenant listing/switching. Normal repository calls switch to `geo_runtime` inside a transaction and set tenant/actor/request context. `DATABASE_ADMIN_URL` is never accepted as the API identity connection.

## Route inventory

| Method/path                                                     | Required capability                  | Purpose                                                                                        |
| --------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `POST /api/auth/login`                                          | public                               | Establish one tenant session                                                                   |
| `POST /api/auth/logout`                                         | session + CSRF                       | Revoke server session and clear cookies                                                        |
| `GET /api/auth/session`                                         | session                              | Return current actor/tenant context                                                            |
| `GET /api/auth/tenants`                                         | session                              | List current user's memberships, marking inactive tenants/memberships unavailable              |
| `POST /api/auth/switch-tenant`                                  | session + CSRF                       | Accept `{ tenantSlug }`, revoke the old session and issue a new tenant-scoped session          |
| `GET /api/tenant`                                               | `tenant:read`                        | Tenant summary                                                                                 |
| `GET/POST /api/brands`                                          | `tenant:read` / `tenant:manage`      | List tenant brands or create a vertical-neutral brand                                          |
| `GET /api/brand-agent-profiles`                                 | `content:read`                       | List the current tenant's active immutable Brand Agent Profiles                                |
| `GET /api/brands/:brandId/agent-profile`                        | `content:read`                       | Read the active Profile for one tenant-scoped brand or return 404                              |
| `POST /api/brands/:brandId/agent-profile`                       | `tenant:manage` + CSRF               | Validate the strict document, retire the prior active row and create the next version          |
| `GET/POST /api/members`                                         | `member:manage`                      | List tenant members or create a member with an initial password                                |
| `PATCH /api/members/:memberId`                                  | `member:manage` + CSRF               | Change a member role/status with an audited reason                                             |
| `GET/POST /api/policies`                                        | `audit:read` / `tenant:manage`       | List policy bundles or create an immutable, audited draft bundle                               |
| `POST /api/policies/:policyId/state`                            | `tenant:manage` + CSRF               | Activate or retire a policy with canonical validation and an audited reason                    |
| `GET/POST /api/query-sets`                                      | `visibility:read` / `visibility:run` | List query sets or create version 1 with provider-neutral prompts                              |
| `GET/POST /api/query-sets/:querySetId/versions`                 | `visibility:read` / `visibility:run` | List immutable versions or create a reviewed inactive successor                                |
| `POST /api/query-sets/:querySetId/versions/:versionId/activate` | `visibility:run` + CSRF              | Activate one tenant-scoped version and record the prior active version                         |
| `POST /api/query-sets/:querySetId/state`                        | `visibility:run` + CSRF              | Retire a query set; retired is terminal                                                        |
| `GET /api/automation`                                           | `tenant:read`                        | Read tenant automation control and tenant/platform/account circuit status                      |
| `PUT /api/automation/control`                                   | `automation:manage` + CSRF           | Set tenant mode and the five bounded Worker quotas with an audited operator reason             |
| `PUT /api/automation/controls/:scopeType/:scopeKey`             | `automation:manage` + CSRF           | Set platform/account/campaign/topic mode, quotas and scoped Kill Switch after ownership checks |
| `POST /api/automation/circuits/:scopeType/:scopeKey/state`      | `automation:manage` + CSRF           | Manually open or close a tenant/platform/account/campaign/topic circuit with audit evidence    |
| `POST /api/automation/kill-switch`                              | `automation:manage` + CSRF           | Accept `{ enabled, reason }`, update the tenant switch and append `geo.audit_log`              |
| `GET /api/contacts`                                             | `tenant:read`                        | Current tenant contacts                                                                        |
| `GET /api/channel-accounts`                                     | `tenant:read`                        | Platform accounts and declared capabilities                                                    |
| `GET/POST /api/evidence-sources`                                | `content:read` / `content:write`     | Evidence registry                                                                              |
| `GET /api/article-templates`                                    | `content:read`                       | Return `{ version: "geo.article-templates.v1", items }` from the shared governed catalog       |
| `GET /api/agent/capability`                                     | `content:read`                       | Return the current tenant's sanitized Fixture/Pi runner availability, provider and model       |
| `POST /api/agent/runs`                                          | `content:write` + CSRF               | Run one tenant-scoped article workflow through the server-side Agent gateway at fixed Dry-run  |
| `GET/POST /api/facts`                                           | `content:read` / `content:write`     | Tenant/brand claims bound to evidence                                                          |
| `GET /api/capabilities`                                         | `tenant:read`                        | Current role capabilities and connector reports                                                |
| `POST /api/resource-scope-check`                                | session + CSRF                       | MCP-oriented tenant resource authorization                                                     |
| `GET/POST /api/campaigns`                                       | `content:read` / `content:write`     | Campaign collection and creation                                                               |
| `POST /api/campaigns/:campaignId/state`                         | `content:write` + CSRF               | Transition a campaign to `active`, `paused`, or terminal `completed`; append tenant audit log  |
| `POST /api/campaigns/:campaignId/automation-batches`            | `automation:manage` + CSRF           | Create an idempotent 1-50 slot, 1-3 account-per-slot batch; execution is server-fixed Dry-run  |
| `GET /api/automation-batches`                                   | `tenant:read`                        | List tenant-scoped batch summaries and aggregate states                                        |
| `POST /api/automation-batches/:batchId/cancel`                  | `automation:manage` + CSRF           | Cancel uncompleted runs/targets with an audited reason                                         |
| `GET /api/automation-runs[/:runId]`                             | `tenant:read`                        | List or read durable run, target, checkpoint and lease state                                   |
| `POST /api/automation-runs/claim`                               | `automation:execute` + CSRF          | Atomically claim eligible runs with actor-scoped Producer identity and tenant gate             |
| `POST /api/automation-runs/:runId/heartbeat`                    | `automation:execute` + CSRF          | Fence by actor/Producer/attempt, persist stage checkpoint and renew a valid lease              |
| `POST /api/automation-runs/:runId/draft-checkpoint`             | `automation:execute` + CSRF          | Bind one generated content item/version before target processing                               |
| `POST /api/automation-runs/:runId/targets/:targetId/checkpoint` | `automation:execute` + CSRF          | Bind variant, real audit run/artifact, job and terminal target state                           |
| `POST /api/automation-runs/:runId/reconcile`                    | `automation:execute` + CSRF          | Derive run/batch terminal or retry state from persisted targets                                |
| `GET/POST /api/content`                                         | `content:read` / `content:write`     | Content items and initial version                                                              |
| `POST /api/content/:contentId/versions`                         | `content:write`                      | Create immutable content version                                                               |
| `GET /api/content-versions/:contentVersionId`                   | `content:read`                       | Read one version                                                                               |
| `POST /api/content-versions/:id/media-jobs`                     | `content:write` + CSRF               | Request governed deterministic fixture media; unavailable while media production is disabled   |
| `GET /api/media-jobs/:id`                                       | `content:read`                       | Read media job, declared capability, and immutable asset when complete                         |
| `GET /api/media-assets?contentVersionId=:id`                    | `content:read`                       | List media assets bound to one immutable content version                                       |
| `GET/POST /api/content/:contentId/variants`                     | `content:read` / `content:write`     | List variants; POST accepts only version/account IDs and renders the payload server-side       |
| `POST /api/variants/:variantId/audits`                          | `audit:run`                          | Require `{ idempotencyKey }`; run deterministic audit and maybe return one-time authorization  |
| `GET /api/audits`                                               | `audit:read`                         | Filter and paginate immutable audit artifacts                                                  |
| `GET /api/audits/:artifactId`                                   | `audit:read`                         | Read immutable audit artifact                                                                  |
| `POST /api/audits/:artifactId/manual-publication-package`       | `publish:request` + CSRF             | Export a passed, unexpired audit as a manual-action Dry-run package; this does not publish     |
| `GET /api/audit-log`                                            | `audit:read`                         | Filter and paginate append-only tenant audit events                                            |
| `POST /api/publication-requests`                                | `publish:request`                    | Govern, consume a grant, and enqueue immediately or at optional `scheduledFor`                 |
| `POST /api/publication-grants/:grantId/revoke`                  | `grant:revoke` + CSRF                | Revoke an unconsumed grant with an audited operator reason                                     |
| `GET /api/publication-jobs`                                     | `content:read`                       | Tenant publication jobs                                                                        |
| `GET /api/publication-jobs/:jobId`                              | `content:read`                       | Job schedule, state, attempt count, and last error                                             |
| `POST /api/publication-jobs/:jobId/cancel`                      | `publish:cancel` + CSRF              | Cancel an unlocked queued/retry job and dead-letter its pending outbox event                   |
| `GET /api/publication-jobs/:jobId/attempts`                     | `receipt:read`                       | Ordered immutable execution attempts                                                           |
| `GET /api/publication-jobs/:jobId/receipts`                     | `receipt:read`                       | Receipts for one job                                                                           |
| `GET /api/publication-jobs/:jobId/readbacks`                    | `receipt:read`                       | Durable readback state for one job                                                             |
| `GET /api/receipts`                                             | `receipt:read`                       | Immutable publication receipts                                                                 |
| `GET /api/receipts/:receiptId`                                  | `receipt:read`                       | Full receipt hashes, external references, and readback declaration                             |
| `GET /api/readbacks`                                            | `receipt:read`                       | Tenant readback queue/history                                                                  |
| `GET /api/publication-assisted-handoffs`                        | `content:read`                       | List tenant-scoped Ctrip assisted handoffs without permit or credential material               |
| `GET /api/publication-assisted-handoffs/:handoffId`             | `content:read`                       | Read one tenant-scoped Ctrip assisted handoff and its evidence hashes                          |
| `POST /api/publication-assisted-handoffs/:handoffId/claim`      | `publish:request` + CSRF             | Claim an eligible handoff for 30-300 seconds; defaults to a 120-second operator lease          |
| `POST /api/publication-assisted-handoffs/:handoffId/heartbeat`  | `publish:request` + CSRF             | Renew only the current operator's unexpired lease for 30-300 seconds                           |
| `POST /api/publication-assisted-handoffs/:handoffId/prepare`    | `publish:request` + CSRF             | Ask the bound bridge to prepare the audited draft; requires the current operator lease         |
| `POST /api/publication-assisted-handoffs/:handoffId/submit`     | `publish:request` + CSRF             | Approve one bridge submit; the API issues and forwards the one-time permit without exposing it |
| `POST /api/publication-assisted-handoffs/:handoffId/readback`   | `publish:request` + CSRF             | Run independent readback for a submitted handoff; an expired operator lease does not block it  |
| `POST /api/publication-assisted-handoffs/:handoffId/cancel`     | `publish:cancel` + CSRF              | Cancel an unconsumed pre-submit handoff with an audited reason                                 |
| `POST /api/service-principals/ctrip-bridges`                    | `principal:manage` + CSRF            | Create a credential-less, fixed-capability Ctrip bridge identity                               |
| `POST /api/visibility-runs`                                     | `visibility:run`                     | Run fixture Doubao/Qwen samples only                                                           |
| `POST /api/visibility-runs/import`                              | `visibility:run`                     | Import explicitly manual observations                                                          |
| `GET /api/visibility-runs`                                      | `visibility:read`                    | Filter and paginate stored fixture/manual visibility runs                                      |
| `GET /api/visibility-runs/:runId`                               | `visibility:read`                    | Read one run with raw answers, citations, metrics, and evidence labels                         |
| `GET /api/visibility/summary`                                   | `visibility:read`                    | Stored provider/method metrics                                                                 |

Visibility observations preserve `requestStartedAt`, `responseReceivedAt`, and `observedAt`
separately, plus sentiment, answer position, canonical competitor mentions, structured
`hallucinationFindings`, extractor version, and evaluator version. Manual samples may submit the
request/response timestamps explicitly; legacy imports that contain only `observedAt` are retained
as manual evidence with both missing transport timestamps conservatively set to that observation
time. Fixture timestamps describe only the local deterministic fixture call. Neither path is
reported as a live consumer search. Competitor matching is loaded from the active tenant's
brand-scoped `brand_competitors` truth records; it is not an analyzer-local global list.

All authenticated POST routes above require CSRF. Kill Switch `reason` is trimmed and must contain 3-500 characters. Revocation and cancellation reasons contain 5-1,000 characters. `scheduledFor` must be an offset-aware ISO timestamp between now and 30 days from now, and it must also be strictly earlier than both the one-time publication grant's `expiresAt` and its immutable audit artifact's `expiresAt`. The effective scheduling window therefore ends at the earliest of the 30-day API ceiling, grant expiry, and artifact expiry; passing the 30-day check alone is not sufficient. A pending outbox lease makes cancellation return `409`; once released, cancellation atomically marks the job cancelled and prevents the event from being claimed. Kill Switch responses should still be independently confirmed through `GET /api/automation`, which returns `{ control, circuits }`.

Campaign creation always starts in `draft`. The state command accepts `{ status, reason? }`; valid changes are `draft -> active`, `active -> paused|completed`, and `paused -> active|completed`. Repeating the current state is idempotent. `completed` is terminal, and automation batch creation continues to require `active`, so lifecycle commands do not weaken the generation gate.

Automation batch input never contains `tenantId` or an execution level. The authenticated transaction supplies tenant scope and the server fixes every batch to `dry_run`. Creation accepts at most 50 unique slots and at most three unique active Dry-run accounts per slot. Runtime mutations require the current actor's `automation:execute`; the API prefixes the submitted Producer ID with that actor ID before database lease comparison, so another login cannot heartbeat or checkpoint the lease. Claim and every mutation fail closed on tenant/Campaign state, Kill Switch or open/half-open circuit conditions. Automation state changes do not emit publication outbox topics; only the normal audited publication request may create a publication job/outbox event.

The browser never calls port `9021` or receives an MCP bearer. `POST /api/agent/runs` accepts only brand, Campaign, channel-account, platform, topic, template and idempotency fields from an authenticated tenant session. The API selects that tenant's token from `AGENT_GATEWAY_CREDENTIALS_JSON`, calls the loopback Agent service, limits the response to 2 MiB and maps upstream conflicts/provider failures/timeouts to sanitized `409`/`502`/`504` errors. A missing tenant mapping fails closed with `503 AGENT_TENANT_NOT_CONFIGURED`.

The lower-level `POST /agent/runs` remains on `agent-mcp:9021`, uses an MCP bearer rather than browser cookies, and is documented in [mcp-tools.md](mcp-tools.md). Downstream content/audit records are executed by the mapped machine principal; the API gateway prompt also carries the initiating operator/request IDs for correlation, but that correlation does not replace append-only domain audit records.

## Brand Agent Profile contract

`geo.brand-agent-profile.v1` is a strict brand-scoped writing configuration with `voice`, non-empty `audiences`, non-empty `objectives`, `requiredPoints`, `forbiddenClaims`, `callToAction`, and `agentInstructions`. Unknown keys, duplicate list values, empty required fields and oversized values are rejected. The POST body is exactly `{ document, reason }`; `reason` is trimmed to 3-1,000 characters. The server computes `documentHash=SHA-256(canonical(document))` and does not accept a caller-supplied ID, version, status, hash or timestamp.

Creation takes a tenant-and-brand advisory lock, verifies the brand through tenant RLS, retires the current active row, and inserts the next positive integer version in one transaction. The database allows at most one active Profile per tenant/brand and permits only `active -> retired`; rows cannot be deleted. Provisioning creates version 1 and binds its ID/hash into the append-only tenant receipt. List/read endpoints expose active rows only, while audit repository reads use exact historical ID plus version so an old content version remains verifiable after the Profile retires.

Profile text is not evidence and cannot supply claims, contacts, credentials, platform capability or publication authorization. Governed article payloads may carry only the immutable reference `{ id, version, documentHash }`. Platform rendering preserves that reference, and deterministic audit requires it to exactly match the tenant/brand snapshot while recomputing the stored document hash. Missing-on-one-side, stale-version, cross-brand or hash-mismatched references fail with `AUDIT_CONTEXT_MISMATCH` or `AUDIT_BRAND_SNAPSHOT_INVALID` before any grant is issued.

## Canonical content and platform variants

An auditable content version is a closed reference graph, not arbitrary final prose. `titleBlocks` and `summaryBlocks` accept only `template(templateId)`, `claim(claimId)`, or `contact(contactId)` references. `bodyBlocks` accepts the same closed union, with `paragraph|bullet` presentation on claim/contact references, and `tagTemplateIds` contains only active-policy tag template IDs. Templates resolve from the active policy; claims resolve from the verified fact snapshot; contacts resolve from the tenant's active contact snapshot. The optional `articleTemplateId` attributes the customer-selected catalog strategy and is included in the payload hash and copied to platform variants; it never authorizes free text or replaces `editorialProfile`. The stored `title`, `summary`, `bodyMarkdown`, and `tags` must exactly equal the deterministic render, while `claims` and `contactIds` must exactly describe the referenced facts and contacts. Legacy unstructured versions remain readable for migration but cannot create a platform variant or receive a publication grant. Variant v1 also fails closed on media or canonical-link provenance until those references have an equivalent closed model.

Media production is disabled by default. `POST /api/content-versions/:id/media-jobs` accepts only `{ platform, role, claimIds, idempotencyKey }` and requires one to three unique claims that exactly match current verified facts in the source version. The only implemented provider is `fixture` (`fixture-png-v1`, `networkUsed=false`); it builds a deterministic VisualBrief, generates and inspects a deterministic PNG, stores it by tenant and SHA-256, and creates a successor content version containing the immutable media reference. It never mutates the source version. Tenant Kill Switch and `paused`/`stopped` modes block the request. `GEO_MEDIA_PROVIDER=live` is invalid because no production image provider exists.

`POST /api/content/:contentId/variants` has the strict request body `{ contentVersionId, channelAccountId }`. The API derives the platform from the active tenant account, loads the effective active policy plus verified facts and active contacts, validates the canonical source, and renders the final platform payload itself. A caller-supplied `payload`, `platform`, free-text field, or any other key is rejected with `400`; a legacy or tampered source fails with `422 PLATFORM_VARIANT_SOURCE_INVALID`. The Toutiao, Sohu, and Ctrip Community profiles deliberately use different policy template IDs, ordering, presentation, and tags while preserving the same fact and contact references.

Variant creation takes a transaction advisory lock scoped to tenant, content version, and account. Repeating the same version/account request with the same deterministic payload reuses the existing variant row instead of creating another version. Audit duplicate candidates include prior `preview_completed` or `confirmed` variants across all platforms and same-content-version sibling variants, including the initial draft/frozen wave, so three parallel first-wave variants cannot bypass near-duplicate evaluation merely because none has a publication job yet.

Audit idempotency is scoped to tenant, actor and variant. The first accepted request returns `201` with the real top-level `auditRunId`, immutable `artifact`, optional publication authorization and `wasCreated: true`; an identical replay returns `200` with the same run/artifact IDs and `wasCreated: false`. Audit run and artifact IDs are distinct database identities and clients must never alias one to the other. Reusing the key for another actor or variant returns `409`. The PostgreSQL transaction takes an advisory lock before writing the audit artifact, grant and `idempotency_records` row, so concurrent retries cannot mint multiple grants. Publication tokens are deterministically derived with a domain-separated HMAC and only their SHA-256 hashes are stored. A replay reconstructs the token and verifies the stored hash before returning it; consumed, revoked or expired grants are not exposed again. Rotating `SESSION_SECRET` therefore invalidates active sessions and prevents token reconstruction for any still-live pre-rotation audit grant; coordinate rotation with grant expiry or revocation.

Manual publication-package export is independent of connector execution level. The endpoint loads the exact tenant-scoped audit, frozen variant payload and channel account, and succeeds only when the artifact is `passed` and unexpired, all scope and payload hashes still match, and the active account is `manual_only` with `supportedExecutionLevels=["dry_run"]`. The response is `geo.manual-publication-package.v1` with `evidenceType=preview`, `executionLevel=dry_run`, `requiresManualAction=true`, `publicationStatus=not_published`, `confirmed=false`, and a `NOT_PUBLISHED.txt` file. For every audited media reference it also requires the exact immutable asset and object-store bytes, emits one base64 attachment plus a `media-manifest.json` entry containing filename, asset ID, MIME, byte length, SHA-256, dimensions, platform, role, fact IDs and VisualBrief hash, and includes all files and attachments in `packageHash`. Missing, extra, duplicate, or byte-tampered media fails with `422 MANUAL_PACKAGE_SOURCE_INVALID`. Export appends `manual_publication_package.exported` to `geo.audit_log`; it does not consume a publication grant, invoke publication governance, create a job, insert an outbox event, or contact the platform.

Every audit loads the tenant's effective active policy bundle with its full JSON document and canonical `policy_hash`. The API compiles that exact strict `geo.audit-policy.v2` document and passes the same frozen compiled object into the deterministic audit. The compiler records process-local object provenance in a private `WeakMap`; the audit accepts only the exact compiled object, not a spread/clone carrying the same public `sourceHash`. Unknown fields, an unsupported schema version, a bundle/document version mismatch, a canonical hash mismatch, or untrusted compiled-policy provenance all fail closed before an artifact or grant is persisted. `POST /api/policies` accepts only `{ version, document, effectiveAt?, reason }`, requires a 3-1,000 character reason, recomputes the canonical hash and creates an immutable draft plus `policy_bundle.created` audit entry. It does not activate policy. `POST /api/policies/:policyId/state` accepts only `{ targetStatus: "active" | "retired", reason }`; activation recompiles and verifies the stored document/hash, atomically retires the prior active bundle, and records the transition and reason in `geo.audit_log`.

Publication governance is evaluated twice. The agent-side `pre_authorization` action marks its grant/artifact context as deferred because the agent has no authoritative database row. Before the API consumes a grant, the `grant_consumption` action loads the tenant-scoped grant and immutable audit artifact, whitelists their status, expiry, bindings, hashes, findings, and timestamps into `audit_pre_check`, and excludes both the publication token and token hash. `audit_pre_check` must pass before grant, job, or outbox side effects. A Plastic Promise `defense` result is accepted only when it says `allow`, names exactly `geo_publication_request`, classifies the tool as `high` or `critical`, requires trust of at least `0.60`, and has a matching manifest whose side effects include `external_publish`; otherwise the request fails closed with `defense_denied` or `defense_semantics_invalid`.

Queueing before expiry is not sufficient authorization to execute later. `geo.acquire_publication_execution` re-joins the consumed grant and passed audit artifact on every initial attempt and lease recovery, then rechecks both expiry timestamps plus grant/job/artifact tenant, variant, account, platform, payload hash and audit hash bindings. `authorization_expired` and `authorization_binding_mismatch` are terminal authorization failures: the worker does not call a connector, dead-letters the attempt, and moves the job to `needs_review` so a new audit/grant is required.

## Ctrip assisted handoff control plane

Migration `0017_ctrip_assisted_handoffs.sql` adds a tenant-RLS control plane for a
future authenticated Ctrip publisher bridge. Every row is immutably bound to one
job, attempt, account, variant, payload hash, audit hash, preview hash and reviewed
adapter version. Its explicit state machine distinguishes `draft_prepared`,
`awaiting_operator_submit`, `submitted_unconfirmed`, `readback_pending` and
`confirmed`; only independent external readback may supply the external ID/URL and
reach `confirmed`.

The browser-facing API can list, inspect, claim, heartbeat, prepare, explicitly
approve submit, run readback and cancel handoffs. It cannot create a handoff, send
bridge credentials, receive or consume a submit permit, directly record evidence,
or promote a row to confirmed. The API obtains the raw one-time permit from the
database only inside the submit handler and forwards it to the exact tenant-bound
bridge; it is never returned by an HTTP route. Only its SHA-256 hash is stored, it
expires within five minutes, and bridge consumption repeats the current
operator-lease, audit, account-capability, Kill Switch, scoped-control and circuit
checks. A bridge submit observation always creates an unconfirmed receipt plus a
required readback. Claim and heartbeat perform the same governance recheck, and no
lease or permit may outlive its handoff. The table is read-only to `geo_runtime`;
security-definer functions own all writes. Cookies, authorization headers, QR/SMS
values and raw screenshots are not persisted.

Migration `0018_ctrip_assisted_admission.sql` and the Worker connect this control
plane to normal product flow for Ctrip only. The API admits an `assisted` request
only when its immutable audit names `ctrip_community`; the database then rechecks
the active `browser_assisted` account, 24-hour evidence freshness, tenant/scoped
controls, Kill Switches and circuits. The Worker uses an exact tenant/account
adapter mapping, renders the frozen preview, creates the handoff, and only then
acknowledges the outbox event. The optional `ctrip-simulator` Compose profile proves
the isolated prepare/submit/readback control flow without Ctrip network access.
Simulation evidence is prohibited from supplying an external ID/URL or reaching
`confirmed`; simulator readback ends in `needs_review`. No authenticated live Ctrip
adapter or independent public readback adapter is deployed, so the current module
cannot publish or prove publication.

The internal Bridge has two explicit process modes. `simulator` advertises
`ctrip-community-simulator-v1` and supports `prepare`, `submit` and `readback` with
simulation evidence only. `browser_preflight` advertises
`ctrip-community-browser-preflight-v1`, requires exactly one configured tenant and
one local reviewed browser session, and exposes no simulator page. Its adapter
supports only `prepare`; `submit` and `readback` fail with
`CTRIP_BRIDGE_COMMAND_UNSUPPORTED` before the service consumes a submit permit or
invokes an adapter method. A prepare result is persisted as `session_required`,
`challenge_required` or `adapter_drift`. While the source-controlled live-canary
manifest remains disabled, a `reviewed_surface` observation is intentionally mapped
to `adapter_drift`. The mode and adapter version are visible at `GET /health/live`.

For handoffs created after migration `0022_ctrip_prepare_evidence.sql`, list/detail
responses expose the complete durable prepare identity: `prepareOutcome`,
`prepareEvidenceKind`, `prepareEvidenceHash`, `prepareObservedAt` and, only for a
prepared draft, `mediaManifestHash`. The database writes that group in the same
transaction as the state transition and audit row. Older rows retain null values;
clients must not infer or backfill evidence from state, adapter version or a later
submit observation.

## Important absences

- No email invitation, password reset, or member self-enrollment workflow. Tenant managers can create and update members through the authenticated API; a privileged one-shot owner bootstrap CLI remains for initial/recovery bootstrap.
- No live Doubao/Qwen provider route; `/api/visibility-runs` is fixture by implementation.
- No live image-generation provider. Media production defaults to disabled, and fixture output proves only pipeline integrity, not production image quality or external provider availability.
- No Toutiao/Sohu public/partner API connector and no authenticated live Ctrip publisher bridge. All `unattended` and non-Ctrip `assisted` requests fail with `422 PUBLICATION_CAPABILITY_UNSUPPORTED`; a governed Ctrip `assisted` request can create an internal handoff and, only when explicitly configured, exercise the no-network simulator.
- Ctrip `browser_assisted` now has connector, admission, Worker handoff, isolated bridge contracts, simulator submit observation/readback and read-only authenticated browser preflight. Write-capable browser operation, platform draft creation, final live submit, ambiguous-result reconciliation against Ctrip, and external platform readback remain undeployed capabilities. An assisted receipt stays unconfirmed until valid `platform_readback` evidence matches the frozen payload.
- The generated OpenAPI document is a route/security inventory, not yet a complete generated payload contract or a multi-version compatibility promise.

These are product gaps, not hidden endpoints.

Dry-run receipts are explicitly unconfirmed previews: `externalId`, `externalUrl`, and `publishedAt` are null. Their durable readback row is `status=not_required`, `required=false`, `reason=dry_run_preview_only`; it is not platform readback evidence. No live readback event is emitted because live publication is rejected before a job exists. Toutiao, Sohu, and Ctrip Community remain `manual_only` accounts whose production seed supports only `dry_run`.
