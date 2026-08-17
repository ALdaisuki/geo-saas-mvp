# Ctrip Production Acceptance Runbook

## Non-negotiable controls

Live Ctrip operation is accepted in three phases. A deployment, healthy container, logged-in browser,
passed content audit, or edited env file is not phase approval. The persistent database acceptance
gate is authoritative and must bind approval evidence to the tenant, channel account, exact canary,
and content identity.

The default production state is `CTRIP_BRIDGE_MODE=browser_draft` with
`AUTOMATION_PRODUCER_ENABLED=false`. It can prepare a draft but has no submit capability. Missing
gate state, Plastic Promise MCP, real Pi provenance, audit evidence, rights evidence, tenant binding,
session validity, or content-hash agreement fails closed.

If Plastic Promise is intentionally paused or its backend is unfinished, stop at image build,
Compose rendering, and isolated Browser Host checks. Do not run `scripts/start-production.sh`, start
API/Agent MCP, create a real Pi run, or begin Phase A; those processes establish the governance
transport during startup or execution.

If the external governance transport is healthy but tenant memory retrieval is temporarily forbidden,
set `GEO_CONTEXT_RETRIEVAL_ENABLED=false`. GEO then removes `plastic_context_supply` from the Pi tool
set and rejects direct retrieval before transport. Pi may draft from GEO tenant context, templates,
Brand Agent Profiles, and verified facts while the mandatory `audit_pre_check` and `defense`
publication gates remain fail closed. This is not a Phase A governance exception: the external
governance transport and every normal acceptance gate must be healthy before Phase A. Re-enable
retrieval only after the memory backend and the operator are ready.

Migration `0042_ctrip_release_phase_gate.sql` owns the gate.
`geo.ctrip_release_phase(channel_account_id)` returns `A`, `B`, or `C`;
`geo.ctrip_phase_b_canary_succeeded(channel_account_id)` reports whether the bound canary has
completed the full success proof. Treat these functions as the operational read contract. Do not
infer phase from an env value or edit the underlying rows manually.

`geo.ctrip_phase_b_canaries` is append-only with forced RLS. It binds tenant, channel account,
platform, handoff, authorizing operator, and authorization time. Unique constraints on
`(tenant_id, channel_account_id)` and `(tenant_id, handoff_id)` enforce one Phase B canary per account
and prevent reuse across accounts.

Never republish or use the historical article `123450005` as the canary. The canary must be a newly
approved item with its own immutable job/handoff and idempotency keys. Before Phase A, migrate that
article's publication identity and normalized public-content hash into the tenant publication history
used by duplicate-content audit. If the historical payload cannot be recovered and bound, keep Phase
A blocked; this rule cannot rely only on an operator reminder.

## Bind pre-existing publication history offline

Migration `0043_historical_publication_bindings.sql` provides the only supported import path for a
pre-existing Ctrip publication. It does not fetch Ctrip, call an MCP server or model, create a fake
publication job, or claim that an imported record passed the current publication workflow. The
append-only `geo.historical_publications` row is an offline provenance receipt and an authoritative
input to duplicate-content audit.

Complete this step only after the production tenant, initial owner, and tenant Ctrip channel account
exist. Recover the public title, public body, publication identity, and an independent offline capture
under the approved evidence procedure. Hash that capture as `evidence.sha256`; do not substitute the
public-content hash or invent an evidence digest. Independently derive the normalized public-content
hash using `geo.ctrip-public-content.v1`. The CLI normalizes and recomputes it, then rejects any
disagreement. It never performs network recovery for the operator.

On the Linux server, create `/srv/geo-saas/secrets/historical-publication.json` as a regular,
non-symlink, single-link file owned by the deploy user with mode `0600`. Its exact schema is:

```json
{
  "schemaVersion": "geo.historical-publication-binding.v1",
  "tenantId": "<provisioning-receipt-tenant-uuid>",
  "actorId": "<active-owner-or-admin-user-uuid>",
  "channelAccountId": "<same-tenant-ctrip-channel-account-uuid>",
  "platform": "ctrip_community",
  "idempotencyKey": "approved-ticket:ctrip-history:<external-id>:v1",
  "externalId": "<1-to-20-digit-article-id>",
  "externalUrl": "https://m.ctrip.com/webapp/you/community/detail?articleId=<same-external-id>",
  "title": "<recovered-public-title>",
  "body": "<recovered-public-body>",
  "publicContentHash": "<lowercase-64-hex-normalized-public-content-hash>",
  "publishedAt": null,
  "observedAt": "<canonical-UTC-ISO-time-like-2026-07-20T03:00:00.000Z>",
  "evidence": {
    "sha256": "<lowercase-64-hex-offline-capture-digest>",
    "reference": "<approved-offline-evidence-reference>"
  }
}
```

Use a verified publication time when the evidence proves one; otherwise retain `publishedAt: null`
rather than guessing. After two-person review, run the DB-only commissioning action from the active
immutable release:

```bash
/srv/geo-saas/app/current/scripts/commission-production-db.sh bind-historical-publication
```

Preserve the credential-free JSON receipt. An exact replay with the same idempotency key, actor, and
all binding fields returns the same history and audit IDs with `wasCreated=false`. Reusing that key
with changed input, or attempting to bind an existing external ID, canonical URL, or public-content
hash under another key, fails closed. Only an active tenant owner or admin can bind; runtime callers
cannot insert or mutate history directly, and forced RLS prevents cross-tenant reads.

The launcher validates the fixed host file, then streams it to `/dev/stdin` in the one-shot DB tools
container. It does not relax the host file's `0600` mode for a container UID, bind-mount the evidence,
or place its path or content in the process arguments or environment.

The receipt must identify the intended tenant/account/external ID/hash and a
`historical_publication.bound` audit row. A CLI exit without that receipt, a content-hash mismatch, an
unverified actor/account, missing offline evidence, or any conflict leaves Phase A blocked. Remove the
manifest from the server secret directory after its receipt and evidence references have been
preserved under the approved retention policy.

| Phase                  | Bridge mode                                               | Producer          | Allowed external effect                                   |
| ---------------------- | --------------------------------------------------------- | ----------------- | --------------------------------------------------------- |
| A: prepare             | draft preflight, then `browser_supervised` for the canary | `false`           | Fill/upload only; no permit, click, or submit             |
| B: one canary          | the same `browser_supervised` adapter and handoff         | `false`           | Exactly one gate-bound permit and one click               |
| C: confirmed expansion | supervised readback, then separately approved mode        | initially `false` | Only after matching public readback of the Phase B canary |

## Preconditions for every phase

- The production tenant and Ctrip channel account are active and mapped to one active Bridge
  principal; browser, gateway, and Bridge tenant IDs match.
- The tenant Kill Switch and scoped automation controls are in the approved state for the exact
  operation. Broader enablement is never inferred from one canary approval.
- The real Pi trace contains `providerMode=pi_authored`, provider, model, provider run ID, and the
  terminal assistant request ID. Fixture or legacy-only trace data is rejected.
- Plastic Promise MCP is reachable through the GEO-only `172.30.11.2:10002` bridge and private
  Unix socket to its host
  loopback listener. API and Agent MCP handshakes and the current high-risk publication decision pass.
- Facts, policy, audit, licensed media, inspection bytes, public payload, channel account, and draft
  are content-bound by their expected hashes.
- A fresh, encrypted, off-host backup exists and restore has been rehearsed.
- Raw noVNC is reachable only through `ssh -L`; the public console route is session-authenticated
  and account-scoped, and CDP remains internal.

Do not proceed while any prerequisite is unknown. Do not weaken the production validator to make a
preflight pass.

## Phase A: prepare without submit

1. Confirm the server Secret initially contains `CTRIP_BRIDGE_MODE=browser_draft` and
   `AUTOMATION_PRODUCER_ENABLED=false`. This draft-only start is an infrastructure and authenticated
   profile preflight, not creation of the immutable canary handoff.
2. Confirm `geo.ctrip_release_phase(channel_account_id)` returns `A` and there is no canary row for
   this tenant/account. Do not create, claim, issue, or consume a submit permit in Phase A.
3. Start through `scripts/start-production.sh`; verify Bridge health reports draft mode and submit
   capability is false.
4. Open noVNC through the SSH tunnel, or use the authenticated account-scoped public console route,
   and authenticate to the exact tenant's Ctrip account. Do not share the profile with another
   tenant. Restart Browser Host once and verify the authenticated session returns from the same
   persistent profile before preparing content.
5. Stop the Bridge, change only its mode to `browser_supervised`, and restart it with Producer still
   disabled. Verify health reports the supervised adapter with prepare, submit, and readback
   capabilities. While the database phase remains A, permit issuance must still fail closed. Do not
   carry a `browser_draft` handoff across this mode change: handoffs are permanently bound to their
   adapter version.
6. Create one new canary workflow only after the supervised adapter is active, then let that same
   adapter fill text and upload the exact inspected media.
   Record tenant ID, channel account ID, job ID, handoff ID, content version, payload hash, media
   hashes, audit artifact, Pi provenance, adapter version, and browser artifact references.
7. Confirm the article came from the real Pi provider, not a fixture, and that the licensed search
   produced four or five distinct images. Run real visual inspection, GEO audit, and Plastic Promise
   governance before producing the final Ctrip payload.
8. Compare the visible editor title, body, four or five images, and controls against those immutable
   values. A platform challenge, login expiry, adapter drift, unexpected field, or mismatched hash
   stops the phase.
9. Obtain explicit user acceptance of the prepared draft. Phase A ends here; leave the item unsubmitted.

The draft-only preflight is not a receipt. The actual Phase A canary handoff is created under
`browser_supervised` and retains that exact adapter version through prepare, submit, and readback; no
handoff can be promoted into another adapter merely by changing `CTRIP_BRIDGE_MODE`.

## Phase B: one approved canary

Phase B requires a separate, durable operator decision for the exact Phase A canary. Record reviewer,
timestamp, ticket/reason, tenant, channel account, job/handoff, payload hash, adapter version, and the
maximum one-click scope. The tenant control must be `supervised` or `unattended`, the account control
must be `supervised`, and no Kill Switch, pause, or stop may be active.

1. Keep `AUTOMATION_PRODUCER_ENABLED=false` and the tenant-wide automation scope bounded.
2. Recheck the Phase A draft in noVNC. If Ctrip or the local payload changed, return to Phase A with a
   new canary identity; never reuse the approval.
3. Keep the exact `browser_supervised` instance and adapter version that prepared the canary. Restart
   only if operationally required, then recheck the same browser profile, handoff, visible payload,
   and expected submit/readback capabilities. An unattended adapter is not the Phase B path, and no
   permit exists yet.
4. Through the protected operator control plane, call
   `geo.issue_publication_assisted_submit_permit(handoff_id)` for the exact handoff. The function
   atomically creates the append-only canary binding and issues its operator-bound permit. It rejects
   a second canary, changed handoff/account, or ineligible control state.
5. Immediately before the click, recheck the gate, Kill Switch, lease, account, session, adapter
   evidence, public payload hash, and permit expiry. The bound Bridge consumes only that permit via
   `geo.consume_publication_assisted_submit_permit(handoff_id, permit)`.
6. Perform exactly one submit click. Preserve the accepted browser observation and immediately
   prevent any second permit/click.

If the click outcome, HTTP/navigation result, platform response, or timeout is ambiguous, mark the
handoff `uncertain`, keep automation disabled, and do not retry. Reconcile by independent public
readback and operator review. A consumed permit is never replayed.

## Phase C: verify before expansion

Phase C cannot be granted from a successful click alone. Independent public readback must find the
same Phase B canary and prove the public platform/account identity and normalized public-content hash
match the frozen payload. Store the public URL/article identity, observation time, evidence hash, and
reviewer decision. A missing, private, edited, duplicated, or mismatched item fails closed.

After the supervised click, invoke the explicit readback command on the same `browser_supervised`
handoff. This path performs independent public readback without another submit and does not use an
unattended queue claim. Do not switch the canary handoff to `browser_unattended`; its immutable adapter
binding would reject that change.

Promotion of the account to Phase C separately requires current unattended-adapter capability
evidence no older than 24 hours, including
`adapter:ctrip-community-browser-unattended-v1`. That account-level rollout evidence does not replace
the supervised canary's content-bound `platform_readback` and does not reopen its handoff.

`geo.ctrip_phase_b_canary_succeeded(channel_account_id)` becomes true only when the same canary job is
assisted, the handoff is confirmed, the bound operator issued the permit, the bound Bridge consumed
it, and the browser submit observation is either `accepted` or `uncertain`. An `uncertain` observation
is never rewritten; it qualifies only when independent readback is confirmed as `platform_readback`
with a non-empty evidence hash, `observed_payload_hash=public_content_hash`, and the public
`external_id` and URL are present.

Only after that proof may the user separately approve Phase C. Changing both tenant and account
controls to `unattended` is protected by the `automation_controls_ctrip_release_phase` trigger; it
fails closed until the bound canary succeeds. `geo.ctrip_release_phase(channel_account_id)` must then
return `C`. Automatic permit acquisition uses `geo.claim_next_ctrip_unattended_submit()` and remains
subject to the same gate on every claim.

For initial Phase C operation:

- keep Producer disabled while validating the transition and account scope;
- create unattended automation batches only through the authenticated batch API/Web control; the
  request defaults to `dry_run`, and both the repository and database target-insert trigger require
  every unattended target to be a Phase C Ctrip account;
- enable at most one approved tenant/account instance and concurrency `1`;
- select `browser_unattended` only when readback, challenge handling, Kill Switch, monitoring, and
  incident ownership have all been accepted;
- enable `AUTOMATION_PRODUCER_ENABLED=true` only as a separate explicit rollout decision;
- monitor prepare, permit, submit, readback, uncertain, challenge, and governance-denial events;
- roll back to `browser_draft` and Producer `false` on the first unexplained result.

Phase C does not authorize other tenants. Each tenant/account has an independent acceptance record,
browser profile, canary, evidence set, and rollout decision.

## Browser access

From the development workstation:

```bash
scripts/open-production-browser-tunnel.sh geo-production-host
```

Open `http://127.0.0.1:10007/vnc.html?autoconnect=1&resize=scale`. Close the tunnel after the bounded
operation. The helper clears config-defined forwards on an isolated SSH master, then adds only the
explicit loopback noVNC forward through the control socket. Never combine
`ClearAllForwardings=yes` and `-L` in one command because OpenSSH clears that explicit forward. Never
bind noVNC or CDP to a public interface, and never copy Chromium cookies into an env file, command,
log, backup manifest, or another tenant profile.

Tenant operators may instead open an account login from the public console. The browser URL must be
same-origin under `/ctrip-vnc/accounts/<account-id>/`; Caddy must receive a successful API
authorization for the current session and account before it forwards either static noVNC assets or
the account-matched WebSocket. A raw `http://127.0.0.1:10007` URL in a public handoff is a deployment
failure, not a supported fallback.

## Fail-closed and incident decisions

Immediately stop new work and activate the tenant Kill Switch when Plastic Promise is unavailable,
the Pi trace is incomplete, Ctrip requests reauthentication/challenge, the visible adapter surface
drifts, a content/media hash differs, a permit is unexpectedly present, readback disagrees, or an
operation becomes uncertain.

Preserve the database, `/srv/geo-saas/data/ctrip-runtime`, tenant browser artifacts, relevant profile,
and sanitized logs. Do not clear state or re-login over the evidence before the incident owner decides
whether readback or manual reconciliation is required. Resume only from a newly recorded gate decision;
an env change or process restart is not authorization.
