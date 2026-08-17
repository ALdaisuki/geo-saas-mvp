import { createDatabase } from "../client.js";
import {
  commissionCtripBridge,
  formatCtripBridgeCommissioningOutput,
  loadCommissionCtripBridgeEnvironment,
} from "../ctrip-bridge-commissioning.js";

const environment = loadCommissionCtripBridgeEnvironment();
const database = createDatabase({
  connectionString: environment.connectionString,
  applicationName: "geo-commission-ctrip-bridge",
  maxConnections: 1,
});

try {
  const result = await commissionCtripBridge(database, environment);
  console.info(JSON.stringify(formatCtripBridgeCommissioningOutput(result)));
} finally {
  await database.destroy();
}
