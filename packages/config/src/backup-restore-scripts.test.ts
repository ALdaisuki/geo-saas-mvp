import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const verifyScript = join(repositoryRoot, "scripts/verify-backup-bundle.sh");
const verifySource = await readFile(verifyScript, "utf8");
const backupScript = join(repositoryRoot, "scripts/backup-production.sh");
const rehearsalScript = join(repositoryRoot, "scripts/rehearse-production-restore.sh");
const backupSource = await readFile(backupScript, "utf8");
const rehearsalSource = await readFile(rehearsalScript, "utf8");
const release = "0123456789abcdef0123456789abcdef01234567";
const backupId = "20260723T120000Z";
const project = "customer-production";
const temporaryRoots: string[] = [];

interface BundleFixture {
  readonly backupRoot: string;
  readonly bundle: string;
  readonly checksumFile: string;
}

interface FakeDockerOptions {
  readonly caddyOwner?: number;
  readonly failPgRestoreList?: boolean;
  readonly migrations?: readonly string[];
  readonly mountMismatch?: boolean;
  readonly project?: string;
  readonly replacePathOnStart?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tarHeader(name: string, type: "0" | "5"): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(type === "5" ? "0000700\0" : "0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write("00000000000\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function tarGzip(entries: readonly { readonly name: string; readonly type: "0" | "5" }[]): Buffer {
  return gzipSync(
    Buffer.concat([
      ...entries.map((entry) => tarHeader(entry.name, entry.type)),
      Buffer.alloc(1024),
    ]),
  );
}

async function makeTemporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function writeChecksums(fixture: BundleFixture): Promise<void> {
  const names = ["application-files.tar.gz", "images.json", "manifest.txt", "postgres.dump"];
  const lines = await Promise.all(
    names.map(async (name) => `${await sha256(join(fixture.bundle, name))}  ${name}`),
  );
  await writeFile(fixture.checksumFile, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function createBundle(root: string, composeProject = project): Promise<BundleFixture> {
  const backupRoot = join(root, "backups");
  const bundle = join(backupRoot, backupId);
  const checksumFile = join(backupRoot, `${backupId}.sha256`);
  const dataRoot = join(root, "archive-data");
  await mkdir(bundle, { recursive: true, mode: 0o700 });
  for (const name of ["evidence", "media", "ctrip-runtime"]) {
    await mkdir(join(dataRoot, name), { recursive: true });
  }
  await writeFile(join(dataRoot, "evidence", "evidence-1.json"), "{}\n");
  await writeFile(join(dataRoot, "media", "media-1.bin"), "media\n");
  await writeFile(join(dataRoot, "ctrip-runtime", "state-1.json"), "{}\n");
  const tarResult = spawnSync(
    "tar",
    [
      "-czf",
      join(bundle, "application-files.tar.gz"),
      "-C",
      dataRoot,
      "evidence",
      "media",
      "ctrip-runtime",
    ],
    { encoding: "utf8" },
  );
  expect(tarResult.status, tarResult.stderr).toBe(0);
  await writeFile(join(bundle, "postgres.dump"), "fake-custom-format-dump\n");
  await writeFile(join(bundle, "images.json"), '{"Service":"postgres"}\n');
  await writeFile(
    join(bundle, "manifest.txt"),
    [
      "manifest_version=2",
      `backup_id=${backupId}`,
      "created_utc=2026-07-23T12:00:00Z",
      `release=${release}`,
      `compose_project=${composeProject}`,
      "scope=postgres,evidence,media,ctrip-runtime",
      "caddy_state_policy=excluded-reissue",
      "postgres_dump=postgres.dump",
      "application_archive=application-files.tar.gz",
      "images_file=images.json",
      "",
    ].join("\n"),
  );
  const fixture = { backupRoot, bundle, checksumFile };
  await writeChecksums(fixture);
  return fixture;
}

async function createFakeDocker(
  root: string,
  options: FakeDockerOptions = {},
): Promise<{ readonly docker: string; readonly log: string; readonly binDirectory: string }> {
  const binDirectory = join(root, "fake-bin");
  const docker = join(binDirectory, "docker");
  const sudo = join(binDirectory, "sudo");
  const flock = join(binDirectory, "flock");
  const stat = join(binDirectory, "stat");
  const timeout = join(binDirectory, "timeout");
  const log = join(root, "docker.log");
  const volumeMarker = join(root, "volume-created");
  const containerMarker = join(root, "container-created");
  const runningMarker = join(root, "container-running");
  const migrations = options.migrations ?? [];
  await mkdir(binDirectory, { recursive: true });
  await writeFile(
    docker,
    `#!/bin/sh
set -eu
log=${shellQuote(log)}
printf 'COMPOSE_PROJECT_NAME=%s ARGS=%s\\n' "\${COMPOSE_PROJECT_NAME-}" "$*" >> "$log"
all=" $* "
case "$all" in
  *" volume create "*)
    : > ${shellQuote(volumeMarker)}
    last=''
    for argument in "$@"; do last=$argument; done
    printf '%s\\n' "$last"
    exit 0
    ;;
  *" volume inspect "*)
    [ -f ${shellQuote(volumeMarker)} ] || exit 1
    case "$all" in
      *"{{.Name}}"*) printf '%s\\n' "\${COMPOSE_PROJECT_NAME-}-postgres-data" ;;
      *"{{.Driver}}"*) printf '%s\\n' 'local' ;;
      *"{{json .Options}}"*) printf '%s\\n' '{}' ;;
      *"com.docker.compose.project"*) printf '%s\\n' "\${COMPOSE_PROJECT_NAME-}" ;;
      *"com.docker.compose.volume"*) printf '%s\\n' 'postgres-data' ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  *" create --no-build --pull never postgres "*)
    : > ${shellQuote(containerMarker)}
    exit 0
    ;;
  *" config --environment "*)
    printf '%s\\n' \\
      'COMPOSE_PROJECT_NAME=${options.project ?? project}' \\
      'POSTGRES_DB=geo_saas' \\
      'POSTGRES_ADMIN_USER=geo_admin' \\
      'GEO_API_DB_USER=geo_api' \\
      'GEO_WORKER_DB_USER=geo_worker' \\
      'GEO_IDENTITY_DB_USER=geo_identity_login' \\
      'GEO_IMAGE_TAG=${release}' \\
      'GEO_IMAGE_REVISION=${release}'
    exit 0
    ;;
  *" ps --all --quiet "*)
    if [ -f ${shellQuote(containerMarker)} ]; then
      printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    fi
    exit 0
    ;;
  *" ps --quiet postgres "*)
    if [ -f ${shellQuote(containerMarker)} ]; then
      printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    fi
    exit 0
    ;;
  *" inspect --format "*)
    case "$all" in
      *".State.Health"*) printf '%s\\n' 'running|healthy' ;;
      *"{{.State.Status}}"*)
        if [ -f ${shellQuote(runningMarker)} ]; then printf '%s\\n' 'running'; else printf '%s\\n' 'created'; fi
        ;;
      *".Mounts"*)
        ${
          options.mountMismatch === true
            ? `printf '%s\\n' '/var/lib/postgresql/data|volume|${project}-postgres-data|true'`
            : `printf '/var/lib/postgresql/data|volume|%s-postgres-data|true\\n' "\${COMPOSE_PROJECT_NAME-}"`
        }
        ;;
      *) exit 1 ;;
    esac
    exit 0
    ;;
  *" start "*)
    : > ${shellQuote(runningMarker)}
    ${options.replacePathOnStart === undefined ? "" : `printf '%s\\n' 'replaced-after-verification' > ${shellQuote(options.replacePathOnStart)}`}
    exit 0
    ;;
  *" cp postgres:/tmp/geo-saas-backup.dump "*)
    last=''
    for argument in "$@"; do last=$argument; done
    printf '%s\\n' 'fake-custom-format-dump' > "$last"
    exit 0
    ;;
  *" images --format json "*)
    printf '%s\\n' '{"Service":"postgres","Repository":"postgres"}'
    exit 0
    ;;
  *"SELECT name FROM geo.kysely_migration ORDER BY name"*)
    printf '%s\\n' ${migrations.map(shellQuote).join(" ") || "''"}
    exit 0
    ;;
  *" pg_restore --list "*)
    ${options.failPgRestoreList === true ? "exit 42" : "exit 0"}
    ;;
esac
exit 0
`,
    { mode: 0o700 },
  );
  await writeFile(
    sudo,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = '--' ]; then shift; fi
exec "$@"
`,
    { mode: 0o700 },
  );
  await writeFile(
    flock,
    `#!/bin/sh
exit 0
`,
    { mode: 0o700 },
  );
  await writeFile(
    stat,
    `#!/bin/sh
set -eu
last=''
for argument in "$@"; do last=$argument; done
case "$last" in
  */caddy-data|*/caddy-config)
    case "$*" in
      *"%u %a"*|*"%u %Lp"*) printf '%s 700\\n' '${options.caddyOwner ?? 1000}'; exit 0 ;;
    esac
    ;;
esac
exec /usr/bin/stat "$@"
`,
    { mode: 0o700 },
  );
  await writeFile(
    timeout,
    `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    --signal=*|--kill-after=*) shift ;;
    *s) shift; break ;;
    *) exit 64 ;;
  esac
done
exec "$@"
`,
    { mode: 0o700 },
  );
  await chmod(docker, 0o700);
  await chmod(sudo, 0o700);
  await chmod(flock, 0o700);
  await chmod(stat, 0o700);
  await chmod(timeout, 0o700);
  return { docker, log, binDirectory };
}

function runScript(
  script: string,
  arguments_: readonly string[],
  root: string,
  binDirectory?: string,
): ReturnType<typeof spawnSync> {
  const path =
    binDirectory === undefined ? process.env.PATH : `${binDirectory}:${process.env.PATH}`;
  return spawnSync("/bin/bash", [script, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, PATH: path, TMPDIR: root },
  });
}

function verifierArguments(fixture: BundleFixture, docker: string): string[] {
  return [
    "--bundle",
    fixture.bundle,
    "--checksum-file",
    fixture.checksumFile,
    "--expected-release",
    release,
    "--expected-project",
    project,
    "--compose-file",
    join(repositoryRoot, "compose.yaml"),
    "--docker-bin",
    docker,
  ];
}

async function createReleaseRoot(root: string, migrations = ["0001_foundation"]): Promise<string> {
  const releaseRoot = join(root, "release");
  await mkdir(join(releaseRoot, "docs/ops/postgres"), { recursive: true });
  await mkdir(join(releaseRoot, "packages/db/migrations"), { recursive: true });
  await copyFile(join(repositoryRoot, "compose.yaml"), join(releaseRoot, "compose.yaml"));
  await copyFile(
    join(repositoryRoot, "compose.production.yaml"),
    join(releaseRoot, "compose.production.yaml"),
  );
  await copyFile(
    join(repositoryRoot, "docs/ops/postgres/verify-restore-rehearsal.sql"),
    join(releaseRoot, "docs/ops/postgres/verify-restore-rehearsal.sql"),
  );
  await writeFile(join(releaseRoot, ".geo-release"), `${release}\n`);
  await chmod(join(releaseRoot, ".geo-release"), 0o444);
  for (const migration of migrations) {
    await writeFile(join(releaseRoot, "packages/db/migrations", `${migration}.sql`), "select 1;\n");
  }
  return releaseRoot;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("production backup bundle verifier", () => {
  it("binds verification and Docker consumption to the private snapshot", () => {
    expect(verifySource).toContain("--snapshot-root ABSOLUTE_PATH");
    expect(verifySource.indexOf("snapshot_regular_file")).toBeLessThan(
      verifySource.indexOf("pg_restore --list /backup/postgres.dump"),
    );
    expect(verifySource).toContain(
      '--mount "type=bind,src=${BUNDLE_ABS}/postgres.dump,dst=/backup/postgres.dump,readonly"',
    );
  });

  it("validates and retains a private snapshot when requested", async () => {
    const root = await makeTemporaryRoot("geo-backup-snapshot-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    const snapshotRoot = join(root, "verified-snapshot");
    await mkdir(snapshotRoot, { mode: 0o700 });

    const result = runScript(
      verifyScript,
      [...verifierArguments(fixture, fake.docker), "--snapshot-root", snapshotRoot],
      root,
    );

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain(`Verified private snapshot: ${join(snapshotRoot, backupId)}`);
    const snapshotBundle = join(snapshotRoot, backupId);
    const snapshotDump = join(snapshotBundle, "postgres.dump");
    expect(await readFile(snapshotDump, "utf8")).toBe("fake-custom-format-dump\n");
    const snapshotRootStats = await lstat(snapshotRoot);
    expect(snapshotRootStats.mode & 0o777).toBe(0o700);
    const snapshotStats = await lstat(snapshotDump);
    expect(snapshotStats.mode & 0o777).toBe(0o600);
    expect(snapshotStats.nlink).toBe(1);

    await writeFile(join(fixture.bundle, "postgres.dump"), "replaced-after-verification\n");
    expect(await readFile(snapshotDump, "utf8")).toBe("fake-custom-format-dump\n");
    const dockerLog = await readFile(fake.log, "utf8");
    expect(dockerLog).toContain(`src=${snapshotDump}`);
  });

  it("requires an empty private snapshot root", async () => {
    const root = await makeTemporaryRoot("geo-backup-snapshot-unsafe-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    const snapshotRoot = join(root, "verified-snapshot");
    await mkdir(snapshotRoot, { mode: 0o700 });
    await writeFile(join(snapshotRoot, "unexpected"), "x\n");

    const result = runScript(
      verifyScript,
      [...verifierArguments(fixture, fake.docker), "--snapshot-root", snapshotRoot],
      root,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("snapshot root must be empty");
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  });

  it("verifies strict identity, external checksums, safe archive paths, and pg_restore", async () => {
    const root = await makeTemporaryRoot("geo-backup-verifier-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);

    const result = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);

    expect(result.status, String(result.stderr)).toBe(0);
    expect(result.stdout).toContain(`id=${backupId} release=${release} project=${project}`);
    const dockerLog = await readFile(fake.log, "utf8");
    expect(dockerLog).toContain("--network none");
    expect(dockerLog).toContain("--read-only");
    expect(dockerLog).toMatch(/--user [0-9]+:[0-9]+/u);
    expect(dockerLog).toContain("pg_restore --list /backup/postgres.dump");
    expect(dockerLog).toContain(`src=${await realpath(fixture.backupRoot)}/.geo-backup-snapshot.`);
    expect(dockerLog).not.toContain(`src=${await realpath(root)}/geo-backup-snapshot.`);
  });

  it("rejects an unexpected source bundle artifact before snapshotting or invoking Docker", async () => {
    const root = await makeTemporaryRoot("geo-backup-extra-artifact-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    await writeFile(join(fixture.bundle, "unexpected.txt"), "unexpected\n");

    const result = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/exactly four|unexpected top-level artifact/iu);
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  });

  it("fails closed on duplicate manifest fields before invoking Docker", async () => {
    const root = await makeTemporaryRoot("geo-backup-duplicate-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    const manifest = join(fixture.bundle, "manifest.txt");
    await writeFile(manifest, `${await readFile(manifest, "utf8")}release=${release}\n`);
    await writeChecksums(fixture);

    const result = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/duplicate|unknown/iu);
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  });

  it("requires the explicit Caddy exclusion and reissuance policy", async () => {
    const root = await makeTemporaryRoot("geo-backup-caddy-policy-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    const manifest = join(fixture.bundle, "manifest.txt");
    await writeFile(
      manifest,
      (await readFile(manifest, "utf8")).replace(
        "caddy_state_policy=excluded-reissue\n",
        "caddy_state_policy=included-plaintext\n",
      ),
    );
    await writeChecksums(fixture);

    const result = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Caddy state policy");
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  });

  it("rejects a checksum stored inside the bundle and any artifact tampering", async () => {
    const root = await makeTemporaryRoot("geo-backup-checksum-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    const internalChecksum = join(fixture.bundle, "checksums.sha256");
    await copyFile(fixture.checksumFile, internalChecksum);
    const internalArguments = verifierArguments(fixture, fake.docker);
    internalArguments[internalArguments.indexOf("--checksum-file") + 1] = internalChecksum;

    const internalResult = runScript(verifyScript, internalArguments, root);
    expect(internalResult.status).not.toBe(0);
    expect(internalResult.stderr).toContain("stored outside");

    await rm(internalChecksum);
    await writeFile(join(fixture.bundle, "postgres.dump"), "tampered\n");
    const tamperedResult = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);
    expect(tamperedResult.status).not.toBe(0);
    expect(tamperedResult.stderr).toContain("checksum mismatch for postgres.dump");
  });

  it("rejects links in the application archive and pg_restore parse failures", async () => {
    const root = await makeTemporaryRoot("geo-backup-archive-");
    const fixture = await createBundle(root);
    const archiveData = join(root, "unsafe-archive-data");
    for (const name of ["evidence", "media", "ctrip-runtime"]) {
      await mkdir(join(archiveData, name), { recursive: true });
    }
    await symlink("/etc/passwd", join(archiveData, "evidence", "host-passwd"));
    const tarResult = spawnSync(
      "tar",
      [
        "-czf",
        join(fixture.bundle, "application-files.tar.gz"),
        "-C",
        archiveData,
        "evidence",
        "media",
        "ctrip-runtime",
      ],
      { encoding: "utf8" },
    );
    expect(tarResult.status, tarResult.stderr).toBe(0);
    await writeChecksums(fixture);
    const fake = await createFakeDocker(root);

    const linkResult = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);

    expect(linkResult.status).not.toBe(0);
    expect(linkResult.stderr).toMatch(/link|special/iu);

    const validFixture = await createBundle(join(root, "valid"));
    const rejectingFake = await createFakeDocker(join(root, "valid"), {
      failPgRestoreList: true,
    });
    const dumpResult = runScript(
      verifyScript,
      verifierArguments(validFixture, rejectingFake.docker),
      root,
    );
    expect(dumpResult.status).not.toBe(0);
    expect(dumpResult.stderr).toContain("pg_restore rejected");
  });

  it("rejects traversal paths and file/directory aliases after slash normalization", async () => {
    const root = await makeTemporaryRoot("geo-backup-tar-paths-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    const archive = join(fixture.bundle, "application-files.tar.gz");
    await writeFile(
      archive,
      tarGzip([
        { name: "evidence/", type: "5" },
        { name: "media/", type: "5" },
        { name: "ctrip-runtime/", type: "5" },
        { name: "evidence/../escape", type: "0" },
      ]),
    );
    await writeChecksums(fixture);

    const traversalResult = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);
    expect(traversalResult.status).not.toBe(0);
    expect(traversalResult.stderr).toMatch(/unsafe|traversal/iu);

    await writeFile(
      archive,
      tarGzip([
        { name: "evidence", type: "0" },
        { name: "evidence/", type: "5" },
        { name: "media/", type: "5" },
        { name: "ctrip-runtime/", type: "5" },
      ]),
    );
    await writeChecksums(fixture);
    const aliasResult = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);
    expect(aliasResult.status).not.toBe(0);
    expect(aliasResult.stderr).toContain("duplicate paths");
  });

  it("rejects Caddy ACME state in the ordinary application archive", async () => {
    const root = await makeTemporaryRoot("geo-backup-caddy-archive-");
    const fixture = await createBundle(root);
    const fake = await createFakeDocker(root);
    await writeFile(
      join(fixture.bundle, "application-files.tar.gz"),
      tarGzip([
        { name: "evidence/", type: "5" },
        { name: "media/", type: "5" },
        { name: "ctrip-runtime/", type: "5" },
        { name: "caddy-data/", type: "5" },
        { name: "caddy-data/certificates/private.key", type: "0" },
      ]),
    );
    await writeChecksums(fixture);

    const result = runScript(verifyScript, verifierArguments(fixture, fake.docker), root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unsafe or unexpected path");
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  });
});

describe("production backup and isolated restore rehearsal", () => {
  it("checks the strict env grammar before resolving or stopping Compose writers", () => {
    expect(backupSource.indexOf('validate_strict_env_file "${env_file}"')).toBeGreaterThan(-1);
    expect(backupSource.indexOf('validate_strict_env_file "${env_file}"')).toBeLessThan(
      backupSource.indexOf('"${compose[@]}" stop'),
    );
    expect(
      backupSource.indexOf(
        "production backup is inhibited until the persistent incident-restore marker is cleared",
      ),
    ).toBeLessThan(backupSource.indexOf('"${compose[@]}" stop'));
    expect(backupSource.indexOf('"${CONVERGENCE_MANAGER}" verify')).toBeLessThan(
      backupSource.indexOf('"${compose[@]}" stop'),
    );
    expect(backupSource).toContain("GEO_DEPLOYMENT_LOCK_FD=7");
    expect(rehearsalSource).toContain('--snapshot-root "${verified_snapshot_root}"');
    expect(rehearsalSource.indexOf('--snapshot-root "${verified_snapshot_root}"')).toBeLessThan(
      rehearsalSource.indexOf('application-files.tar.gz" --directory'),
    );
    const volumeCreate = rehearsalSource.indexOf("docker_rehearsal volume create \\");
    const volumeMetadata = rehearsalSource.indexOf(
      "volume_options=$(docker_rehearsal volume inspect",
    );
    const containerCreate = rehearsalSource.indexOf('"${rehearsal_compose[@]}" create --no-build');
    const mountCheck = rehearsalSource.indexOf("postgres_data_mount=$(docker_rehearsal inspect");
    const containerStart = rehearsalSource.indexOf(
      'docker_rehearsal start "${postgres_container}"',
    );
    expect(volumeCreate).toBeGreaterThan(-1);
    expect(volumeCreate).toBeLessThan(volumeMetadata);
    expect(volumeMetadata).toBeLessThan(containerCreate);
    expect(containerCreate).toBeLessThan(mountCheck);
    expect(mountCheck).toBeLessThan(containerStart);
    expect(rehearsalSource).not.toContain(
      "up --detach --no-deps --wait --wait-timeout 180 postgres",
    );
    expect(backupSource).toContain("for caddy_directory in caddy-data caddy-config");
    expect(backupSource).toContain(
      'require_owned_directory "${data_root}/${caddy_directory}" 1000 700',
    );
    expect(backupSource).toContain(
      'require_owned_directory "${data_root}/${data_directory}" "$(id -u)" 700',
    );
    expect(backupSource).toContain('verify_archive_tree "${DATA_ROOT}/${data_directory}"');
    expect(backupSource).toContain('"${entry_device}" != "${root_device}"');
    expect(backupSource).toContain("tar --create --gzip --one-file-system");
    expect(backupSource).not.toContain("sudo -- tar");
    expect(backupSource).not.toContain("sudo -- chown");
    expect(backupSource).toContain("--prepare-restore-inhibit");
    expect(backupSource).toContain(
      "ordinary production backup must inherit the scheduled wrapper maintenance lock",
    );
    expect(backupSource.indexOf('verify-backup-bundle.sh"')).toBeLessThan(
      backupSource.indexOf("schema=geo.production-restore-inhibit.v1"),
    );
    expect(backupSource).toContain("pre_restore_checksum_sha256=%s");
    expect(backupSource.indexOf("for caddy_directory in caddy-data caddy-config")).toBeLessThan(
      backupSource.indexOf('--directory="${DATA_ROOT}" evidence media ctrip-runtime'),
    );
  });

  it.each([
    ["duplicate key", `COMPOSE_PROJECT_NAME=${project}\nCOMPOSE_PROJECT_NAME=${project}\n`],
    ["export syntax", `export COMPOSE_PROJECT_NAME=${project}\n`],
    ["carriage return", `COMPOSE_PROJECT_NAME=${project}\r\n`],
    ["missing final newline", `COMPOSE_PROJECT_NAME=${project}`],
  ])("rejects %s env syntax before stopping production writers", async (_name, contents) => {
    const root = await makeTemporaryRoot("geo-production-backup-env-");
    const releaseRoot = await createReleaseRoot(root);
    const dataRoot = join(root, "data");
    const backupRoot = join(root, "backups");
    const envFile = join(root, "geo.env");
    for (const name of ["evidence", "media", "ctrip-runtime"]) {
      await mkdir(join(dataRoot, name), { recursive: true });
    }
    await mkdir(backupRoot, { recursive: true });
    await writeFile(envFile, contents, { mode: 0o600 });
    await chmod(envFile, 0o600);
    const fake = await createFakeDocker(root);

    const result = runScript(
      backupScript,
      [
        "--release-root",
        releaseRoot,
        "--env-file",
        envFile,
        "--data-root",
        dataRoot,
        "--backup-root",
        backupRoot,
        "--backup-id",
        backupId,
        "--deployment-lock",
        join(root, "deployment.lock"),
        "--docker-bin",
        fake.docker,
      ],
      root,
      fake.binDirectory,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/env|newline|duplicate|CR|KEY=value/iu);
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  });

  it("binds the restore rehearsal lock descriptor to the checked path", () => {
    const descriptorCheck = rehearsalSource.indexOf("stat -Lc '%d:%i:%u:%h:%a' -- /proc/self/fd/7");
    const lockAcquisition = rehearsalSource.indexOf("flock --nonblock 7");

    expect(descriptorCheck).toBeGreaterThan(-1);
    expect(rehearsalSource).toContain(
      "shared deployment lock descriptor is not bound to the checked path",
    );
    expect(descriptorCheck).toBeLessThan(lockAcquisition);
  });

  it("requires Caddy state roots to use the fixed container uid", async () => {
    const root = await makeTemporaryRoot("geo-production-backup-caddy-owner-");
    const releaseRoot = await createReleaseRoot(root);
    const dataRoot = join(root, "data");
    const backupRoot = join(root, "backups");
    const envFile = join(root, "geo.env");
    for (const name of ["evidence", "media", "ctrip-runtime", "caddy-data", "caddy-config"]) {
      await mkdir(join(dataRoot, name), { recursive: true, mode: 0o700 });
      await chmod(join(dataRoot, name), 0o700);
    }
    await mkdir(backupRoot, { recursive: true });
    await writeFile(envFile, `COMPOSE_PROJECT_NAME=${project}\n`, { mode: 0o600 });
    const fake = await createFakeDocker(root, { caddyOwner: 2000 });

    const result = runScript(
      backupScript,
      [
        "--release-root",
        releaseRoot,
        "--env-file",
        envFile,
        "--data-root",
        dataRoot,
        "--backup-root",
        backupRoot,
        "--backup-id",
        backupId,
        "--deployment-lock",
        join(root, "deployment.lock"),
        "--docker-bin",
        fake.docker,
      ],
      root,
      fake.binDirectory,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be owned by uid 1000");
    await expect(readFile(fake.log, "utf8")).rejects.toThrow();
  });

  it("creates a complete bundle with the resolved Compose project and no production restart", async () => {
    const root = await makeTemporaryRoot("geo-production-backup-");
    const releaseRoot = await createReleaseRoot(root);
    const dataRoot = join(root, "data");
    const backupRoot = join(root, "backups");
    const envFile = join(root, "geo.env");
    for (const name of ["evidence", "media", "ctrip-runtime", "caddy-data", "caddy-config"]) {
      await mkdir(join(dataRoot, name), { recursive: true, mode: 0o700 });
      await chmod(join(dataRoot, name), 0o700);
    }
    await writeFile(join(dataRoot, "caddy-data", "acme-private.key"), "must-not-be-archived\n");
    await writeFile(join(dataRoot, "caddy-config", "autosave.json"), "must-not-be-archived\n");
    await mkdir(backupRoot, { recursive: true });
    await writeFile(envFile, `COMPOSE_PROJECT_NAME=${project}\n`, { mode: 0o600 });
    const fake = await createFakeDocker(root);

    const result = runScript(
      backupScript,
      [
        "--release-root",
        releaseRoot,
        "--env-file",
        envFile,
        "--data-root",
        dataRoot,
        "--backup-root",
        backupRoot,
        "--backup-id",
        backupId,
        "--deployment-lock",
        join(root, "deployment.lock"),
        "--docker-bin",
        fake.docker,
      ],
      root,
      fake.binDirectory,
    );

    expect(result.status, String(result.stderr)).toBe(0);
    const manifest = await readFile(join(backupRoot, backupId, "manifest.txt"), "utf8");
    expect(manifest).toContain(`compose_project=${project}\n`);
    expect(manifest).toContain("scope=postgres,evidence,media,ctrip-runtime\n");
    expect(manifest).toContain("caddy_state_policy=excluded-reissue\n");
    const archiveListing = spawnSync(
      "tar",
      ["-tzf", join(backupRoot, backupId, "application-files.tar.gz")],
      { encoding: "utf8" },
    );
    expect(archiveListing.status, archiveListing.stderr).toBe(0);
    expect(archiveListing.stdout).not.toMatch(/caddy-(data|config)/u);
    expect(await readFile(join(backupRoot, `${backupId}.sha256`), "utf8")).toContain(
      "  postgres.dump\n",
    );
    const dockerLog = await readFile(fake.log, "utf8");
    expect(dockerLog).toContain("stop edge ctrip-bridge agent-mcp worker api web browser-host");
    expect(dockerLog).toContain("pg_dump");
    expect(dockerLog).not.toContain(" up ");
  });

  it("restores only into a fresh named-volume project, migrates, bootstraps, and verifies isolation", async () => {
    const root = await makeTemporaryRoot("geo-restore-rehearsal-");
    const migrations = ["0001_foundation", "0002_identity_and_tenant"];
    const releaseRoot = await createReleaseRoot(root, migrations);
    const fixture = await createBundle(root);
    const envFile = join(root, "geo.env");
    const report = join(root, "rehearsal-report.txt");
    await writeFile(envFile, `COMPOSE_PROJECT_NAME=${project}\n`, { mode: 0o600 });
    const fake = await createFakeDocker(root, {
      migrations,
      replacePathOnStart: join(fixture.bundle, "application-files.tar.gz"),
    });

    const result = runScript(
      rehearsalScript,
      [
        "--bundle",
        fixture.bundle,
        "--checksum-file",
        fixture.checksumFile,
        "--release-root",
        releaseRoot,
        "--env-file",
        envFile,
        "--report",
        report,
        "--docker-bin",
        fake.docker,
      ],
      root,
      fake.binDirectory,
    );

    expect(result.status, String(result.stderr)).toBe(0);
    expect(await readFile(join(fixture.bundle, "application-files.tar.gz"), "utf8")).toContain(
      "replaced-after-verification",
    );
    const evidence = await readFile(report, "utf8");
    expect(evidence).toContain("database_restore=passed");
    expect(evidence).toContain("caddy_state_recovery=excluded_reissue_required");
    expect(evidence).toContain("migration_inventory=passed");
    expect(evidence).toContain("role_acl_verification=passed");
    expect(evidence).toContain("rls_cross_tenant_denial=passed");
    expect(evidence).toContain("isolated_resources=retained_for_review");
    const dockerLog = await readFile(fake.log, "utf8");
    expect(dockerLog).toContain("volume create");
    expect(dockerLog).toContain("volume inspect");
    expect(dockerLog).toContain("create --no-build --pull never postgres");
    expect(dockerLog).toContain("ARGS=start ");
    expect(dockerLog).toContain("db-restore-roles");
    expect(dockerLog).toContain("db-migrate");
    expect(dockerLog).toContain("db-bootstrap");
    expect(dockerLog).toContain("--set=api_user");
    expect(dockerLog).toContain("stop postgres");
    expect(dockerLog).toMatch(/COMPOSE_PROJECT_NAME=geo-restore-[^ ]+ ARGS=compose/iu);
    expect(dockerLog).toContain("/var/lib/postgresql/data");
    expect(dockerLog).not.toContain("compose.production.yaml");
    expect(dockerLog).not.toMatch(/\bdown\b|volume rm/iu);
  });

  it("fails before restore when PostgreSQL is mounted from any other volume", async () => {
    const root = await makeTemporaryRoot("geo-restore-mount-mismatch-");
    const migrations = ["0001_foundation"];
    const releaseRoot = await createReleaseRoot(root, migrations);
    const fixture = await createBundle(root);
    const envFile = join(root, "geo.env");
    const report = join(root, "rehearsal-report.txt");
    await writeFile(envFile, `COMPOSE_PROJECT_NAME=${project}\n`, { mode: 0o600 });
    const fake = await createFakeDocker(root, { migrations, mountMismatch: true });

    const result = runScript(
      rehearsalScript,
      [
        "--bundle",
        fixture.bundle,
        "--checksum-file",
        fixture.checksumFile,
        "--release-root",
        releaseRoot,
        "--env-file",
        envFile,
        "--report",
        report,
        "--docker-bin",
        fake.docker,
      ],
      root,
      fake.binDirectory,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not using the expected fresh named volume");
    const dockerLog = await readFile(fake.log, "utf8");
    expect(dockerLog).not.toContain("db-restore-roles");
    await expect(readFile(report, "utf8")).rejects.toThrow();
  });
});
