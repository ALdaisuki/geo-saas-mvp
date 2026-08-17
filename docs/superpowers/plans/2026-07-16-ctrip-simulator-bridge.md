# Ctrip Simulator Bridge Increment 3B-B Plan

## Goal

Deliver an end-to-end, multi-tenant Ctrip assisted-publishing demonstration with
an isolated bridge and local simulator while keeping every real Ctrip network
write disabled.

## Tasks

1. Define bridge contracts and gateway:
   - strict prepare/submit/readback command and result schemas;
   - fixed per-tenant endpoint/credential parsing;
   - reject credentials in URLs, non-loopback simulator endpoints and unknown
     response fields;
   - add timeout and redacted error behavior.
2. Add `apps/ctrip-bridge`:
   - explicit simulator-only startup mode;
   - fixed adapter version and deterministic simulator state;
   - PostgreSQL control-plane port using the configured tenant and bridge actor;
   - no runtime URL/selector/script inputs;
   - unit tests for prepare, one-shot submit, uncertain outcome and readback.
3. Add migration `0020_ctrip_submit_observations.sql`:
   - normalized submit/readback columns and constraints;
   - atomic submit observation, unconfirmed receipt and required readback;
   - live confirmation vs simulator-only review behavior;
   - terminal-state and no-resubmit enforcement;
   - grants, ACL contract tests and PostgreSQL integration coverage.
4. Extend the API:
   - fixed `CtripBridgeGateway` option and server configuration;
   - operator prepare/submit/readback command routes;
   - bridge command payload derived only from authenticated tenant and handoff ID;
   - repository views for observation/readback state;
   - unavailable, timeout and post-submit uncertain error mapping.
5. Extend the Web Publishing view:
   - prepare, approve-submit and readback icon actions by state;
   - simulator/unconfirmed/readback/needs-review status presentation;
   - no raw permit display in the integrated flow;
   - API-client, component and accessibility tests.
6. Add browser-level simulator verification:
   - simulator surface is nonblank and contains the exact draft;
   - one submit creates exactly one simulated item;
   - readback cannot be presented as a live confirmation;
   - desktop and mobile Publishing controls do not overlap.
7. Update runtime examples and operator docs while keeping production bridge
   disabled unless all explicit simulator variables are present.

## Verification

```powershell
$env:TEMP='D:\GEO\.runtime\tmp'
$env:TMP='D:\GEO\.runtime\tmp'
pnpm --filter @geo/ctrip-bridge test
pnpm --filter @geo/api test
pnpm --filter @geo/web test
pnpm --filter @geo/db test
pnpm --filter @geo/db test:integration
pnpm e2e
pnpm e2e:web
pnpm verify:mvp
git diff --check
```

## Live Boundary

This increment exits with a production-faithful simulator and durable governance
flow only. A live adapter remains a separate reviewed change requiring written
Ctrip/account authorization, current authenticated-surface evidence, a public
readback contract and an explicitly approved canary.
