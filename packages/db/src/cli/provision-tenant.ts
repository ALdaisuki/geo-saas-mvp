import { createDatabase } from "../client.js";
import {
  formatTenantProvisioningOutput,
  loadProvisionTenantEnvironment,
  provisionTenant,
} from "../provisioning.js";

const environment = loadProvisionTenantEnvironment();
const database = createDatabase({
  connectionString: environment.connectionString,
  applicationName: "geo-provision-tenant",
  maxConnections: 1,
});

try {
  const result = await provisionTenant(database, {
    idempotencyKey: environment.idempotencyKey,
    tenantSlug: environment.tenantSlug,
    legalName: environment.legalName,
    displayName: environment.displayName,
    industry: environment.industry,
    defaultLocale: environment.defaultLocale,
    brandCanonicalName: environment.brandCanonicalName,
    brandDisplayName: environment.brandDisplayName,
    contacts: environment.contacts,
    workerName: environment.workerName,
  });
  console.info(JSON.stringify(formatTenantProvisioningOutput(result)));
} finally {
  await database.destroy();
}
