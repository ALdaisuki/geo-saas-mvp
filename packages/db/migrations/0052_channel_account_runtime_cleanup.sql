-- A newly created Ctrip account has a tenant-scoped runtime binding even before
-- it has any publication history. Removing that account must remove only this
-- empty runtime binding; all publication and audit references remain protected
-- by their existing RESTRICT foreign keys.
ALTER TABLE geo.ctrip_account_runtime_bindings
  DROP CONSTRAINT IF EXISTS ctrip_account_runtime_binding_tenant_id_channel_account_id_fkey,
  ADD CONSTRAINT ctrip_account_runtime_binding_tenant_id_channel_account_id_fkey
    FOREIGN KEY (tenant_id, channel_account_id, platform)
    REFERENCES geo.channel_accounts (tenant_id, id, platform) ON DELETE CASCADE;
