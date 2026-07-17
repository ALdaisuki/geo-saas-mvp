import { createDatabase } from "../client.js";
import { configureCustomerDemo } from "../customer-demo.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
if (process.env.GEO_DEPLOYMENT_PROFILE !== "customer_demo") {
  throw new Error("Customer demo configuration requires GEO_DEPLOYMENT_PROFILE=customer_demo");
}

const database = createDatabase({
  connectionString,
  applicationName: "geo-customer-demo-configurator",
  maxConnections: 1,
});

try {
  await configureCustomerDemo(database);
  console.info(
    JSON.stringify({
      event: "customer_demo.configured",
      externalPublishingEnabled: false,
    }),
  );
} finally {
  await database.destroy();
}
