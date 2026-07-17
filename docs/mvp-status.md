# First-release MVP completion matrix

Updated: 2026-07-16

The authoritative scope is `docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md`. This matrix separates completed product paths from the four explicitly deferred production capabilities. A fixture, preview, manual import, and real provider outcome remain different evidence classes.

| Product path                                     | Web                                                                                                            | HTTP/API + PostgreSQL                                                              | Pi/MCP + Worker                                                                | Status                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- |
| Multi-tenant, multi-industry customer governance | tenant switcher; brand/contact/member/policy/account management                                                | tenant RLS, scoped writes, immutable audit                                         | tenant context returns only authorized resources                               | Complete                          |
| Brand-specific instructions                      | versioned Profile editor                                                                                       | immutable Profile version/hash and historical audit binding                        | exact Profile injected into Pi prompt and exposed by MCP                       | Complete                          |
| 20-plus GEO article strategies                   | 21 selectable templates with benefits and fit                                                                  | shared versioned catalog and persisted template attribution                        | catalog discovery plus governed draft input                                    | Complete                          |
| Evidence-backed article production               | live Pi composer with brand/Campaign/account/template selection, run state and content readback                | session/CSRF gateway, tenant bearer selection, closed references and hashes        | context -> template/Profile -> facts -> draft -> variant -> audit              | Complete                          |
| Platform variants and pre-publication audit      | Toutiao/Sohu/Ctrip previews, audit findings and grant state                                                    | server-rendered variants, immutable audit artifacts, one-time grants               | variant -> audit is mandatory before delivery                                  | Complete                          |
| Unattended first-release automation              | batch scheduling and run/target readback                                                                       | actor-bound leases, checkpoints, idempotency, tenant mode and bounded quota writes | Producer is restartable and fixed to `dry_run`                                 | Complete within Dry-run boundary  |
| Emergency controls                               | tenant and scoped Kill Switch, mode/quota settings, circuit controls, grant revoke and queued-job cancellation | ownership-checked transactional writes plus append-only audit log                  | Worker rechecks gates before execution                                         | Complete                          |
| Query-set lifecycle                              | catalog, prompt editor, version history, activate and retire controls                                          | immutable versions, explicit activation, terminal retirement and audit hashes      | provider-neutral query discovery remains evidence-labelled                     | Complete                          |
| API contract discovery                           | settings and operators use the same versioned API                                                              | generated OpenAPI 3.1 route/security inventory and `x-geo-api-version` negotiation | unsupported API versions fail before authenticated route handling              | Complete for MVP route inventory  |
| Manual distribution handoff                      | export from a passed audit                                                                                     | hash-verified article/media package marked not published                           | no connector/network write                                                     | Complete                          |
| Ctrip supervised publishing control plane        | tenant queue, claim, prepare, explicit submit approval, observation and readback evidence                      | tenant-RLS handoffs, internal permits, unconfirmed receipts and required readbacks | Worker creates handoffs; isolated simulator plus read-only surface review gate | Live write adapter still closed   |
| Visibility measurement                           | fixture and manual evidence views                                                                              | repeated sample storage and provider/method labels                                 | fixture request tool only                                                      | Complete within evidence boundary |

## Included MVP scope

All included first-release control-plane paths have implementation, automated verification and responsive visual acceptance. The remaining work below requires new external provider capabilities and stays outside this MVP boundary.

## Explicitly deferred production capabilities

- Real Doubao/Qwen evaluation calls.
- Real Toutiao/Sohu publication connectors; authenticated live Ctrip adapter,
  platform draft/final submit and independent Ctrip public readback.
- Production image generation.
- Automatic positive/negative feedback into long-term brand memory.

The Ctrip Community supervised path now has typed capability evidence, session
freshness, exact draft hashing, challenge/adapter-drift outcomes and unconfirmed
browser-evidence receipts. Its durable tenant-RLS handoff control plane is also
implemented, including operator leases, explicit pre-submit/unconfirmed states and a
short-lived one-time permit whose consumption rechecks governance and current lease
ownership. The publication API now admits only governed Ctrip `assisted` grants,
and the Worker freezes the shared Ctrip preview and creates the durable handoff
before acknowledging the outbox event. Missing or stale tenant/account adapter
mapping remains retryable and fail closed. An isolated tenant-authenticated bridge
now executes the complete flow only through `ctrip-community-simulator-v1`.
Simulator submit creates an unconfirmed receipt and required readback; simulator
readback can only enter `needs_review`, never `confirmed`. A live Ctrip adapter and
independent Ctrip public readback are still absent, so this is not a live or hidden
Ctrip publishing path.

The Bridge now durably records `session_required`, `challenge_required` and
`adapter_drift` prepare outcomes before returning them. The same read-only surface
review is available either as the supervised `review:surface` command or as the
explicit `browser_preflight` Bridge mode. That mode binds one process to exactly one
tenant and one operator-authenticated, already-open Chromium session through a
local-only CDP endpoint. It supports only `prepare`, exposes no `/simulator` page,
and rejects `submit` or `readback` with `CTRIP_BRIDGE_COMMAND_UNSUPPORTED` before a
one-time submit permit can be consumed. Both paths have no navigation or input
methods and emit only canonical Ctrip origin/path, bounded redacted control labels,
fixed challenge signals and hashes. The compiled reviewed-surface list is empty and
`liveCanaryEnabled=false`; consequently even a recognized page is durably recorded
as `adapter_drift` and cannot start a live canary or publish content. The next live
milestone requires an authorized evidence review, a source-controlled fixed surface
manifest, fixed prepare/upload/submit locators and one explicitly supervised canary
followed by independent public readback.

Migration `0022_ctrip_prepare_evidence.sql` closes the remaining prepare-audit gap.
Every new blocker or prepared draft atomically stores `prepareOutcome`, evidence
kind, top-level evidence hash and observation time; a prepared draft additionally
stores its media-manifest hash. These values are returned by the tenant-scoped
handoff API and shown as bounded evidence identity in the Publishing queue. Legacy
handoffs remain explicitly null instead of receiving reconstructed evidence.

Migration `0023_ctrip_submit_candidate_target.sql` closes the cross-restart
readback-target gap. A browser submit observation may atomically persist one
canonical candidate Ctrip external ID/URL pair, while simulation and rejected
submits must leave both null. The Publishing queue labels the pair as unconfirmed,
and a later confirmed platform readback must match it exactly. This does not add a
live writer or turn authoring-page acknowledgement into publication proof.

These deferred items are not configuration flags or hidden endpoints. Real Pi mode is available for article orchestration when a supported provider/model/key is configured, but article quality must still be evaluated against tenant facts, audit results and human review samples before production use.
