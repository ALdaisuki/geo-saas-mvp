---
status: draft
date: 2026-07-17
topic: ctrip-draft-only-automation
---

# Ctrip Draft-Only Automation Engineering Patterns

## What problem is being solved?

The existing Ctrip flow can create a tenant-scoped, audit-bound assisted handoff,
and the Bridge can validate trusted media, but production preparation still stops
at read-only discovery. In addition, its preparation records currently depend on
the human operator lease used by the later publication boundary. That prevents
unattended draft preparation without also broadening publication authority.

The authenticated surface evidence supplies the missing concrete contract: one
picture-text page contains stable Draft.js title/body editors, a hidden image file
input, and a separate draft-save action. Docker Desktop testing also proves that
the container can connect to the dedicated Windows Edge session only through a
fixed host/header/WebSocket rewrite.

## Which core patterns are reusable?

### Narrow fixed adapter

The existing browser preflight adapter demonstrates a source-owned version and
explicit command capabilities. Reuse that structure, but replace its read-only
port with a draft writer whose method set can express only title fill, body fill,
one-file upload, draft save, and bounded result observation. The absence of a
generic locator/click/evaluate method is a stronger invariant than a runtime
check against a forbidden label.

### Exact service identity and separate leases

The Bridge authority design already binds one active `ctrip_bridge` principal to
each handoff, while final submit requires a human operator and a separate one-time
permit. Extend that separation backwards: the bridge principal claims a narrow
preparation lease; the human operator lease still controls every post-draft
transition. Both are checked again in PostgreSQL under a row lock.

### Audited content-addressed media

The manual publication package and simulator already rebuild each media reference,
bind it to the content version and platform role, read bytes from the tenant-
scoped content-addressed store, and independently verify length and SHA-256. The
live draft adapter should consume the same immutable trusted attachments in their
audited order and bind the manifest hash into its prepared evidence.

### Idempotent handoff plus bounded worker retry

The Worker already uses a job-scoped handoff idempotency key. Reuse that durable
identity and call Bridge prepare after create-or-reuse. Network/protocol failures
remain retryable; durable session/challenge/drift blockers are acknowledged as
explicit outcomes. An ambiguous browser save is not retried automatically.

### Fixed Docker Desktop transport

The tested connection uses `host.docker.internal` only as container transport,
while preserving the Windows loopback authority in the Host header and rewriting
only the discovered WebSocket authority. This is reusable as one compiled
deployment mode, with no arbitrary proxy/header input.

## What cannot be reused directly?

- The simulator's submit/readback implementation cannot be inherited by the live
  draft adapter; both methods must reject unconditionally.
- The human operator lease cannot authorize unattended preparation because that
  would erase the distinction between draft work and final publication consent.
- Generic Playwright or CDP execution APIs cannot be exposed to Worker, Pi Agent,
  tenant configuration, or MCP inputs.
- Markdown cannot be pasted directly into Ctrip's rich editor; the final audited
  platform text needs deterministic plain-text rendering and platform limits.
- Optional location, date, category, topic, or itinerary fields cannot be guessed
  from article prose.
- A successful draft save is not publication evidence and cannot produce a
  confirmed receipt or public URL.

## Adopted conclusion

Implement `browser_draft` as a deliberately incomplete external-action adapter.
Its incompleteness is the product boundary: unattended automation ends at a
durable, evidence-bound draft, and the user sees the real Ctrip page for the only
remaining action. Database identity and lease separation, not UI convention,
enforces that boundary end to end.
