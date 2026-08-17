import { readFile, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  CTRIP_COMMUNITY_PUBLICATION_LIMITS,
  idSchema,
  publicationVariantPayloadSchema,
  type PublicationVariantPayload,
} from "../packages/contracts/src/index.js";
import { sha256Canonical } from "../packages/core/src/canonical.js";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:10004";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface CtripCandidateDocument {
  readonly schemaVersion: "geo.ctrip-canonical-candidate.v1";
  readonly tenantId: string;
  readonly contentItemId: string;
  readonly channelAccountId: string;
  readonly expectedBrandDisplayName: string;
  readonly baseVersion: Readonly<{
    id: string;
    payloadHash: string;
    mediaAssetIds: readonly string[];
  }>;
  readonly payload: Omit<PublicationVariantPayload, "media">;
}

interface LoginResponse {
  readonly csrfToken: string;
}

interface SessionResponse {
  readonly tenant?: Readonly<{ id?: string }>;
  readonly tenantId?: string;
}

interface ApiErrorResponse {
  readonly error?: Readonly<{ code?: string; message?: string }>;
}

interface ContentView {
  readonly id: string;
  readonly latestVersionId: string | null;
}

interface ContentListResponse {
  readonly items: readonly ContentView[];
}

interface ContentVersionView {
  readonly id: string;
  readonly contentItemId: string;
  readonly payload: PublicationVariantPayload;
  readonly payloadHash: string;
}

interface VariantView {
  readonly id: string;
  readonly contentVersionId: string;
  readonly channelAccountId: string;
  readonly platform: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly state: string;
}

interface VariantListResponse {
  readonly items: readonly VariantView[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Candidate field ${key} must be a non-empty string`);
  }
  return value.trim();
}

function uuid(value: string, field: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${field} must be a UUID`);
  return parsed.data;
}

function codePointLength(value: string): number {
  return [...value.trim()].length;
}

function occurrenceCount(text: string, needle: string): number {
  if (needle.length === 0) return 0;
  return text.split(needle).length - 1;
}

function authoredClaimIds(payload: PublicationVariantPayload): Set<string> {
  const ids = new Set<string>();
  for (const block of [
    ...(payload.titleBlocks ?? []),
    ...(payload.summaryBlocks ?? []),
    ...(payload.bodyBlocks ?? []),
  ]) {
    if (block.type === "authored") block.claimIds.forEach((id) => ids.add(id));
  }
  return ids;
}

function assertAuthoredRendering(payload: PublicationVariantPayload): void {
  const titleBlocks = payload.titleBlocks ?? [];
  const summaryBlocks = payload.summaryBlocks ?? [];
  const bodyBlocks = payload.bodyBlocks ?? [];
  if (
    titleBlocks.length === 0 ||
    summaryBlocks.length === 0 ||
    bodyBlocks.length === 0 ||
    [...titleBlocks, ...summaryBlocks, ...bodyBlocks].some((block) => block.type !== "authored")
  ) {
    throw new TypeError("Ctrip candidate must use complete authored canonical blocks");
  }
  const title = titleBlocks
    .map((block) => (block.type === "authored" ? block.text.trim() : ""))
    .join(" ");
  const summary = summaryBlocks
    .map((block) => (block.type === "authored" ? block.text.trim() : ""))
    .join(" ");
  const bodyMarkdown = bodyBlocks
    .map((block) => (block.type === "authored" ? block.text.trim() : ""))
    .join("\n\n");
  if (
    title !== payload.title ||
    summary !== payload.summary ||
    bodyMarkdown !== payload.bodyMarkdown
  ) {
    throw new TypeError("Candidate rendered fields do not match authored canonical blocks");
  }
}

function assertCtripPayloadSafety(
  payload: PublicationVariantPayload,
  brandDisplayName: string,
): void {
  assertAuthoredRendering(payload);
  const titleLength = codePointLength(payload.title);
  const bodyLength = codePointLength(payload.bodyMarkdown);
  const limits = CTRIP_COMMUNITY_PUBLICATION_LIMITS;
  if (
    titleLength < limits.minTitleCharacters ||
    titleLength > limits.maxTitleCharacters ||
    bodyLength < limits.minBodyCharacters ||
    bodyLength > limits.maxBodyCharacters
  ) {
    throw new TypeError(
      `Candidate is outside Ctrip title/body limits (${titleLength}/${bodyLength})`,
    );
  }
  if (
    occurrenceCount(payload.title, brandDisplayName) !== 0 ||
    occurrenceCount(payload.summary, brandDisplayName) !== 0 ||
    occurrenceCount(payload.bodyMarkdown, brandDisplayName) !== 1
  ) {
    throw new TypeError(
      "Ctrip candidate must contain the exact brand once in body and nowhere else",
    );
  }
  if (payload.contactIds.length !== 0) {
    throw new TypeError("Ctrip candidate must not bind tenant contacts");
  }
  const forbiddenContactText =
    /(?:https?:\/\/|www\.|@[a-z0-9.-]+\.[a-z]{2,}|微信|二维码|电话|手机号)/iu;
  if (forbiddenContactText.test(`${payload.title}\n${payload.summary}\n${payload.bodyMarkdown}`)) {
    throw new TypeError("Ctrip candidate contains a prohibited contact route");
  }
  const claimIds = new Set(payload.claims.map((claim) => claim.id));
  const referencedClaimIds = authoredClaimIds(payload);
  for (const claim of payload.claims) {
    if (!referencedClaimIds.has(claim.id)) {
      throw new TypeError(`Candidate claim ${claim.id} is not bound to authored prose`);
    }
    const renderedText = `${payload.title}\n${payload.summary}\n${payload.bodyMarkdown}`;
    if (!renderedText.includes(claim.text)) {
      throw new TypeError(`Candidate does not contain verified claim text ${claim.id} verbatim`);
    }
  }
  for (const claimId of referencedClaimIds) {
    if (!claimIds.has(claimId)) {
      throw new TypeError(`Authored prose references unknown candidate claim ${claimId}`);
    }
  }
  for (const intent of payload.mediaSearchPlan ?? []) {
    for (const claimId of intent.claimIds) {
      if (!claimIds.has(claimId)) {
        throw new TypeError(`Media search intent references unknown candidate claim ${claimId}`);
      }
    }
  }
}

export function parseCtripCandidateDocument(value: unknown): CtripCandidateDocument {
  if (!isRecord(value)) throw new TypeError("Candidate document must be a JSON object");
  if (requiredString(value, "schemaVersion") !== "geo.ctrip-canonical-candidate.v1") {
    throw new TypeError("Candidate schemaVersion is unsupported");
  }
  const baseVersion = value.baseVersion;
  if (!isRecord(baseVersion)) throw new TypeError("Candidate baseVersion must be an object");
  const mediaAssetIds = baseVersion.mediaAssetIds;
  if (
    !Array.isArray(mediaAssetIds) ||
    mediaAssetIds.length < CTRIP_COMMUNITY_PUBLICATION_LIMITS.minImages ||
    mediaAssetIds.length > CTRIP_COMMUNITY_PUBLICATION_LIMITS.maxImages ||
    !mediaAssetIds.every((id) => idSchema.safeParse(id).success) ||
    new Set(mediaAssetIds).size !== mediaAssetIds.length
  ) {
    throw new TypeError("Candidate base media IDs must be four or five unique UUIDs");
  }
  if (!isRecord(value.payload) || Object.hasOwn(value.payload, "media")) {
    throw new TypeError("Candidate payload must omit media and inherit immutable base references");
  }
  const parsedPayload = publicationVariantPayloadSchema.parse({ ...value.payload, media: [] });
  const expectedBrandDisplayName = requiredString(value, "expectedBrandDisplayName");
  assertCtripPayloadSafety(parsedPayload, expectedBrandDisplayName);
  const payloadHash = requiredString(baseVersion, "payloadHash");
  if (!SHA256_PATTERN.test(payloadHash)) {
    throw new TypeError("Candidate baseVersion.payloadHash must be a SHA-256 hex digest");
  }
  return {
    schemaVersion: "geo.ctrip-canonical-candidate.v1",
    tenantId: uuid(requiredString(value, "tenantId"), "tenantId"),
    contentItemId: uuid(requiredString(value, "contentItemId"), "contentItemId"),
    channelAccountId: uuid(requiredString(value, "channelAccountId"), "channelAccountId"),
    expectedBrandDisplayName,
    baseVersion: {
      id: uuid(requiredString(baseVersion, "id"), "baseVersion.id"),
      payloadHash,
      mediaAssetIds: mediaAssetIds as string[],
    },
    payload: parsedPayload,
  };
}

export function materializeCtripCandidate(
  candidate: CtripCandidateDocument,
  baseVersion: ContentVersionView,
): PublicationVariantPayload {
  if (
    baseVersion.id !== candidate.baseVersion.id ||
    baseVersion.contentItemId !== candidate.contentItemId ||
    baseVersion.payloadHash !== candidate.baseVersion.payloadHash ||
    sha256Canonical(baseVersion.payload) !== candidate.baseVersion.payloadHash
  ) {
    throw new TypeError("Candidate base content version identity or payload hash changed");
  }
  const media = publicationVariantPayloadSchema.parse(baseVersion.payload).media;
  const mediaIds = media.map((reference) => reference.id);
  assertInheritedMediaIds(candidate.baseVersion.mediaAssetIds, mediaIds);
  if (
    media.filter((reference) => reference.role === "cover").length !== 1 ||
    media.some(
      (reference) =>
        reference.platform !== "ctrip_community" || reference.inspection.status !== "passed",
    )
  ) {
    throw new TypeError("Candidate base media is not a reviewed Ctrip image set");
  }
  const payload = publicationVariantPayloadSchema.parse({ ...candidate.payload, media });
  assertCtripPayloadSafety(payload, candidate.expectedBrandDisplayName);
  return payload;
}

export function assertInheritedMediaIds(
  expectedIds: readonly string[],
  actualIds: readonly string[],
): void {
  if (
    actualIds.length !== expectedIds.length ||
    !actualIds.every((id, index) => id === expectedIds[index])
  ) {
    throw new TypeError("Candidate base media references changed or were reordered");
  }
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
    if (separator > 0) {
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  const email = values.get("Email");
  const password = values.get("Password");
  if (email === undefined || password === undefined) {
    throw new Error("Login file must contain Email and Password fields");
  }
  return { email, password };
}

async function readSecureLoginFile(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("Login file must be a regular, non-symlink, single-link file");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("Login file mode must be exactly 0600");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Login file must be owned by the current user");
  }
  return readFile(path, "utf8");
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
      body: JSON.stringify(credentials(await readSecureLoginFile(loginFile))),
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

function exactCandidateVariant(
  variants: readonly VariantView[],
  contentVersionId: string,
  channelAccountId: string,
): VariantView | null {
  const matches = variants.filter(
    (variant) =>
      variant.contentVersionId === contentVersionId &&
      variant.channelAccountId === channelAccountId &&
      variant.state !== "superseded",
  );
  if (matches.length > 1) {
    throw new Error("More than one active Ctrip variant exists for the candidate version/account");
  }
  return matches[0] ?? null;
}

function assertVariantReadback(
  variant: VariantView,
  contentVersionId: string,
  channelAccountId: string,
  expectedPayload: PublicationVariantPayload,
): void {
  const payload = publicationVariantPayloadSchema.parse(variant.payload);
  const expectedClaimIds = expectedPayload.claims.map((claim) => claim.id);
  if (
    variant.contentVersionId !== contentVersionId ||
    variant.channelAccountId !== channelAccountId ||
    variant.platform !== "ctrip_community" ||
    sha256Canonical(payload) !== variant.payloadHash ||
    payload.title !== expectedPayload.title ||
    payload.summary !== expectedPayload.summary ||
    payload.bodyMarkdown !== expectedPayload.bodyMarkdown ||
    payload.locationQuery !== expectedPayload.locationQuery ||
    sha256Canonical(payload.brandAgentProfile) !==
      sha256Canonical(expectedPayload.brandAgentProfile) ||
    payload.contactIds.length !== 0 ||
    payload.claims.length !== expectedClaimIds.length ||
    !payload.claims.every((claim, index) => claim.id === expectedClaimIds[index]) ||
    payload.media.length !== expectedPayload.media.length ||
    !payload.media.every((media, index) => media.id === expectedPayload.media[index]?.id)
  ) {
    throw new Error("Ctrip variant readback does not match the candidate binding");
  }
}

async function main(): Promise<void> {
  const candidateFile = requiredArgument("candidate-file");
  const loginFile = requiredArgument("login-file");
  const apiBaseUrl = argument("api-base-url") ?? DEFAULT_API_BASE_URL;
  const candidate = parseCtripCandidateDocument(
    JSON.parse(await readFile(candidateFile, "utf8")) as unknown,
  );
  const api = new ApiSession(apiBaseUrl);
  await api.login(loginFile);

  const session = await api.request<SessionResponse>("/api/auth/session");
  const sessionTenantId = session.tenant?.id ?? session.tenantId;
  if (sessionTenantId !== candidate.tenantId) {
    throw new Error("Authenticated API session is scoped to another tenant");
  }

  const contentList = await api.request<ContentListResponse>("/api/content");
  const content = contentList.items.find((item) => item.id === candidate.contentItemId);
  if (content === undefined || content.latestVersionId === null) {
    throw new Error("Candidate content item or latest source version was not found");
  }
  const [baseVersion, latestVersion] = await Promise.all([
    api.request<ContentVersionView>(`/api/content-versions/${candidate.baseVersion.id}`),
    api.request<ContentVersionView>(`/api/content-versions/${content.latestVersionId}`),
  ]);
  const payload = materializeCtripCandidate(candidate, baseVersion);
  const payloadHash = sha256Canonical(payload);

  let contentVersion = latestVersion;
  let contentVersionCreated = false;
  if (latestVersion.payloadHash !== payloadHash) {
    if (
      latestVersion.id !== candidate.baseVersion.id ||
      latestVersion.payloadHash !== candidate.baseVersion.payloadHash
    ) {
      throw new Error("Latest content version changed since the candidate was reviewed");
    }
    const created = await api.request<ContentView>(
      `/api/content/${candidate.contentItemId}/versions`,
      { method: "POST", body: JSON.stringify({ payload }) },
    );
    if (created.latestVersionId === null) {
      throw new Error("Content-version creation returned no latestVersionId");
    }
    contentVersion = await api.request<ContentVersionView>(
      `/api/content-versions/${created.latestVersionId}`,
    );
    contentVersionCreated = true;
  }
  if (
    contentVersion.contentItemId !== candidate.contentItemId ||
    contentVersion.payloadHash !== payloadHash ||
    sha256Canonical(contentVersion.payload) !== payloadHash
  ) {
    throw new Error("Candidate content-version readback hash does not match");
  }

  let variants = await api.request<VariantListResponse>(
    `/api/content/${candidate.contentItemId}/variants`,
  );
  let variant = exactCandidateVariant(
    variants.items,
    contentVersion.id,
    candidate.channelAccountId,
  );
  let variantCreated = false;
  if (variant === null) {
    await api.request<VariantView>(`/api/content/${candidate.contentItemId}/variants`, {
      method: "POST",
      body: JSON.stringify({
        contentVersionId: contentVersion.id,
        channelAccountId: candidate.channelAccountId,
      }),
    });
    variants = await api.request<VariantListResponse>(
      `/api/content/${candidate.contentItemId}/variants`,
    );
    variant = exactCandidateVariant(variants.items, contentVersion.id, candidate.channelAccountId);
    variantCreated = true;
  }
  if (variant === null) throw new Error("Ctrip variant was not returned by API readback");
  assertVariantReadback(variant, contentVersion.id, candidate.channelAccountId, payload);

  console.log(
    JSON.stringify({
      phase: "candidate-commissioned",
      tenantId: candidate.tenantId,
      contentItemId: candidate.contentItemId,
      contentVersionId: contentVersion.id,
      contentPayloadHash: contentVersion.payloadHash,
      contentVersionCreated,
      variantId: variant.id,
      variantPayloadHash: variant.payloadHash,
      variantState: variant.state,
      variantCreated,
      piProvenanceAsserted: false,
      auditCalled: false,
      publicationCalled: false,
    }),
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
