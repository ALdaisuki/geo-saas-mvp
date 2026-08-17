# Ctrip Multi-account Enrollment and Distribution

## Goal

Make adding a Ctrip account a durable, tenant-scoped operation and make new
automation batches distribute one slot to one eligible account by default.

## Account enrollment

Creating a Ctrip channel account also creates one runtime binding with an
opaque profile key and `session_required` state. The directory account is
active immediately, while unattended scheduling still requires the operator
to complete login in that account's isolated Browser Host and the bridge to
record an authenticated or ready session. No API accepts credentials, cookies,
or profile paths.

The binding is unique by `(tenant_id, channel_account_id)` and its profile key
is unique by tenant. The binding is the only source for account-level runtime
status; a green directory status without a ready binding is not schedulable.

## Distribution

The default batch request uses `platform_round_robin`: the operator selects a
platform and the server resolves the ordered eligible account pool and assigns
slots deterministically. The API persists the selected account in each run
target and records the policy and resolved pool snapshot in batch
configuration. Existing `round_robin` requests with an explicit account pool
and requests with per-slot `channelAccountIds` remain supported for
compatibility.

The database validates that every target belongs to the tenant and is active,
supports the execution level, is Ctrip for unattended work, and has a ready
runtime binding for unattended work. The persisted run list shows the exact
account for every slot. An operator may reassign a target only while it is
pending and its run is scheduled, unclaimed, at attempt zero, and has no
content, variant, audit, or publication resource. The first worker claim makes
the assignment immutable; retries retain that account.

## Capacity

Initial operations plan for 100 accounts per platform, but the hard directory
limit is 200 accounts for each `(tenant_id, platform)` pair. Inserts and
platform moves take a pair-scoped advisory lock before counting, so concurrent
requests cannot exceed the limit. Other tenants and other platforms have
independent capacity.

Each account starts with a 10-publication daily quota in `Asia/Shanghai` and a
maximum external-write concurrency of one. Account-scoped delivery controls
carry the same limits. Non-dry-run batch creation reserves capacity by account
and Shanghai calendar date under an account/day advisory lock; cancelled work
does not consume a reservation.

## Publishing wave

The publishing center can select one prepared handoff per account and submit
the selected accounts in parallel after one explicit confirmation. This is an
orchestration interface over the existing per-account publication module: each
handoff keeps its own grant, audit binding, job, receipt, readback, and failure
state. A partial failure is reported per wave and is never retried implicitly.
The same account cannot appear twice in one wave.

## Runtime boundary

The current single Browser Host deployment remains a one-account runtime until
dynamic account runtime provisioning is available. This change does not claim
production unattended support for a second account merely because its
directory row exists. The UI exposes `session_required` and keeps such an
account out of unattended distribution.

## Non-goals

- no credential or cookie ingestion;
- no sharing a browser profile between accounts;
- no automatic cross-account retry after submit;
- no claim that the local quotas are the platform's published rate limits;
  they are conservative tenant policy.
