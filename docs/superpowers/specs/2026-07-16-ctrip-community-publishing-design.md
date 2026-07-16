# Ctrip Community Supervised Publishing Design

## Decision

The first Ctrip Community module is a supervised publishing bridge, not an
unattended browser bot. It turns an audited Ctrip variant into a durable operator
handoff, prepares an authenticated draft through an isolated bridge after
capability approval, requires a human final-submit action, and confirms publication
only through independent readback.

No checked-in switch, URL, cookie or credential may upgrade the capability. The
default connector remains `manual_only` and `dry_run` until the account carries a
reviewed, current `browser_assisted` evidence bundle.

## Goals

- Preserve tenant, account, platform, variant, payload, audit and idempotency scope
  from grant consumption through public readback.
- Render Ctrip-specific title, body, topics and media from the frozen platform
  variant without accepting arbitrary operator text.
- Support authenticated-session validation, draft preparation, challenge handoff,
  explicit final-submit approval, evidence capture and independent reconciliation.
- Make every ambiguous submit non-retryable until reconciliation resolves it.
- Recheck Kill Switch, circuits, quotas, grant/audit expiry and handoff ownership
  immediately before the irreversible submit action.
- Keep the bridge replaceable by a documented Ctrip partner API without changing
  the upstream content/audit/grant model.

## Non-goals

- CAPTCHA, SMS, QR-login, device-fingerprint or risk-control bypass.
- Reusing affiliate/open-platform APIs for community publication.
- Calling undocumented internal endpoints directly.
- Allowing Pi Agent, the web client or arbitrary worker input to drive selectors,
  URLs or final submit.
- Treating draft preparation, screenshots or request acceptance as confirmation.
- Enabling `unattended` for `browser_assisted` accounts.

## Components

### `CtripCommunityConnector`

Lives in `packages/connectors`. It owns platform rendering, capability checks,
scope/hash validation and the connector result taxonomy. It depends on a narrow
`CtripAssistedSessionPort`; it does not import Playwright or store credentials.

The first implementation supports:

- the existing deterministic `dry_run` path;
- a fail-closed assisted contract whose transport must be injected explicitly;
- challenge and ambiguous-submit results that never become confirmed receipts;
- independent readback validation before returning `confirmed`.

### Isolated publisher bridge

Runs outside Pi Agent and the API process. Its future production implementation
uses a headed, human-authenticated browser or approved device session. It receives
only a signed handoff ID and retrieves the immutable payload from the API. Origins,
navigation and upload paths are server-controlled allowlists. Session material is
kept in an encrypted local profile or secret store and is never returned to GEO.

### API and database handoff

Migration `0017_ctrip_assisted_handoffs.sql` implements
`publication_assisted_handoffs` with tenant RLS:

```text
id, tenant_id, job_id, attempt_id, channel_account_id, variant_id
platform = ctrip_community
payload_hash, audit_hash, preview_hash, idempotency_key
state, lease_owner, lease_expires_at, expires_at
session_evidence_hash, draft_evidence_hash, submit_evidence_hash
external_id, external_url, created_at, updated_at
```

No cookie, bearer, mobile number, QR token or raw screenshot belongs in this row.
Evidence blobs use the existing evidence store; the row contains hashes and
redacted references only.

## State machine

```text
queued
  -> handoff_pending
  -> session_required | challenge_required | draft_prepared
  -> awaiting_operator_submit
  -> submitted_unconfirmed
  -> readback_pending
  -> confirmed

challenge_required -> draft_prepared                 operator resolves challenge
submitted_unconfirmed -> needs_review                inconclusive/expired readback
any pre-submit state -> cancelled | expired | failed
```

`draft_prepared` and `awaiting_operator_submit` prove no publication. The outbox
event may be acknowledged after the durable handoff is created; bridge work has its
own lease. A successful final click immediately creates an unconfirmed
`browser_screenshot` receipt and a required readback. Network loss after the click
also creates an uncertain receipt and proceeds to reconciliation, never automatic
resubmission.

## Connector port

```ts
interface CtripAssistedSessionPort {
  validateSession(scope): Promise<SessionProbe>;
  prepareDraft(request): Promise<DraftPreparation>;
  submitWithOperatorApproval(request): Promise<SubmitObservation>;
  readback(request): Promise<PublicReadback>;
  captureEvidence(request): Promise<EvidenceReference>;
}
```

Transport inputs contain fixed typed fields only. They do not contain a URL,
selector, JavaScript expression, filesystem path or arbitrary headers. The bridge
selects the reviewed platform adapter version.

## Ctrip payload mapping

The connector maps only the frozen `PublicationVariantPayload`:

- `title` -> Ctrip travel-note title;
- `bodyMarkdown` -> normalized section blocks with unsupported markup removed;
- `tags` -> reviewed Ctrip topics, preserving the policy maximum;
- `media` -> exact audited assets in payload order, with `4:3` cover first;
- `summary` -> handoff/readback comparison metadata unless the authenticated
  editor proves a separate summary field.

Current policy limits remain conservative inputs. They are not described as
current Ctrip limits until authenticated evidence confirms them.

## Security and governance

- Account capability must be `browser_assisted`, status `active`, execution level
  `assisted`, and evidence current at both job creation and bridge lease.
- Pi Agent can request content/audit operations but cannot issue the grant, lease a
  handoff, operate the bridge or approve final submit.
- The one-time submit permit is bound to tenant/account/job/attempt/payload/audit
  hashes and expires within minutes.
- The bridge rechecks tenant, platform and account Kill Switches and circuits
  immediately before submit. Failure or timeout denies the click.
- Screenshots are redacted before storage. Logs exclude body text, cookies,
  authorization headers and personally identifying session data.
- A challenge opens the account circuit and pauses new assisted work until an
  operator restores and re-verifies the session.

## Error taxonomy

| Condition                | Result                  | Retry rule                            |
| ------------------------ | ----------------------- | ------------------------------------- |
| Session absent/expired   | `SESSION_REQUIRED`      | operator action                       |
| CAPTCHA/SMS/risk control | `CHALLENGE_REQUIRED`    | never bypass; operator action         |
| UI adapter mismatch      | `ADAPTER_DRIFT`         | open circuit; deploy reviewed adapter |
| Payload/media validation | `PAYLOAD_REJECTED`      | permanent; new variant/audit          |
| Pre-submit Kill Switch   | `POLICY_BLOCKED`        | no external write                     |
| Timeout before click     | `NOT_SUBMITTED`         | safe bounded retry                    |
| Timeout after click      | `SUBMIT_UNCERTAIN`      | reconcile only                        |
| Moderation pending       | `SUBMITTED_UNCONFIRMED` | poll/readback                         |
| Public content mismatch  | `READBACK_MISMATCH`     | needs review; no retry                |

## Delivery increments

### Increment 1: contract and fail-closed registry

- Add `CtripCommunityConnector`, typed session port and contract tests.
- Preserve dry-run behavior in the default registry.
- Reject assisted mode unless an approved transport and current capability evidence
  are injected.
- Test wrong tenant/account, payload mutation, challenge and uncertain outcomes.

### Increment 2: durable handoff control plane

Implemented:

- RLS table, immutable request bindings and guarded state transitions;
- database handoff creation and one-time submit-permit functions;
- operator list/get/claim/heartbeat/cancel endpoints and Publishing queue;
- real PostgreSQL coverage for Kill Switch denial, tenant isolation, lease ownership,
  current-operator-only permit consumption, bounded expiry and consumed-but-unobserved
  `uncertain` recovery.

Still required before Increment 2 is operational:

- wire the Worker to create a handoff after an authorized assisted attempt;
- enable assisted publication requests only after that Worker path and its recovery
  contract are verified.

Until those items exist, the table and API are a dormant control plane and cannot
cause a Ctrip network write.

### Increment 3: authenticated canary adapter

- Inspect an authorized Ctrip account with written browser-assistance permission.
- Pin reviewed origins and an adapter version from authenticated evidence.
- Run one supervised draft-only canary, then one explicit-submit canary.
- Verify public URL readback, exact content/media binding and challenge behavior.

### Increment 4: partner API replacement

- Implement the same port with documented create/publish/status contracts.
- Add idempotency, timeout ambiguity, signature and independent readback tests.
- Consider `unattended` only after capability evidence, error budgets and incident
  review pass; browser automation never becomes unattended merely by maturity.

## Acceptance criteria

- Default deployments still perform no Ctrip network write.
- Assisted execution cannot be created for `manual_only`, disabled, stale-evidence
  or unattended accounts.
- Every handoff and evidence reference is tenant/account/job/payload/audit bound.
- Payload mutation after audit fails before session use.
- Challenges stop the workflow without automation bypass.
- No automatic retry occurs after a possibly accepted final submit.
- A screenshot-only result remains unconfirmed.
- Only independent readback can transition the job to `confirmed`.
- Kill Switch tests cover before handoff, before final submit and during recovery.
