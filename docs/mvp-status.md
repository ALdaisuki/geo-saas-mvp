# First-release MVP completion matrix

Updated: 2026-07-25

The authoritative scope is `docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md`. This matrix separates completed product paths from the four explicitly deferred production capabilities. A fixture, preview, manual import, and real provider outcome remain different evidence classes.

| Product path                                     | Web                                                                                                            | HTTP/API + PostgreSQL                                                              | Pi/MCP + Worker                                                             | Status                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Multi-tenant, multi-industry customer governance | tenant switcher; brand/contact/member/policy/account management                                                | tenant RLS, scoped writes, immutable audit                                         | tenant context returns only authorized resources                            | Complete                                   |
| Brand-specific instructions                      | versioned Profile editor                                                                                       | immutable Profile version/hash and historical audit binding                        | exact Profile injected into Pi prompt and exposed by MCP                    | Complete                                   |
| 20-plus GEO article strategies                   | 21 selectable templates with benefits and fit                                                                  | shared versioned catalog and persisted template attribution                        | catalog discovery plus governed draft input                                 | Complete                                   |
| Evidence-backed article production               | live Pi composer with brand/Campaign/account/template selection, run state and content readback                | session/CSRF gateway, tenant bearer selection, closed references and hashes        | context -> template/Profile -> facts -> draft -> variant -> audit           | Complete                                   |
| Platform variants and pre-publication audit      | Toutiao/Sohu/Ctrip previews, audit findings and grant state                                                    | server-rendered variants, immutable audit artifacts, one-time grants               | variant -> audit is mandatory before delivery                               | Complete                                   |
| Unattended first-release automation              | batch scheduling and run/target readback                                                                       | actor-bound leases, checkpoints, idempotency, tenant mode and bounded quota writes | Producer is restartable and fixed to `dry_run`                              | Complete within Dry-run boundary           |
| Emergency controls                               | tenant and scoped Kill Switch, mode/quota settings, circuit controls, grant revoke and queued-job cancellation | ownership-checked transactional writes plus append-only audit log                  | Worker rechecks gates before execution                                      | Complete                                   |
| Query-set lifecycle                              | catalog, prompt editor, version history, activate and retire controls                                          | immutable versions, explicit activation, terminal retirement and audit hashes      | provider-neutral query discovery remains evidence-labelled                  | Complete                                   |
| API contract discovery                           | settings and operators use the same versioned API                                                              | generated OpenAPI 3.1 route/security inventory and `x-geo-api-version` negotiation | unsupported API versions fail before authenticated route handling           | Complete for MVP route inventory           |
| Manual distribution handoff                      | export from a passed audit                                                                                     | hash-verified article/media package marked not published                           | no connector/network write                                                  | Complete                                   |
| Ctrip governed publishing path                   | tenant queue, claim, draft review, explicit canary approval, observation and readback evidence                 | tenant-RLS handoffs, A/B/C gates, one-time permits and content-bound readbacks     | fixed draft/supervised/unattended adapters; Worker and Bridge recheck gates | Implemented; production validation pending |
| Visibility measurement                           | fixture and manual evidence views                                                                              | repeated sample storage and provider/method labels                                 | fixture request tool only                                                   | Complete within evidence boundary          |

## Included MVP scope

All included first-release control-plane paths have implementation, automated verification and responsive visual acceptance. The remaining work below requires external provider capabilities or authorized platform validation and stays outside this MVP boundary.

## Explicitly deferred production capabilities

- Real Doubao/Qwen evaluation calls.
- Real Toutiao/Sohu publication connectors; authorized Ctrip Phase A/B/C production
  validation, including the single Phase B canary and matching public readback.
- Production image generation.
- Automatic positive/negative feedback into long-term brand memory.

The Ctrip Community path has source-owned fixed writers for audited draft fill and
media upload, one supervised final action, and independent public readback. The
tenant-authenticated Bridge exposes these only through named adapters; it has no
generic selector, script, navigation, or arbitrary-click surface. Challenge,
session-expiry, adapter-drift, ambiguous-submit, and readback-mismatch outcomes stop
or enter review instead of retrying an external write.

Two separate read-only observations, on 2026-07-17 and 2026-07-25, found the same
picture-text editor origin/path and stable title editor, body editor, image-upload
entry, attached image file input, draft-save action, and final publish action.
Manifest v3 compiles those controls and requires every one to exist exactly once;
missing, duplicate, hidden-when-visible-required, or attribute-drifted controls make
readiness unavailable. The reviewed surface now admits `browser_supervised` and
`browser_unattended`; database Phase C, current adapter evidence, Kill Switch, permits,
and matching public readback remain independent fail-closed requirements. No real
submit or publication is claimed by the surface review alone.

Migration `0042_ctrip_release_phase_gate.sql` makes rollout state a database gate.
Phase A permits draft preparation but no submit permit. Phase B can bind exactly one
content-specific assisted canary and one short-lived permit for that account. Phase
C requires the same canary's accepted browser observation and matching
`platform_readback` content hash before unattended claims or permits become
possible. The production default remains `browser_draft`, and the Producer remains
disabled; changing an environment variable does not promote a phase.

The older `browser_preflight` discovery adapter remains intentionally read-only and
maps observations to a closed prepare result even though the shared v3 manifest can
recognize the reviewed editor surface. That restriction applies to the discovery
adapter, not to the separate fixed draft/supervised implementations. No production
Phase A/B/C evidence has been recorded by this repository state, so the implemented
writers must not be described as a completed live rollout or proof that any article
was published.

These deferred items are not configuration flags or hidden endpoints. Real Pi mode is available for article orchestration when a supported provider/model/key is configured, but article quality must still be evaluated against tenant facts, audit results and human review samples before production use.
