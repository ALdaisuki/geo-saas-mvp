# Ctrip Consumed Submit Recovery Plan

1. Add failing migration contract, ACL and PostgreSQL integration tests for
   consumed-but-unobserved recovery.
2. Add migration `0021_ctrip_submit_recovery.sql` with a bound, locked,
   idempotent recovery function and audit event.
3. Extend bridge handoff and fixed-adapter contracts, then recover and reload
   before readback without invoking submit.
4. Allow the API readback route only for `readback_pending` or consumed
   `awaiting_operator_submit` state.
5. Expose recovery status and the readback action in the Publishing view.
6. Run focused tests, PostgreSQL integration tests and `pnpm verify:mvp` with
   temporary files rooted at `D:\GEO\.runtime\tmp`.
7. Commit and push the verified branch to the private repository.
