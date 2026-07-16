---
status: draft
date: 2026-07-16
topic: ctrip-bridge-authority
---

# Ctrip Bridge Authority Engineering Patterns

## Problem

The durable Ctrip handoff already hashes and expires a one-time submit permit, but
the same `lease_owner_actor_id` currently issues and consumes it. A future isolated
bridge would therefore have to impersonate the human operator or bypass the lease.
Neither option preserves explicit human approval.

## Patterns To Reuse

### Exact service identity

The publication Worker maps each tenant to one active service principal and
rechecks its kind, status and tenant before data access. Reuse that pattern for a
`ctrip_bridge` integration principal: the handoff binds one exact principal ID,
and every bridge mutation rechecks the principal profile and capability.

This solves cross-tenant or generic-worker execution. The existing shared
`geo_runtime` role alone cannot prove which subsystem is acting, so role grants
remain only the outer ACL and the actor row is the authoritative inner check.

### API guard plus database authority check

Operator endpoints already require `publish:request` and CSRF. Database permit
functions must independently require an active tenant membership whose effective
capabilities include `publish:request`. This protects the irreversible boundary if
an internal caller reaches the function without passing through the expected API
route.

### Hashed, one-time capability tokens

Publication grants and assisted submit permits persist only SHA-256 hashes, bind
the token to immutable scope, expire quickly and consume atomically under a row
lock. Reuse the same pattern while additionally persisting the human issuer actor
and the bridge consumer principal. The raw permit is returned once and never
logged or stored.

## Patterns Not To Reuse

- The current single actor for operator lease and bridge execution cannot be
  extended safely.
- A generic `geo_runtime` grant is not sufficient authorization for a bridge.
- Pi Agent, arbitrary URLs, selectors, headers or JavaScript cannot become bridge
  inputs.
- Browser screenshots cannot confirm public publication; independent readback
  remains a separate later boundary.

## Resulting Rule

A Ctrip submit is eligible only when one active human operator owns the current
lease, that same operator issued the unexpired permit, and one separately bound
active `ctrip_bridge` principal consumes it. Removing either identity makes the
operation impossible.
