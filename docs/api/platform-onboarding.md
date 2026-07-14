# Platform API Onboarding Evidence Checklist

## Current decision

As of 2026-07-14, this project has not verified an ordinary public article-publishing API for Toutiao, Sohu or Ctrip Community. All three remain `manual_only` in capability reporting and `dry_run` in seeded account execution levels. No operator may change a label, add a key or enable browser automation to represent them as `public_api`, `partner_api` or unattended.

## Evidence bundle

Create one versioned bundle per platform/account/environment. It must contain:

- platform legal name, product surface, account ID and tenant ID;
- authorization basis: public developer terms or signed partner agreement, permitted automation, content type and territory;
- official documentation URL, captured version/date, endpoint base URL and environment (sandbox/production);
- developer application/client ID, approved OAuth/API scopes and credential secret-manager reference (never the secret);
- article create/draft/publish/status/read/delete endpoint contracts and exact content/media limits;
- rate, daily publishing, concurrency and account quotas plus platform-policy restrictions;
- redacted publish request/response fixture with request ID, external content ID and timestamps;
- independent status/readback proving the same account, external ID/URL, title/body/media hash and publication state;
- idempotency/retry behavior, including timeout-after-acceptance and duplicate prevention;
- error taxonomy for auth, validation, moderation, quota, retryable, permanent and uncertain outcomes;
- webhook/poll signature verification and replay protection where applicable;
- credential rotation/revocation test, Kill Switch test, rollback/delete policy and incident contact;
- reviewer, review date, expiry/revalidation date, evidence hashes and ticket/commit references.

Screenshots, blog posts, third-party SDK claims, creator UI behavior or a successful login do not prove a supported API.

## Capability decision

| Requested capability | Minimum acceptable evidence                                                                  | Maximum execution level                                     |
| -------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `manual_only`        | no verified API; audited preview/manual handoff only                                         | effective account policy decides; current seed is `dry_run` |
| `browser_assisted`   | approved browser use, authenticated screenshot/readback, challenge handling owned by a human | `assisted`, never unattended                                |
| `partner_api`        | signed/approved partner access, verified publish plus independent reconciliation             | may become unattended-eligible after all governance gates   |
| `public_api`         | official public docs/scopes, verified publish plus independent reconciliation                | may become unattended-eligible after all governance gates   |

The capability probe must reject empty/stale references, evidence that does not verify article publishing, and API evidence without reconciliation. A capability upgrade is a reviewed data/config change followed by connector contract tests; it is not an environment-variable toggle.

## Implementation gates

1. Add a platform-specific connector implementing validation, render, preflight, submit/publish, poll, reconcile and evidence capture.
2. Preserve tenant/account/platform/payload/audit/idempotency hashes at every boundary.
3. Add provider contract tests against an authorized sandbox and negative tests for wrong account, expired credential, duplicate key, timeout ambiguity, moderation and rate limits.
4. Add a platform readback that cannot be satisfied by the request response itself.
5. Prove tenant/platform/account Kill Switch behavior and bounded quotas on real PostgreSQL.
6. Run supervised canaries with manual final approval. Keep unattended off until error budgets and reconciliation are reviewed.
7. Store the capability report and evidence references; never store credentials in evidence.

## Doubao and Qwen provider onboarding

Visibility APIs are separate from publishing APIs. For each domestic AI product, record the exact product surface, official endpoint, model ID/version, whether search is enabled, geography, locale, citations behavior and sampling timestamp. An API model that lacks the consumer product's retrieval surface must not be described as measuring that product's search visibility. Compare repeated runs and controls; do not map Google ranking to Doubao/Qwen visibility.
