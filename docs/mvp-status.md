# First-release MVP completion matrix

Updated: 2026-07-16

The authoritative scope is `docs/superpowers/specs/2026-07-13-geo-saas-mvp-design.md`. This matrix separates completed product paths from the four explicitly deferred production capabilities. A fixture, preview, manual import, and real provider outcome remain different evidence classes.

| Product path                                     | Web                                                                                                            | HTTP/API + PostgreSQL                                                              | Pi/MCP + Worker                                                   | Status                            |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------- |
| Multi-tenant, multi-industry customer governance | tenant switcher; brand/contact/member/policy/account management                                                | tenant RLS, scoped writes, immutable audit                                         | tenant context returns only authorized resources                  | Complete                          |
| Brand-specific instructions                      | versioned Profile editor                                                                                       | immutable Profile version/hash and historical audit binding                        | exact Profile injected into Pi prompt and exposed by MCP          | Complete                          |
| 20-plus GEO article strategies                   | 21 selectable templates with benefits and fit                                                                  | shared versioned catalog and persisted template attribution                        | catalog discovery plus governed draft input                       | Complete                          |
| Evidence-backed article production               | evidence/fact/content/version workspace                                                                        | closed references, deterministic rendering and hashes                              | Pi order is context -> template/Profile -> facts -> draft         | Complete                          |
| Platform variants and pre-publication audit      | Toutiao/Sohu/Ctrip previews, audit findings and grant state                                                    | server-rendered variants, immutable audit artifacts, one-time grants               | variant -> audit is mandatory before delivery                     | Complete                          |
| Unattended first-release automation              | batch scheduling and run/target readback                                                                       | actor-bound leases, checkpoints, idempotency, tenant mode and bounded quota writes | Producer is restartable and fixed to `dry_run`                    | Complete within Dry-run boundary  |
| Emergency controls                               | tenant and scoped Kill Switch, mode/quota settings, circuit controls, grant revoke and queued-job cancellation | ownership-checked transactional writes plus append-only audit log                  | Worker rechecks gates before execution                            | Complete                          |
| Query-set lifecycle                              | catalog, prompt editor, version history, activate and retire controls                                          | immutable versions, explicit activation, terminal retirement and audit hashes      | provider-neutral query discovery remains evidence-labelled        | Complete                          |
| API contract discovery                           | settings and operators use the same versioned API                                                              | generated OpenAPI 3.1 route/security inventory and `x-geo-api-version` negotiation | unsupported API versions fail before authenticated route handling | Complete for MVP route inventory  |
| Manual distribution handoff                      | export from a passed audit                                                                                     | hash-verified article/media package marked not published                           | no connector/network write                                        | Complete                          |
| Visibility measurement                           | fixture and manual evidence views                                                                              | repeated sample storage and provider/method labels                                 | fixture request tool only                                         | Complete within evidence boundary |

## Included gaps still being closed

- Final responsive visual acceptance after each remaining control-plane change.

## Explicitly deferred production capabilities

- Real Doubao/Qwen evaluation calls.
- Real Toutiao/Sohu/Ctrip publication connectors and platform readback.
- Production image generation.
- Automatic positive/negative feedback into long-term brand memory.

These deferred items are not configuration flags or hidden endpoints. Real Pi mode is available for article orchestration when a supported provider/model/key is configured, but article quality must still be evaluated against tenant facts, audit results and human review samples before production use.
