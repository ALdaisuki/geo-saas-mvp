import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const rollbackScript = fileURLToPath(
  new URL("../../../scripts/rollback-production-release.sh", import.meta.url),
);
const rollbackSource = await readFile(rollbackScript, "utf8");
const currentSha = "1".repeat(40);
const targetSha = "2".repeat(40);
const temporaryRoots: string[] = [];

interface RollbackFixture {
  appRoot: string;
  currentLink: string;
  currentMarker: string;
  envFile: string;
  originalEnv: string;
  root: string;
  targetMarker: string;
  targetMigrations: string;
}

async function createRelease(appRoot: string, sha: string): Promise<string> {
  const release = join(appRoot, "releases", sha);
  const migrations = join(release, "packages", "db", "migrations");
  const scripts = join(release, "scripts");
  await mkdir(migrations, { recursive: true, mode: 0o750 });
  await mkdir(scripts, { recursive: true, mode: 0o750 });
  await writeFile(join(release, ".geo-release"), `${sha}\n`, { mode: 0o444 });
  await chmod(join(release, ".geo-release"), 0o444);
  await writeFile(join(scripts, "start-production.sh"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o555,
  });
  await chmod(join(scripts, "start-production.sh"), 0o555);
  await writeFile(join(migrations, "0001_foundation.sql"), "SELECT 1;\n");
  await writeFile(join(migrations, "0002_identity.sql"), "SELECT 2;\n");
  return release;
}

async function createFixture(): Promise<RollbackFixture> {
  const root = await mkdtemp(join(tmpdir(), "geo-release-rollback-"));
  temporaryRoots.push(root);
  const appRoot = join(root, "app");
  const releases = join(appRoot, "releases");
  const secrets = join(root, "secrets");
  await mkdir(releases, { recursive: true, mode: 0o750 });
  await mkdir(secrets, { mode: 0o700 });
  const currentRelease = await createRelease(appRoot, currentSha);
  const targetRelease = await createRelease(appRoot, targetSha);
  const currentLink = join(appRoot, "current");
  await symlink(`releases/${currentSha}`, currentLink);
  const originalEnv = [
    "COMPOSE_PROJECT_NAME=geo-saas",
    `GEO_IMAGE_TAG=${currentSha}`,
    `GEO_IMAGE_REVISION=${currentSha}`,
    "SESSION_SECRET=preserve-this-value",
    "",
  ].join("\n");
  const envFile = join(secrets, "geo.env");
  await writeFile(envFile, originalEnv, { mode: 0o600 });
  await chmod(envFile, 0o600);
  return {
    appRoot,
    currentLink,
    currentMarker: join(currentRelease, ".geo-release"),
    envFile,
    originalEnv,
    root,
    targetMarker: join(targetRelease, ".geo-release"),
    targetMigrations: join(targetRelease, "packages", "db", "migrations"),
  };
}

async function runTransaction(
  fixture: RollbackFixture,
  options: {
    appliedMigrations?: string;
    failSecondReplace?: boolean;
    migrationPolicy?: "forward_compatible" | "migration_ahead_recovery";
  } = {},
): Promise<{ stderr: string; stdout: string }> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("rollback transaction tests require a POSIX uid");
  const failureInjection = options.failSecondReplace
    ? `
      atomic_replace_calls=0
      atomic_replace() {
        ((atomic_replace_calls += 1))
        if ((atomic_replace_calls == 2)); then
          return 97
        fi
        atomic_replace_real "$@"
      }
    `
    : "";
  const command = `
    set -Eeuo pipefail
    source "$1"
    ${failureInjection}
    rollback_release_transaction "$2" "$3" "$4" "$5" "" "${options.migrationPolicy ?? "identical"}" "$6"
  `;
  return execFileAsync(
    "bash",
    [
      "-c",
      command,
      "rollback-test",
      rollbackScript,
      fixture.appRoot,
      fixture.envFile,
      targetSha,
      `${uid}`,
      options.appliedMigrations ?? "",
    ],
    { maxBuffer: 1024 * 1024 },
  );
}

async function runLedgerDiscovery(
  fixture: RollbackFixture,
  options: { appliedMigrations?: string; containerIds?: string } = {},
): Promise<{ stderr: string; stdout: string }> {
  const containerId = "a".repeat(64);
  const command = `
    set -Eeuo pipefail
    source "$1"
    MOCK_CONTAINER_IDS="$3"
    MOCK_APPLIED_MIGRATIONS="$4"
    docker_local() {
      case "$1" in
        ps) printf '%s\n' "\${MOCK_CONTAINER_IDS}" ;;
        inspect)
          case "$3" in
            *compose.project*) printf 'geo-saas\n' ;;
            *compose.service*) printf 'postgres\n' ;;
            *State.Status*) printf 'running\n' ;;
            *) return 1 ;;
          esac
          ;;
        exec) printf '%s\n' "\${MOCK_APPLIED_MIGRATIONS}" ;;
        *) return 1 ;;
      esac
    }
    query_applied_production_migrations "$2"
  `;
  return execFileAsync(
    "bash",
    [
      "-c",
      command,
      "rollback-ledger-test",
      rollbackScript,
      fixture.envFile,
      options.containerIds ?? containerId,
      options.appliedMigrations ?? "0001_foundation\n0002_identity",
    ],
    { maxBuffer: 1024 * 1024 },
  );
}

async function expectUnchanged(fixture: RollbackFixture): Promise<void> {
  expect(await readFile(fixture.envFile, "utf8")).toBe(fixture.originalEnv);
  expect(await readlink(fixture.currentLink)).toBe(`releases/${currentSha}`);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("production release rollback contract", () => {
  it("pins the production entrypoint to fixed local resources and fail-closed checks", () => {
    expect(rollbackSource).toContain("readonly APP_ROOT=/srv/geo-saas/app");
    expect(rollbackSource).toContain("readonly SECRET_ROOT=/srv/geo-saas/secrets");
    expect(rollbackSource).toContain("readonly LOCAL_DOCKER_HOST=unix:///var/run/docker.sock");
    expect(rollbackSource).toContain("production rollback runs only on Linux");
    expect(rollbackSource).toContain("run production rollback as the non-root deploy user");
    expect(rollbackSource).toContain("flock --nonblock 9");
    expect(rollbackSource).toContain("secret root mode must be exactly 700");
    expect(rollbackSource).toContain("existing rollback lock must have exactly one link");
    expect(rollbackSource).toContain("migration file lists differ; use the restore procedure");
    expect(rollbackSource).toContain("migration content differs for");
    expect(rollbackSource).toContain(
      "target migrations must preserve the current ordered set and may only append new files",
    );
    expect(rollbackSource).toContain(
      "usage: rollback-production-release.sh [--forward|--recover-migration-ahead] <full-target-commit>",
    );
    expect(rollbackSource).toContain("ROLLBACK_ENV_CHANGED=true\n  atomic_replace");
    expect(rollbackSource).toContain("ROLLBACK_CURRENT_CHANGED=true\n  atomic_replace");
    expect(rollbackSource.indexOf("existing rollback lock must be owned")).toBeLessThan(
      rollbackSource.indexOf('exec 9>"${LOCK_FILE}"'),
    );
    expect(
      rollbackSource.indexOf("existing rollback lock must have exactly one link"),
    ).toBeLessThan(rollbackSource.indexOf('exec 9>"${LOCK_FILE}"'));
    expect(rollbackSource.match(/recover_deployment_transaction "/gu)).toHaveLength(1);
    expect(rollbackSource).not.toContain("docker compose down");
  });

  it("ships the production entrypoint as an executable", async () => {
    await expect(access(rollbackScript, constants.X_OK)).resolves.toBeUndefined();
  });

  it("atomically switches the canonical env and current link after full validation", async () => {
    const fixture = await createFixture();

    await expect(runTransaction(fixture)).resolves.toMatchObject({
      stdout: expect.stringContaining(targetSha),
    });

    expect(await readlink(fixture.currentLink)).toBe(`releases/${targetSha}`);
    const updatedEnv = await readFile(fixture.envFile, "utf8");
    expect(updatedEnv).toContain(`GEO_IMAGE_TAG=${targetSha}\n`);
    expect(updatedEnv).toContain(`GEO_IMAGE_REVISION=${targetSha}\n`);
    expect(updatedEnv).toContain("SESSION_SECRET=preserve-this-value\n");
    expect(updatedEnv).not.toContain(currentSha);
  });

  it.each([
    ["current", "currentMarker"],
    ["target", "targetMarker"],
  ] as const)(
    "rejects a %s release marker mismatch without changing state",
    async (_name, markerKey) => {
      const fixture = await createFixture();
      await chmod(fixture[markerKey], 0o600);
      await writeFile(fixture[markerKey], `${"3".repeat(40)}\n`);
      await chmod(fixture[markerKey], 0o444);

      await expect(runTransaction(fixture)).rejects.toMatchObject({ code: 1 });
      await expectUnchanged(fixture);
    },
  );

  it.each([
    ["duplicate", `GEO_IMAGE_TAG=${currentSha}\n`],
    ["leading whitespace", `  GEO_IMAGE_REVISION=${currentSha}\n`],
  ])("rejects a %s release env alias without changing state", async (_name, extraLine) => {
    const fixture = await createFixture();
    fixture.originalEnv += extraLine;
    await writeFile(fixture.envFile, fixture.originalEnv, { mode: 0o600 });
    await chmod(fixture.envFile, 0o600);

    await expect(runTransaction(fixture)).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it.each([
    [
      "list",
      async (fixture: RollbackFixture) =>
        writeFile(join(fixture.targetMigrations, "0003_extra.sql"), "SELECT 3;\n"),
    ],
    [
      "content",
      async (fixture: RollbackFixture) =>
        writeFile(join(fixture.targetMigrations, "0002_identity.sql"), "SELECT 200;\n"),
    ],
  ])("rejects a migration %s mismatch without changing state", async (_name, mutate) => {
    const fixture = await createFixture();
    await mutate(fixture);

    await expect(runTransaction(fixture)).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it("allows a forward release to append migrations without changing prior bytes", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.targetMigrations, "0003_forward.sql"), "SELECT 3;\n");

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0001_foundation\n0002_identity",
        migrationPolicy: "forward_compatible",
      }),
    ).resolves.toMatchObject({ stdout: expect.stringContaining(targetSha) });
    expect(await readlink(fixture.currentLink)).toBe(`releases/${targetSha}`);
  });

  it("rejects a forward release that changes an existing migration", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.targetMigrations, "0002_identity.sql"), "SELECT 200;\n");
    await writeFile(join(fixture.targetMigrations, "0003_forward.sql"), "SELECT 3;\n");

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0001_foundation\n0002_identity",
        migrationPolicy: "forward_compatible",
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it("allows a forward repair to change only migrations absent from the database ledger", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.targetMigrations, "0002_identity.sql"), "SELECT 200;\n");

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0001_foundation",
        migrationPolicy: "forward_compatible",
      }),
    ).resolves.toMatchObject({ stdout: expect.stringContaining(targetSha) });
    expect(await readlink(fixture.currentLink)).toBe(`releases/${targetSha}`);
  });

  it("rejects a forward repair when the database ledger is not a current-release prefix", async () => {
    const fixture = await createFixture();

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0002_identity",
        migrationPolicy: "forward_compatible",
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it("recovers when the database ledger is ahead of current and exactly matches the target", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.targetMigrations, "0003_forward.sql"), "SELECT 3;\n");

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0001_foundation\n0002_identity\n0003_forward",
        migrationPolicy: "migration_ahead_recovery",
      }),
    ).resolves.toMatchObject({ stdout: expect.stringContaining(targetSha) });
    expect(await readlink(fixture.currentLink)).toBe(`releases/${targetSha}`);
  });

  it("rejects migration-ahead recovery unless the target exactly matches the database ledger", async () => {
    const fixture = await createFixture();

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0001_foundation\n0002_identity\n0003_forward",
        migrationPolicy: "migration_ahead_recovery",
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it("rejects migration-ahead recovery when the ledger is not an ordered extension of current", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.targetMigrations, "0003_forward.sql"), "SELECT 3;\n");

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0001_foundation\n0003_forward\n0002_identity",
        migrationPolicy: "migration_ahead_recovery",
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it("rejects migration-ahead recovery that rewrites an existing migration", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.targetMigrations, "0002_identity.sql"), "SELECT 200;\n");
    await writeFile(join(fixture.targetMigrations, "0003_forward.sql"), "SELECT 3;\n");

    await expect(
      runTransaction(fixture, {
        appliedMigrations: "0001_foundation\n0002_identity\n0003_forward",
        migrationPolicy: "migration_ahead_recovery",
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it("reads the applied migration prefix from the uniquely labelled running Postgres", async () => {
    const fixture = await createFixture();

    await expect(runLedgerDiscovery(fixture)).resolves.toMatchObject({
      stdout: "0001_foundation\n0002_identity",
    });
  });

  it("rejects migration-ledger discovery when multiple Postgres containers match", async () => {
    const fixture = await createFixture();

    await expect(
      runLedgerDiscovery(fixture, { containerIds: `${"a".repeat(64)}\n${"b".repeat(64)}` }),
    ).rejects.toMatchObject({ code: 1 });
    await expectUnchanged(fixture);
  });

  it("restores env and current when the second atomic replacement fails", async () => {
    const fixture = await createFixture();

    await expect(runTransaction(fixture, { failSecondReplace: true })).rejects.toMatchObject({
      code: 97,
    });
    await expectUnchanged(fixture);
  });
});
