import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:10004";
const DEFAULT_LOGIN_FILE = "D:/GEO/.runtime/geo-saas-customer-demo/customer-login.txt";
const DEFAULT_TIMEOUT_MS = 7 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type JsonRecord = Record<string, unknown>;

interface LoginResponse {
  readonly csrfToken: string;
}

interface ApiErrorResponse {
  readonly error?: Readonly<{
    code?: string;
    message?: string;
  }>;
}

interface BridgeStatusResponse {
  readonly configured?: boolean;
  readonly reachable?: boolean;
  readonly mode?: string;
  readonly commandCapabilities?: Readonly<{ prepare?: boolean }>;
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

interface AutomationResponse {
  readonly control: Readonly<{
    mode: string;
    quota: JsonRecord;
    killSwitchEnabled: boolean;
  }>;
  readonly circuits: readonly Readonly<{
    scopeType?: string;
    scopeKey?: string;
    state?: string;
  }>[];
}

interface AuditResponse {
  readonly artifact?: Readonly<{
    status?: string;
    platform?: string;
    findings?: readonly unknown[];
    id: string;
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
}

interface AssistedHandoff {
  readonly jobId: string;
  readonly state: string;
  readonly id: string;
  readonly title?: string | null;
  readonly payloadHash: string;
  readonly auditHash: string;
  readonly previewHash: string;
  readonly externalDraftId?: string | null;
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
      throw new Error(
        `${path} failed (${response.status}): ${apiError.error?.code ?? "UNKNOWN"} ${apiError.error?.message ?? ""}`,
      );
    }
    return body;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function setControl(
  api: ApiSession,
  mode: string,
  quota: JsonRecord,
  reason: string,
): Promise<void> {
  await api.request("/api/automation/control", {
    method: "PUT",
    body: JSON.stringify({ mode, quota, reason }),
  });
}

async function setKillSwitch(api: ApiSession, enabled: boolean, reason: string): Promise<void> {
  await api.request("/api/automation/kill-switch", {
    method: "POST",
    body: JSON.stringify({ enabled, reason }),
  });
}

async function setAccountCircuit(
  api: ApiSession,
  accountId: string,
  targetState: "open" | "closed",
  reason: string,
): Promise<void> {
  await api.request(`/api/automation/circuits/account/${accountId}/state`, {
    method: "POST",
    body: JSON.stringify({ targetState, reason }),
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

const api = new ApiSession(apiBaseUrl);
await api.login(loginFile);

const [bridgeStatus, capabilities, baseline] = await Promise.all([
  api.request<BridgeStatusResponse>("/api/ctrip-bridge/status"),
  api.request<CapabilitiesResponse>("/api/capabilities"),
  api.request<AutomationResponse>("/api/automation"),
]);
if (
  bridgeStatus.configured !== true ||
  bridgeStatus.reachable !== true ||
  bridgeStatus.mode !== "browser_supervised" ||
  bridgeStatus.commandCapabilities?.prepare !== true
) {
  throw new Error("Ctrip Bridge must be healthy in browser_supervised mode");
}

const ctripAccounts = capabilities.items.filter(
  (item) =>
    item.platform === "ctrip_community" &&
    item.status === "active" &&
    item.supportedExecutionLevels?.includes("assisted"),
);
if (ctripAccounts.length !== 1) {
  throw new Error(`Expected one active assisted Ctrip account, received ${ctripAccounts.length}`);
}
const [ctripAccount] = ctripAccounts;
if (ctripAccount === undefined) {
  throw new Error("Expected one active assisted Ctrip account");
}
const accountId = ctripAccount.accountId;
const baselineCircuit = baseline.circuits.find(
  (item) => item.scopeType === "account" && item.scopeKey === accountId,
);
const restoreCircuitState: "open" | "closed" =
  baselineCircuit?.state === "closed" ? "closed" : "open";

const audit = await api.request<AuditResponse>(`/api/variants/${variantId}/audits`, {
  method: "POST",
  body: JSON.stringify({ idempotencyKey: `ctrip-draft-audit:${randomUUID()}` }),
});
const artifact = audit.artifact;
const authorization = audit.publicationAuthorization;
if (
  artifact?.status !== "passed" ||
  artifact.platform !== "ctrip_community" ||
  artifact.findings?.length !== 0 ||
  authorization === null ||
  authorization === undefined ||
  Date.parse(authorization.expiresAt) < Date.now() + 5 * 60_000
) {
  throw new Error("Fresh Ctrip audit or publication authorization is invalid");
}
console.log(
  JSON.stringify({
    phase: "audit-passed",
    variantId,
    auditArtifactId: artifact.id,
    payloadHash: artifact.payloadHash,
    grantId: authorization.grantId,
    expiresAt: authorization.expiresAt,
  }),
);

let jobId: string | null = null;
let prepared: Readonly<{ job: PublicationJobResponse; handoff: AssistedHandoff }> | null = null;
const restorationErrors: string[] = [];

try {
  await setControl(
    api,
    "supervised",
    baseline.control.quota,
    "Prepare one audited Ctrip draft under supervised operator control",
  );
  await setAccountCircuit(
    api,
    accountId,
    "closed",
    "Allow one audited assisted Ctrip draft preparation",
  );
  await setKillSwitch(api, false, "Allow one audited assisted Ctrip draft preparation");

  const publication = await api.request<PublicationRequestResponse>("/api/publication-requests", {
    method: "POST",
    body: JSON.stringify({
      grantId: authorization.grantId,
      token: authorization.token,
      idempotencyKey: `ctrip-assisted-draft:${authorization.grantId}`,
      executionLevel: "assisted",
    }),
  });
  jobId = publication.publicationJobId;
  console.log(JSON.stringify({ phase: "draft-enqueued", publicationJobId: jobId }));

  const deadline = Date.now() + timeoutMs;
  let lastSignal = "";
  while (Date.now() < deadline) {
    const [job, handoffs] = await Promise.all([
      api.request<PublicationJobResponse>(`/api/publication-jobs/${jobId}`),
      api.request<AssistedHandoffsResponse>("/api/publication-assisted-handoffs"),
    ]);
    const handoff = handoffs.items.find((item) => item.jobId === jobId) ?? null;
    const signal = JSON.stringify({
      jobState: job.state,
      handoffState: handoff?.state ?? null,
      lastErrorCode: job.lastErrorCode ?? null,
    });
    if (signal !== lastSignal) {
      console.log(JSON.stringify({ phase: "draft-progress", ...JSON.parse(signal) }));
      lastSignal = signal;
    }
    if (handoff?.state === "draft_prepared") {
      prepared = { job, handoff };
      break;
    }
    if (
      ["challenge_required", "session_required", "failed", "cancelled", "expired"].includes(
        handoff?.state ?? "",
      ) ||
      ["needs_review", "permanent_failure", "cancelled"].includes(job.state)
    ) {
      throw new Error(`Ctrip draft preparation stopped at ${handoff?.state ?? job.state}`);
    }
    await sleep(1_000);
  }
  if (prepared === null) throw new Error("Ctrip draft preparation timed out");
} finally {
  for (const operation of [
    () =>
      setKillSwitch(
        api,
        baseline.control.killSwitchEnabled,
        "Restore the pre-draft tenant kill switch state",
      ),
    () =>
      setControl(
        api,
        baseline.control.mode,
        baseline.control.quota,
        "Restore the pre-draft automation control state",
      ),
    () =>
      setAccountCircuit(
        api,
        accountId,
        restoreCircuitState,
        "Restore the pre-draft Ctrip account circuit state",
      ),
  ]) {
    try {
      await operation();
    } catch (error) {
      restorationErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

if (restorationErrors.length > 0) {
  throw new Error(`Safety restoration failed: ${restorationErrors.join("; ")}`);
}
if (prepared === null || jobId === null) throw new Error("Ctrip draft was not prepared");

console.log(
  JSON.stringify({
    phase: "draft-prepared",
    publicationJobId: jobId,
    handoffId: prepared.handoff.id,
    title: prepared.handoff.title ?? null,
    payloadHash: prepared.handoff.payloadHash,
    auditHash: prepared.handoff.auditHash,
    previewHash: prepared.handoff.previewHash,
    externalDraftId: prepared.handoff.externalDraftId,
    finalPublishCalled: false,
  }),
);
