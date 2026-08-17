import { readFile } from "node:fs/promises";

import { createDatabase } from "../client.js";
import {
  bindHistoricalPublication,
  formatHistoricalPublicationBindingOutput,
  loadHistoricalPublicationDatabaseUrl,
} from "../historical-publication.js";

const [inputFile, unexpected] = process.argv.slice(2);
if (inputFile === undefined || unexpected !== undefined || inputFile.startsWith("-")) {
  throw new Error("Usage: pnpm db:bind:historical-publication -- /absolute/path/to/manifest.json");
}

const contents = await readFile(inputFile, "utf8");
if (Buffer.byteLength(contents, "utf8") > 2_000_000) {
  throw new Error("Historical publication binding manifest exceeds 2000000 bytes");
}
let manifest: unknown;
try {
  manifest = JSON.parse(contents) as unknown;
} catch {
  throw new Error("Historical publication binding manifest must be valid JSON");
}

const database = createDatabase({
  connectionString: loadHistoricalPublicationDatabaseUrl(),
  applicationName: "geo-bind-historical-publication",
  maxConnections: 1,
});

try {
  const result = await bindHistoricalPublication(database, manifest);
  console.info(JSON.stringify(formatHistoricalPublicationBindingOutput(result)));
} finally {
  await database.destroy();
}
