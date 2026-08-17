import { hash, argon2id } from "argon2";

import { bootstrapOperator, loadBootstrapOperatorEnvironment } from "../bootstrap.js";
import { createDatabase } from "../client.js";

const environment = loadBootstrapOperatorEnvironment();
const passwordHash = await hash(environment.password, {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});
const database = createDatabase({
  connectionString: environment.connectionString,
  applicationName: "geo-bootstrap-operator",
  maxConnections: 1,
});

try {
  const result = await bootstrapOperator(database, {
    tenantSlug: environment.tenantSlug,
    email: environment.email,
    displayName: environment.displayName,
    passwordHash,
  });
  console.info(
    JSON.stringify({
      event: "operator_bootstrap.completed",
      tenantId: result.tenantId,
      userId: result.userId,
      membershipId: result.membershipId,
    }),
  );
} finally {
  await database.destroy();
}
