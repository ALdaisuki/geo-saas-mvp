# Ctrip Bridge Authority Increment 3B-A Plan

## Goal

Separate operator approval from bridge execution and make the draft-preparation
control plane executable by a least-privilege, tenant-bound bridge principal. This
increment performs no Ctrip network I/O.

## Tasks

1. Extend shared contracts and authorization:
   - add `publish:bridge` without granting it to any human role;
   - add exact `ctrip_bridge` service-principal profile/capabilities;
   - add create-request and response contract tests.
2. Add `0019_ctrip_bridge_authority.sql`:
   - add bridge/permit identity and external draft columns;
   - add operator and bridge authority helpers;
   - add bound handoff creation and draft-evidence overloads;
   - add bridge status reporting with challenge/adapter-drift account circuit;
   - redefine permit issue/consume with different authorized identities;
   - revoke legacy unbound creation/draft execution.
3. Update Worker configuration and persistence:
   - require `bridgePrincipalId` in every Ctrip assisted mapping;
   - pass it into bound handoff creation;
   - validate replay binding and tenant/account separation.
4. Add operator API operations:
   - create a credential-less `ctrip_bridge` service principal;
   - issue a raw submit permit exactly once from a current operator lease;
   - never expose permit material in list/get/audit responses.
5. Reconcile ACL, database types, OpenAPI/docs and Web service-principal parsing.
6. Add negative and integration coverage for:
   - human/Worker/Pi/cross-tenant bridge permit consumption denial;
   - bridge self-issuance denial and operator consumption denial;
   - disabled/mismatched bridge denial;
   - session/challenge/draft state and exact adapter binding;
   - challenge/adapter drift circuit opening;
   - raw permit/cookie/authorization material absence.

## Verification

```powershell
pnpm --filter @geo/contracts test
pnpm --filter @geo/authz test
pnpm --filter @geo/worker test
pnpm --filter @geo/api test
pnpm --filter @geo/db test
$env:TEMP='D:\GEO\.runtime\tmp'
$env:TMP='D:\GEO\.runtime\tmp'
pnpm --filter @geo/db test:integration
pnpm verify:mvp
git diff --check
```

## Exit Boundary

The result may prepare and authorize an immutable draft control-plane transition,
but cannot log in to Ctrip, write a Ctrip draft, click final submit, create a live
receipt or confirm a public URL. Those require written account authorization and a
separately reviewed adapter canary.
