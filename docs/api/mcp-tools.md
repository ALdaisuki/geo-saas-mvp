# GEO MCP Tools and Evidence Boundaries

## Transport and authority

`agent-mcp` exposes Streamable HTTP `POST /mcp` and unauthenticated `GET /health/live` on container port `9021`. MCP requests are limited to 1 MiB, require a configured Host, allow only configured Origins, and require a bearer token from `MCP_PRINCIPALS_JSON`.

The bearer credential is mapped to an API email/password/tenant login. Seed users cannot satisfy this login. Each tool then checks the principal capability, input `tenantId`, and referenced resource scope through the API. Tool schemas are a static allowlist; arbitrary names and dynamically discovered tools are denied.

Pi Agent v0.73.1 does not contain MCP support. `packages/agent` contains a narrow bridge/runtime library. The current Compose file does not run a Pi process, but the API does connect to an external Plastic Promise MCP endpoint before startup. Publication requests call only `audit_pre_check` and `defense`; a denial, malformed result or transport failure blocks grant consumption. Adding a Pi service must preserve the static destination/tool allowlist and deterministic API authorization.

## Tool inventory

| Tool                      | Principal capability | Main input                                                 | Effect                                                                          |
| ------------------------- | -------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `geo_tenant_context`      | `tenant:read`        | `tenantId`                                                 | Read tenant, contacts, accounts and capability reports                          |
| `geo_fact_lookup`         | `content:read`       | `tenantId`, `brandId`, `query`, optional `limit`           | Read tenant facts and evidence                                                  |
| `geo_draft_proposal`      | `content:write`      | tenant/brand/campaign, brief, optional fixture draft       | Create an API content item/version proposal                                     |
| `geo_variant_preview`     | `content:write`      | tenant, content version, account, platform                 | Create an immutable account/platform variant                                    |
| `geo_audit_request`       | `audit:run`          | tenant, variant, idempotency key                           | Run exact deterministic audit; cache returned grant in the MCP session registry |
| `geo_publication_request` | `publish:request`    | tenant, variant, account, execution level, idempotency key | Consume a grant previously returned in this process and enqueue a job           |
| `geo_visibility_request`  | `visibility:run`     | tenant, query-set version, `doubao                         | qwen`, sample count, idempotency key                                            | Request the API fixture visibility path |

`geo_publication_request` cannot create its own grant. The audit must pass, the actor must be eligible, the in-process pending grant must still be present/unexpired, and Plastic Promise must return a passing pre-check plus `allow` defense decision. Restarting agent-MCP clears its pending map. Requesting `unattended` in the schema does not make it allowed: governance, account capability, database grant logic, automation control and connector policy still apply.

## Publishing evidence boundary

| Value                | Meaning                                                         | Valid claim                                                                          |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `fixture`            | deterministic test/generated input                              | test behavior only                                                                   |
| `preview`            | hashed rendered draft/connector response with `confirmed=false` | no external write occurred                                                           |
| `manual_import`      | human supplied observation/readback data                        | a human recorded this data; provenance must be reviewed                              |
| `browser_screenshot` | authenticated browser UI capture                                | UI state at a time; not sufficient alone for unattended API capability               |
| `api_response`       | response from a verified platform endpoint                      | one API exchange; must still reconcile account/content/status                        |
| `platform_readback`  | independent platform-side readback                              | strongest confirmation when bound to account, external ID/URL and exact content hash |

Current default connectors for `toutiao`, `sohu` and `ctrip_community` are `DryRunConnector`. They perform no network write and return preview receipts with `confirmed=false`, no external ID/URL and no publication time. A manual package (`article.md`, instructions and manifest hashes) is an assisted handoff, not a live receipt. Seeded channel accounts allow only `dry_run`.

`browser_assisted` may support human-assisted execution but never unattended execution. Only independently verified `public_api` or `partner_api` capability with publish and reconciliation evidence can become eligible for unattended mode, and all audit/grant/Kill Switch gates still apply.

## Visibility evidence boundary

| API path/mode                 | Stored method/type         | Interpretation                                                      |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------- |
| `/api/visibility-runs`        | `fixture` / `fixture`      | Synthetic Doubao/Qwen-labelled answers for deterministic tests      |
| `/api/visibility-runs/import` | `manual` / `manual_import` | Human captured answer, URLs, product surface, model and search mode |
| Official API                  | not implemented            | No claim permitted                                                  |
| Browser sampling              | not implemented            | No claim permitted                                                  |

Every real observation must retain provider product surface, model/version, search mode (`on|off|unknown`), locale, geography, prompt/query-set version, raw answer, citations and observation timestamp. Doubao/Qwen retrieval behavior must be measured directly; Google rank, one answer or fixture metrics cannot stand in for repeated domestic product observations.
