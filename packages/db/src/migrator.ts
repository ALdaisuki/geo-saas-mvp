import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Migrator,
  sql,
  type Kysely,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from "kysely";

import type { Database } from "./types.js";

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export const defaultMigrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));

export class SqlFileMigrationProvider implements MigrationProvider {
  readonly #directory: string;

  constructor(directory = defaultMigrationDirectory) {
    this.#directory = directory;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const fileNames = (await readdir(this.#directory))
      .filter((fileName) => MIGRATION_FILE_PATTERN.test(fileName))
      .sort();

    const migrations = await Promise.all(
      fileNames.map(async (fileName) => {
        const migrationName = fileName.slice(0, -".sql".length);
        const upSql = await readFile(join(this.#directory, fileName), "utf8");
        return [
          migrationName,
          {
            up: async (database: Kysely<unknown>) => {
              await sql.raw(upSql).execute(database);
            },
          } satisfies Migration,
        ] as const;
      }),
    );

    return Object.fromEntries(migrations);
  }
}

export interface MigrationSummary {
  error: unknown;
  results: readonly MigrationResult[];
}

export async function migrateToLatest(
  database: Kysely<Database>,
  migrationDirectory = defaultMigrationDirectory,
): Promise<MigrationSummary> {
  await sql`create schema if not exists geo`.execute(database);

  const migrator = new Migrator({
    db: database,
    migrationTableSchema: "geo",
    provider: new SqlFileMigrationProvider(migrationDirectory),
  });
  const { error, results = [] } = await migrator.migrateToLatest();

  return { error, results };
}
