# Ctrip Community Publishing Increment 1 Plan

## Scope

Implement the platform-specific connector contract and keep all production
external writes disabled by default. This increment proves scope, hash, capability,
challenge and evidence semantics; it does not claim a live Ctrip publication.

## Tasks

1. Extend `packages/connectors/src/types.ts` with assisted draft and evidence
   variants while preserving all current dry-run types.
2. Extend `packages/connectors/src/capabilities.ts` with explicit supervised
   session/challenge/adapter error codes.
3. Add `packages/connectors/src/ctrip-community-connector.ts`:
   - fixed `ctrip_community` platform;
   - deterministic rendering from `PublicationVariantPayload`;
   - injected `CtripAssistedSessionPort` with typed inputs and no arbitrary URL,
     selector, script, header or filesystem path;
   - current capability evidence required for assisted mode;
   - exact tenant/account/preview/request hash echo validation;
   - draft preparation only, returning an unconfirmed browser-evidence receipt;
   - challenge and adapter drift fail closed;
   - unattended execution rejected.
4. Update `packages/connectors/src/registry.ts` so an explicitly constructed Ctrip
   connector may be injected, while the default remains `DryRunConnector`.
5. Export the new contract from `packages/connectors/src/index.ts`.
6. Add contract tests covering:
   - unchanged default Dry-run behavior;
   - approved assisted capability and ready session;
   - deterministic request/receipt hashes;
   - no publication confirmation or public URL from draft preparation;
   - wrong tenant/account/hash echo rejection;
   - payload mutation rejection before session use;
   - session-required, challenge and adapter-drift behavior;
   - unattended rejection and incomplete constructor configuration.

## Verification

```powershell
pnpm --filter @geo/connectors test
pnpm --filter @geo/connectors typecheck
pnpm --filter @geo/worker test
pnpm --filter @geo/worker typecheck
pnpm format:check
pnpm lint
pnpm verify:mvp
git diff --check
```

The worker tests are required because the connector interface is shared even
though Increment 1 does not wire assisted execution into the worker CLI.

## Exit criteria

- A Ctrip assisted draft can be represented and tested without claiming live
  publication.
- No default runtime behavior or seeded account capability changes.
- Pi Agent still has no connector or browser tool.
- All existing Dry-run receipts and readback invariants remain valid.
- The next increment has a typed port to implement against an authorized session.
