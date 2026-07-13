import { createDatabase } from "../client.js";
import { seedDatabase } from "../seed.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabase({ connectionString, applicationName: "geo-seed" });

try {
  await seedDatabase(database);
  console.info("Database seed completed");
} finally {
  await database.destroy();
}
