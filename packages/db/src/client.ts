import { Kysely, PostgresDialect } from "kysely";
import { Pool, type PoolConfig } from "pg";

import type { Database } from "./types.js";

export interface DatabaseOptions {
  connectionString: string;
  applicationName?: string;
  idleTimeoutMillis?: number;
  maxConnections?: number;
  ssl?: PoolConfig["ssl"];
}

export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  const pool = new Pool({
    application_name: options.applicationName ?? "geo-saas",
    connectionString: options.connectionString,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    max: options.maxConnections ?? 10,
    options: "-c search_path=geo,public",
    ssl: options.ssl,
  });

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
