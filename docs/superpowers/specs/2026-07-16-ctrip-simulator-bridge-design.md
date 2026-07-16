# Ctrip Simulator Bridge Increment 3B-B Design

## Decision

Increment 3B-B adds an isolated Ctrip bridge process and completes the assisted
handoff state machine against a deterministic local simulator. The simulator is
an executable proof of the control flow, not evidence that Ctrip publishing is
available.

Default and production deployments continue to perform zero Ctrip network
writes. No live adapter is included.

## Runtime Topology

```text
operator Web session
  -> GEO API (publish:request + CSRF)
     -> fixed CtripBridgeGateway (tenant credential selected server-side)
        -> isolated ctrip-bridge process
           -> fixed simulator adapter
           -> PostgreSQL geo_runtime connection
              with app.actor_id = bound ctrip_bridge principal
```

The bridge command accepts only a tenant-scoped handoff ID and, for final submit,
the one-time permit. It never accepts a destination URL, selector, script,
header, cookie, filesystem path, adapter module or principal ID.

The bridge process loads the immutable draft and bound principal from PostgreSQL,
renders it with `renderCtripCommunityAssistedDraft`, verifies the persisted
preview hash and then invokes the compiled adapter version.

## Identity And Credentials

- The operator remains an active human tenant membership.
- The API selects one fixed bridge endpoint and bearer credential by tenant from
  server environment configuration.
- The bridge selects its own tenant and `ctrip_bridge` service-principal ID from
  server environment configuration. Client input cannot override either value.
- Every bridge database mutation sets the tenant and bridge actor context and is
  re-authorized by the existing security-definer functions.
- Command bearer tokens, database passwords, submit permits and simulator session
  material are never stored in handoff rows or audit details.

## Bridge Commands

### Prepare

1. Load and validate the handoff, current operator lease, adapter version and
   exact rendered draft.
2. Probe the fixed adapter session.
3. Record `session_required`, `challenge_required` or adapter drift through the
   bridge-only status function; challenge and drift preserve the existing account
   circuit behavior.
4. When ready, prepare the simulator draft and record hash-only session/draft
   evidence plus its simulator draft reference.

### Submit

1. Consume the raw one-time permit through the bridge-only database function.
   This is the immediate governance check before crossing the submit boundary.
2. Invoke the fixed adapter exactly once.
3. Record one immutable normalized observation: `accepted`, `uncertain` or
   `rejected`.
4. Atomically create an unconfirmed receipt, required readback row and audit
   events, and advance the handoff through `submitted_unconfirmed` to
   `readback_pending`.
5. Never retry a consumed submit. A consumed permit without an observation is an
   explicit reconciliation condition, not a new-submit condition.

### Readback

1. Read from the adapter's public/readback surface without invoking submit.
2. Bind the observation to the expected account, payload hash and adapter
   version.
3. A live `platform_readback` may move to `confirmed` only with a matching public
   Ctrip HTTPS URL and external identifier.
4. Simulator evidence always moves to `needs_review` with
   `SIMULATION_ONLY`; it can never populate live external identity fields or
   create a confirmed claim.
5. Missing, mismatched or exhausted readback ends in `needs_review`; transient
   unavailability remains `readback_pending` until the bounded deadline.

## Persistence

Migration `0020_ctrip_submit_observations.sql` adds normalized observation fields
to the handoff and two bridge-only functions:

- `record_publication_assisted_submit_observation`
- `record_publication_assisted_readback`

Submit recording also finalizes the original publication attempt as `uncertain`,
marks the job `uncertain`, appends one unconfirmed assisted receipt and schedules
one required readback. The receipt remains immutable and unconfirmed; final truth
lives in the readback and handoff state rather than mutating prior evidence.

## Operator Surface

The existing Publishing view gains state-specific icon actions:

- prepare when a current operator lease exists and the handoff is pre-draft;
- approve submit when the exact draft is prepared;
- read back when the handoff is awaiting independent confirmation;
- retain heartbeat and cancellation within their existing state boundaries.

The view displays observation kind/outcome and clearly distinguishes simulator,
unconfirmed and confirmed states. Raw permits are not displayed by the integrated
submit action.

## Fail-Closed Behavior

- Without bridge gateway configuration, command endpoints return unavailable and
  do not mutate handoff state.
- The bridge starts only in explicit `simulator` mode in this increment.
- Non-loopback simulator origins are rejected.
- Unknown adapter versions fail before database evidence changes.
- A gateway timeout after submit is treated as potentially delivered; the UI
  reloads durable state and never automatically sends another submit.
- `submitted_unconfirmed` and `readback_pending` have no transition back to a
  submit-eligible state.

## Non-goals

- Real Ctrip login, draft creation, submit or public-page access.
- CAPTCHA, QR, SMS, device or risk-control bypass.
- Discovery or use of private Ctrip endpoints.
- User-authored browser automation.
- Unattended execution or bulk live rollout.
- Treating simulator output as production evidence.

## Acceptance Criteria

- An operator can run prepare, approve one simulated submit and request simulated
  readback from the Publishing view.
- Only the exact bound bridge principal can consume and record bridge evidence.
- Submit observation, receipt, required readback and audit events are durable and
  tenant isolated.
- An ambiguous outcome cannot be retried automatically.
- Simulator readback cannot produce `confirmed`, `external_id` or an external URL.
- Database, API, bridge and Playwright tests cover the successful simulator path,
  uncertain path, cross-tenant denial, disabled gateway and restart-visible state.
