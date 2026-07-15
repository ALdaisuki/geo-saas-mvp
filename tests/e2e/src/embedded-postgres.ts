import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import { Client } from "pg";

export interface EmbeddedDatabase {
  readonly connectionString: string;
  close(): Promise<void>;
}

function executeFile(file: string, arguments_: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const process = spawn(file, arguments_, { stdio: "ignore", windowsHide: true });
    process.once("error", rejectPromise);
    process.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${file} ${arguments_.join(" ")} exited with code ${code}`));
    });
  });
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Unable to allocate a PostgreSQL test port");
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
  return address.port;
}

async function resolvePgControl(): Promise<string> {
  const platformPackage =
    process.platform === "win32" && process.arch === "x64"
      ? "@embedded-postgres/windows-x64"
      : process.platform === "linux" && process.arch === "x64"
        ? "@embedded-postgres/linux-x64"
        : process.platform === "linux" && process.arch === "arm64"
          ? "@embedded-postgres/linux-arm64"
          : process.platform === "darwin" && process.arch === "x64"
            ? "@embedded-postgres/darwin-x64"
            : process.platform === "darwin" && process.arch === "arm64"
              ? "@embedded-postgres/darwin-arm64"
              : undefined;
  if (platformPackage === undefined) {
    throw new Error(`Unsupported embedded PostgreSQL platform ${process.platform}/${process.arch}`);
  }
  const requireFromPackage = createRequire(import.meta.resolve("embedded-postgres"));
  const modulePath = requireFromPackage.resolve(platformPackage);
  const moduleValue: unknown = await import(pathToFileURL(modulePath).href);
  const pgControl =
    moduleValue !== null && typeof moduleValue === "object"
      ? (moduleValue as { pg_ctl?: unknown }).pg_ctl
      : undefined;
  if (typeof pgControl !== "string") {
    throw new Error(`PostgreSQL binary package ${platformPackage} does not export pg_ctl`);
  }
  return pgControl;
}

async function removeDatabaseDirectory(databaseDir: string): Promise<void> {
  const tempRoot = `${resolve(tmpdir())}${sep}`;
  const resolvedDirectory = resolve(databaseDir);
  if (!resolvedDirectory.startsWith(`${tempRoot}geo-e2e-postgres-`)) {
    throw new Error(`Refusing to remove unexpected PostgreSQL path: ${resolvedDirectory}`);
  }
  await rm(resolvedDirectory, { recursive: true, force: true });
}

export async function startEmbeddedDatabase(databaseName: string): Promise<EmbeddedDatabase> {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(databaseName)) {
    throw new TypeError("Test database name is invalid");
  }
  const port = await availablePort();
  const databaseDir = await mkdtemp(join(tmpdir(), "geo-e2e-postgres-"));
  const password = "geo-e2e-postgres-password";
  const diagnostics: string[] = [];
  const initializer = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password,
    authMethod: "scram-sha-256",
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-F"],
    createPostgresUser: false,
    onLog: (message) => diagnostics.push(String(message)),
    onError: (error) => diagnostics.push(String(error)),
  });
  let started = false;
  const pgControl = await resolvePgControl();
  try {
    await initializer.initialise();
    await executeFile(pgControl, [
      "-D",
      databaseDir,
      "-l",
      join(databaseDir, "postgres.log"),
      "-o",
      `-p ${port} -F`,
      "-w",
      "start",
    ]);
    started = true;
    const bootstrap = new Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password,
      database: "postgres",
    });
    await bootstrap.connect();
    try {
      await bootstrap.query(`create database ${databaseName}`);
    } finally {
      await bootstrap.end();
    }
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (started) {
      try {
        await executeFile(pgControl, ["-D", databaseDir, "-m", "fast", "-w", "stop"]);
      } catch (cleanupError) {
        cleanupErrors.push(
          `stop cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    try {
      await removeDatabaseDirectory(databaseDir);
    } catch (cleanupError) {
      cleanupErrors.push(
        `directory cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw new Error(
      `Embedded PostgreSQL startup failed: ${error instanceof Error ? error.message : String(error)}\n${[...diagnostics, ...cleanupErrors].join("\n")}`,
      { cause: error },
    );
  }

  const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${databaseName}`;
  return {
    connectionString,
    close: async () => {
      if (started) {
        await executeFile(pgControl, ["-D", databaseDir, "-m", "fast", "-w", "stop"]);
        started = false;
      }
      await removeDatabaseDirectory(databaseDir);
    },
  };
}
