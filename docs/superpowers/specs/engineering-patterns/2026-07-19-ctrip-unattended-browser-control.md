---
status: draft
---

# Governed Browser Publication Control

## Problem solved

The existing Ctrip implementation already separates content preparation, one-time submit permission, post-click observation, and readback. The missing capability is an unattended controller that advances those same durable states without replacing them with an in-memory browser script.

## Core pattern

Use the database state machine as the authority and keep browser actions narrow:

1. claim one prepared tenant-scoped handoff;
2. atomically issue a bridge-bound, short-lived submit permit;
3. re-read the exact title, body, media count, adapter version, audit and control state;
4. consume the permit before one fixed submit action;
5. never repeat the action after permit consumption;
6. load the candidate public URL and persist a platform readback before confirmation.

This reuses the current assisted handoff, recovery receipt, circuit breaker, kill switch and audit log rather than adding a second publication truth source.

## Not directly reusable

Generic browser automation examples commonly persist cookies, accept caller selectors, retry clicks after timeouts, or treat a success toast as publication proof. Those patterns are incompatible with this project. Authentication remains in the operator-owned browser profile, selectors and target origins are source-compiled, post-click uncertainty permits readback only, and public confirmation requires payload-matching evidence.
