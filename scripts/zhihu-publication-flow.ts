import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:10004";
const DEFAULT_LOGIN_FILE = "D:/GEO/.runtime/geo-saas-customer-demo/customer-login.txt";
const DEFAULT_TIMEOUT_MS = 12 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ZHIHU_PUBLIC_URL_PATTERN = /^https:\/\/zhuanlan\.zhihu\.com\/p\/[1-9][0-9]{5,19}$/u;

type JsonRecord = Record<string, unknown>;

interface ApiErrorResponse {
  readonly error?: Readonly<{ code?: string; message?: string }>;
}

interface LoginResponse {
  readonly csrfToken: string;
}

interface BridgeStatusResponse {
  readonly configured?: boolean;
  readonly reachable?: boolean;
  readonly mode?: string;
  readonly commandCapabilities?: Readonly<{
    prepare?: boolean;
    submit?: boolean;
    readback?: boolean;
  }>;
}

interface CapabilityItem {
  readonly platform?: string;
  readonly status?: string;
  readonly supportedExecutionLevels?: readonly string[];
  readonly accountId: string;
}

interface CapabilitiesResponse {
  readonly items: readonly CapabilityItem[];
}

interface AuditResponse {
  readonly artifact?: Readonly<{
    id: string;
    status?: string;
    platform?: string;
    findings?: readonly unknown[];
    payloadHash: string;
  }>;
  readonly publicationAuthorization?: Readonly<{
    grantId: string;
    token: string;
    expiresAt: string;
  }> | null;
}

interface PublicationRequestResponse {
  readonly publicationJobId: string;
}

interface PublicationJobResponse {
  readonly state: string;
  readonly lastErrorCode?: string | null;
  readonly lastErrorMessage?: string | null;
}

interface AssistedHandoff {
  readonly id: string;
  readonly jobId: string;
  readonly channelAccountId: string;
  readonly state: string;
  readonly articleTitle?: string | null;
  readonly adapterVersion: string;
  readonly prepareOutcome?: string | null;
  readonly prepareEvidenceKind?: string | null;
  readonly prepareEvidenceHash?: string | null;
  readonly mediaManifestHash?: string | null;
  readonly submitOutcome?: string | null;
  readonly submitEvidenceKind?: string | null;
  readonly submitCandidateExternalUrl?: string | null;
  readonly publicationReceiptId?: string | null;
  readonly readbackOutcome?: string | null;
  readonly readbackEvidenceKind?: string | null;
  readonly readbackAttemptCount?: number;
  readonly externalUrl?: string | null;
  readonly lastErrorCode?: string | null;
  readonly lastErrorMessage?: string | null;
}

interface AssistedHandoffsResponse {
  readonly items: readonly AssistedHandoff[];
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required --${name} argument`);
  }
  return value;
}

function credentials(loginText: string): { email: string; password: string } {
  const values = new Map<string, string>();
  for (const line of loginText.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator > 0)
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const email = values.get("Email");
  const password = values.get("Password");
  if (email === undefined || password === undefined) {
    throw new Error("Customer demo login credentials are missing");
  }
  return { email, password };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function emit(phase: string, details: JsonRecord = {}): void {
  process.stdout.write(`${JSON.stringify({ phase, ...details })}\n`);
}

class ApiSession {
  readonly #baseUrl: string;
  #cookie = "";
  #csrfToken = "";

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/u, "");
  }

  async login(loginFile: string): Promise<void> {
    const response = await fetch(`${this.#baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials(await readFile(loginFile, "utf8"))),
    });
    const body = (await response.json()) as LoginResponse;
    if (!response.ok) throw new Error(`Login failed (${response.status})`);
    this.#cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";", 1)[0])
      .join("; ");
    this.#csrfToken = body.csrfToken;
  }

  async request<ResponseBody = JsonRecord>(
    path: string,
    init: RequestInit = {},
  ): Promise<ResponseBody> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        cookie: this.#cookie,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(["GET", "HEAD"].includes(init.method ?? "GET")
          ? {}
          : { "x-csrf-token": this.#csrfToken }),
        ...init.headers,
      },
    });
    const body = (await response.json()) as ResponseBody;
    if (!response.ok) {
      const apiError = body as ApiErrorResponse;
      const code = apiError.error?.code ?? "UNKNOWN";
      const message = apiError.error?.message ?? "";
      throw new Error(`${path} failed (${response.status}): ${code} ${message}`.trim());
    }
    return body;
  }
}

function handoffSignal(job: PublicationJobResponse, handoff: AssistedHandoff | null): string {
  return JSON.stringify({
    jobState: job.state,
    jobError: job.lastErrorCode ?? null,
    handoffState: handoff?.state ?? null,
    prepareOutcome: handoff?.prepareOutcome ?? null,
    submitOutcome: handoff?.submitOutcome ?? null,
    readbackOutcome: handoff?.readbackOutcome ?? null,
    readbackAttempts: handoff?.readbackAttemptCount ?? null,
    externalUrl: handoff?.externalUrl ?? handoff?.submitCandidateExternalUrl ?? null,
  });
}

const variantId = requiredArgument("variant-id");
if (!UUID_PATTERN.test(variantId)) throw new Error("--variant-id must be a UUID");
const apiBaseUrl = argument("api-base-url") ?? DEFAULT_API_BASE_URL;
const loginFile = argument("login-file") ?? DEFAULT_LOGIN_FILE;
const timeoutMs = Number(argument("timeout-ms") ?? DEFAULT_TIMEOUT_MS);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 15 * 60_000) {
  throw new Error("--timeout-ms must be between 30000 and 900000");
}
const publish = argument("publish") === "true";
if (!publish) {
  throw new Error(
    "Refusing to publish: pass --publish=true for the explicitly authorized real-send run",
  );
}

const api = new ApiSession(apiBaseUrl);
await api.login(loginFile);
emit("authenticated");

const [bridge, capabilities] = await Promise.all([
  api.request<BridgeStatusResponse>("/api/ctrip-bridge/status"),
  api.request<CapabilitiesResponse>("/api/capabilities"),
]);
if (
  bridge.configured !== true ||
  bridge.reachable !== true ||
  bridge.mode !== "browser_supervised" ||
  bridge.commandCapabilities?.prepare !== true ||
  bridge.commandCapabilities.submit !== true ||
  bridge.commandCapabilities.readback !== true
) {
  throw new Error(
    "Ctrip Bridge must be healthy in browser_supervised mode with prepare/submit/readback",
  );
}

const accountIdArgument = argument("account-id")?.trim();
const zhihuAccounts = capabilities.items.filter(
  (item) =>
    item.platform === "zhihu" &&
    item.status === "active" &&
    item.supportedExecutionLevels?.includes("assisted") &&
    (accountIdArgument === undefined || item.accountId === accountIdArgument),
);
if (zhihuAccounts.length !== 1) {
  throw new Error(
    `Expected exactly one active assisted Zhihu account, received ${zhihuAccounts.length}`,
  );
}
const accountId = zhihuAccounts[0]?.accountId;
if (accountId === undefined) throw new Error("Zhihu account id is missing");
emit("account-selected", { accountId });

const audit = await api.request<AuditResponse>(`/api/variants/${variantId}/audits`, {
  method: "POST",
  body: JSON.stringify({ idempotencyKey: `zhihu-publication-audit:${randomUUID()}` }),
});
const artifact = audit.artifact;
const authorization = audit.publicationAuthorization;
if (
  artifact?.status !== "passed" ||
  artifact.platform !== "zhihu" ||
  artifact.findings?.length !== 0 ||
  authorization === null ||
  authorization === undefined ||
  Date.parse(authorization.expiresAt) < Date.now() + 5 * 60_000
) {
  throw new Error("Fresh Zhihu audit or publication authorization is invalid");
}
emit("audit-passed", {
  variantId,
  auditArtifactId: artifact.id,
  payloadHash: artifact.payloadHash,
  grantId: authorization.grantId,
  expiresAt: authorization.expiresAt,
});

const publication = await api.request<PublicationRequestResponse>("/api/publication-requests", {
  method: "POST",
  body: JSON.stringify({
    grantId: authorization.grantId,
    token: authorization.token,
    idempotencyKey: `zhihu-publication:${authorization.grantId}`,
    executionLevel: "assisted",
  }),
});
const jobId = publication.publicationJobId;
emit("publication-enqueued", { jobId, platform: "zhihu", accountId });

const deadline = Date.now() + timeoutMs;
let lastSignal = "";
let handoff: AssistedHandoff | null = null;
while (Date.now() < deadline) {
  const [job, handoffs] = await Promise.all([
    api.request<PublicationJobResponse>(`/api/publication-jobs/${jobId}`),
    api.request<AssistedHandoffsResponse>("/api/publication-assisted-handoffs"),
  ]);
  handoff = handoffs.items.find((item) => item.jobId === jobId) ?? null;
  const signal = handoffSignal(job, handoff);
  if (signal !== lastSignal) {
    emit("publication-progress", JSON.parse(signal) as JsonRecord);
    lastSignal = signal;
  }
  if (handoff?.state === "handoff_pending") break;
  if (["needs_review", "permanent_failure", "cancelled"].includes(job.state)) {
    throw new Error(
      `Publication stopped before handoff: ${job.state} ${job.lastErrorCode ?? ""}`.trim(),
    );
  }
  await sleep(1_000);
}
if (handoff === null) throw new Error("Timed out waiting for Zhihu assisted handoff");
const handoffId = handoff.id;

const claimed = await api.request<{ readonly handoff: AssistedHandoff }>(
  `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/claim`,
  { method: "POST", body: JSON.stringify({ leaseSeconds: 300 }) },
);
handoff = claimed.handoff;
emit("handoff-claimed", { handoffId, state: handoff.state });

const prepared = await api.request<{
  readonly handoff: AssistedHandoff;
  readonly bridge: JsonRecord;
}>(`/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/prepare`, {
  method: "POST",
  body: JSON.stringify({}),
});
handoff = prepared.handoff;
emit("prepared", {
  handoffId: handoff.id,
  state: handoff.state,
  prepareOutcome: handoff.prepareOutcome ?? null,
  prepareEvidenceKind: handoff.prepareEvidenceKind ?? null,
  prepareEvidenceHash: handoff.prepareEvidenceHash ?? null,
  mediaManifestHash: handoff.mediaManifestHash ?? null,
});
if (handoff.state !== "draft_prepared" || handoff.prepareOutcome !== "prepared") {
  throw new Error(
    `Zhihu prepare did not reach draft_prepared: ${handoff.state} ${handoff.lastErrorCode ?? ""}`.trim(),
  );
}
if (handoff.mediaManifestHash === null || handoff.mediaManifestHash === undefined) {
  throw new Error("Zhihu prepare completed without a media manifest; refusing to publish");
}

const submitted = await api.request<{
  readonly handoff: AssistedHandoff;
  readonly bridge: JsonRecord;
}>(`/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}/submit`, {
  method: "POST",
  body: JSON.stringify({}),
});
handoff = submitted.handoff;
emit("submitted", {
  handoffId: handoff.id,
  state: handoff.state,
  submitOutcome: handoff.submitOutcome ?? null,
  submitEvidenceKind: handoff.submitEvidenceKind ?? null,
  candidateExternalUrl: handoff.submitCandidateExternalUrl ?? null,
  publicationReceiptId: handoff.publicationReceiptId ?? null,
});
if (handoff.submitOutcome !== "accepted" || handoff.publicationReceiptId === null) {
  throw new Error(
    `Zhihu submit was not accepted: ${handoff.submitOutcome ?? "unknown"} ${handoff.lastErrorCode ?? ""}`.trim(),
  );
}

let finalHandoff = handoff;
let finalSignal = "";
while (Date.now() < deadline) {
  finalHandoff = await api.request<AssistedHandoff>(
    `/api/publication-assisted-handoffs/${encodeURIComponent(handoffId)}`,
  );
  const signal = handoffSignal(
    { state: finalHandoff.state, lastErrorCode: finalHandoff.lastErrorCode },
    finalHandoff,
  );
  if (signal !== finalSignal) {
    emit("readback-progress", JSON.parse(signal) as JsonRecord);
    finalSignal = signal;
  }
  if (["confirmed", "needs_review", "failed", "expired"].includes(finalHandoff.state)) break;
  await sleep(10_000);
}

const publicUrl = finalHandoff.externalUrl ?? finalHandoff.submitCandidateExternalUrl;
if (
  finalHandoff.state !== "confirmed" ||
  finalHandoff.readbackOutcome !== "confirmed" ||
  (finalHandoff.readbackEvidenceKind !== "platform_readback" &&
    finalHandoff.readbackEvidenceKind !== "browser") ||
  publicUrl === null ||
  publicUrl === undefined ||
  !ZHIHU_PUBLIC_URL_PATTERN.test(publicUrl)
) {
  throw new Error(
    `Zhihu public readback was not confirmed: ${finalHandoff.state} ${finalHandoff.readbackOutcome ?? "unknown"}`.trim(),
  );
}
emit("published-confirmed", {
  jobId,
  handoffId: finalHandoff.id,
  publicUrl,
  readbackOutcome: finalHandoff.readbackOutcome,
  readbackEvidenceKind: finalHandoff.readbackEvidenceKind,
  readbackAttemptCount: finalHandoff.readbackAttemptCount ?? null,
  runtimeCleanup: "bridge-reclaim-poller",
});
