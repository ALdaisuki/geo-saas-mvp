import { createDatabase } from "../client.js";
import { migrateToLatest } from "../migrator.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabase({ connectionString, applicationName: "geo-migrator" });

try {
  const { error, results } = await migrateToLatest(database);

  for (const result of results) {
    console.info(`${result.status}: ${result.migrationName}`);
  }

  if (error) {
    throw error;
  }
} finally {
  await database.destroy();
}
