import { sha256Canonical } from "@geo/core";

const MAX_LABEL_LENGTH = 80;
const MAX_PAGES = 10;
const MAX_CONTROLS_PER_PAGE = 40;

interface CtripControlProbe {
  readonly id: string;
  readonly selector: string;
  readonly readText: boolean;
}

interface CtripChallengeProbe {
  readonly id: string;
  readonly selector: string;
}

interface CtripReviewedSurface {
  readonly origin: string;
  readonly path: string;
}

interface CtripSurfaceReviewManifest {
  readonly schemaVersion: "geo.ctrip-surface-manifest.v1";
  readonly manifestVersion: string;
  readonly allowedHostnameSuffix: "ctrip.com";
  readonly liveCanaryEnabled: boolean;
  readonly reviewedSurfaces: readonly CtripReviewedSurface[];
  readonly sessionHostnameLabels: readonly string[];
  readonly sessionPathSegments: readonly string[];
  readonly controlProbes: readonly CtripControlProbe[];
  readonly challengeProbes: readonly CtripChallengeProbe[];
}

export const CTRIP_SURFACE_REVIEW_MANIFEST: CtripSurfaceReviewManifest = Object.freeze({
  schemaVersion: "geo.ctrip-surface-manifest.v1",
  manifestVersion: "ctrip-community-surface-review-v1",
  allowedHostnameSuffix: "ctrip.com",
  liveCanaryEnabled: false,
  reviewedSurfaces: Object.freeze([]),
  sessionHostnameLabels: Object.freeze(["account", "accounts", "passport"]),
  sessionPathSegments: Object.freeze(["login", "signin", "passport"]),
  controlProbes: Object.freeze([
    Object.freeze({
      id: "action",
      selector: 'button, [role="button"], input[type="submit"], input[type="button"]',
      readText: true,
    }),
    Object.freeze({
      id: "editor",
      selector: 'textarea, [contenteditable="true"]',
      readText: false,
    }),
    Object.freeze({
      id: "file_upload",
      selector: 'input[type="file"]',
      readText: false,
    }),
  ]),
  challengeProbes: Object.freeze([
    Object.freeze({ id: "captcha_frame", selector: 'iframe[src*="captcha" i]' }),
    Object.freeze({
      id: "captcha_control",
      selector: '[id*="captcha" i], [class*="captcha" i]',
    }),
    Object.freeze({
      id: "verification_control",
      selector: '[id*="verify" i], [class*="verify" i]',
    }),
  ]),
});

export interface CtripRawObservedControl {
  readonly probeId: string;
  readonly rawLabel: string;
}

export interface CtripSurfaceReviewPage {
  currentUrl(): string;
  readControls(
    probes: readonly CtripControlProbe[],
    maximum: number,
  ): Promise<readonly CtripRawObservedControl[]>;
  detectChallengeSignals(probes: readonly CtripChallengeProbe[]): Promise<readonly string[]>;
}

export interface CtripCanonicalPageLocation {
  readonly origin: string;
  readonly path: string;
}

interface CtripSurfaceReviewPageEvidence extends CtripCanonicalPageLocation {
  readonly observationStatus: "complete" | "unavailable";
  readonly sessionSignal: "login_location" | null;
  readonly controls: readonly { readonly probeId: string; readonly label: string }[];
  readonly challengeSignals: readonly string[];
}

export interface CtripSurfaceReviewEvidence {
  readonly schemaVersion: "geo.ctrip-surface-review.v1";
  readonly manifestVersion: string;
  readonly outcome:
    "session_required" | "challenge_required" | "adapter_drift" | "reviewed_surface";
  readonly observedAt: string;
  readonly evidenceKind: "browser";
  readonly sessionEvidenceHash: string;
  readonly evidenceHash: string;
  readonly pages: readonly CtripSurfaceReviewPageEvidence[];
}

export function canonicalCtripPageLocation(value: string): CtripCanonicalPageLocation | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (hostname !== CTRIP_SURFACE_REVIEW_MANIFEST.allowedHostnameSuffix &&
      !hostname.endsWith(`.${CTRIP_SURFACE_REVIEW_MANIFEST.allowedHostnameSuffix}`))
  ) {
    return null;
  }
  return Object.freeze({ origin: parsed.origin, path: parsed.pathname });
}

export function sanitizeCtripReviewLabel(value: string): string | null {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) return null;
  const redacted = normalized
    .replace(/https?:\/\/[^\s]+/giu, "[url]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[email]")
    .replace(/(?:\+?86[\s-]?)?1[3-9]\d{9}/gu, "[phone]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "[id]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, "[token]")
    .replace(/\b\d{6,}\b/gu, "[number]")
    .replace(/\s+/gu, " ")
    .trim();
  if (redacted.length === 0) return null;
  return redacted.slice(0, MAX_LABEL_LENGTH).trimEnd();
}

function compareCanonical(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right), "en");
}

function sessionSignal(
  location: CtripCanonicalPageLocation,
): CtripSurfaceReviewPageEvidence["sessionSignal"] {
  const hostnameLabels = new URL(location.origin).hostname.toLowerCase().split(".");
  const pathSegments = location.path
    .toLowerCase()
    .split("/")
    .filter((segment) => segment.length > 0);
  return hostnameLabels.some((label) =>
    CTRIP_SURFACE_REVIEW_MANIFEST.sessionHostnameLabels.includes(label),
  ) ||
    pathSegments.some((segment) =>
      CTRIP_SURFACE_REVIEW_MANIFEST.sessionPathSegments.includes(segment),
    )
    ? "login_location"
    : null;
}

async function inspectPage(
  page: CtripSurfaceReviewPage,
  location: CtripCanonicalPageLocation,
): Promise<CtripSurfaceReviewPageEvidence> {
  try {
    const [rawControls, rawSignals] = await Promise.all([
      page.readControls(CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes, MAX_CONTROLS_PER_PAGE),
      page.detectChallengeSignals(CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes),
    ]);
    const allowedControlIds = new Set(
      CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes.map((probe) => probe.id),
    );
    const controls = new Map<string, { readonly probeId: string; readonly label: string }>();
    for (const control of rawControls.slice(0, MAX_CONTROLS_PER_PAGE)) {
      if (!allowedControlIds.has(control.probeId)) continue;
      const label = sanitizeCtripReviewLabel(control.rawLabel);
      if (label === null) continue;
      controls.set(`${control.probeId}\u0000${label}`, { probeId: control.probeId, label });
    }
    const allowedSignalIds = new Set(
      CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes.map((probe) => probe.id),
    );
    const challengeSignals = [
      ...new Set(rawSignals.filter((id) => allowedSignalIds.has(id))),
    ].sort();
    return Object.freeze({
      ...location,
      observationStatus: "complete" as const,
      sessionSignal: sessionSignal(location),
      controls: Object.freeze([...controls.values()].sort(compareCanonical)),
      challengeSignals: Object.freeze(challengeSignals),
    });
  } catch {
    return Object.freeze({
      ...location,
      observationStatus: "unavailable" as const,
      sessionSignal: sessionSignal(location),
      controls: Object.freeze([]),
      challengeSignals: Object.freeze([]),
    });
  }
}

export async function reviewCtripAuthenticatedSurface(
  candidates: readonly CtripSurfaceReviewPage[],
  options: { readonly now?: () => Date } = {},
): Promise<CtripSurfaceReviewEvidence> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const eligible = candidates
    .map((page) => ({ page, location: canonicalCtripPageLocation(page.currentUrl()) }))
    .filter(
      (
        candidate,
      ): candidate is {
        readonly page: CtripSurfaceReviewPage;
        readonly location: CtripCanonicalPageLocation;
      } => candidate.location !== null,
    )
    .sort((left, right) => compareCanonical(left.location, right.location))
    .slice(0, MAX_PAGES);
  const pages = Object.freeze(
    (await Promise.all(eligible.map(({ page, location }) => inspectPage(page, location)))).sort(
      compareCanonical,
    ),
  );
  const hasChallenge = pages.some((page) => page.challengeSignals.length > 0);
  const onlySessionLocations = pages.every((page) => page.sessionSignal !== null);
  const hasReviewedSurface = pages.some((page) =>
    CTRIP_SURFACE_REVIEW_MANIFEST.reviewedSurfaces.some(
      (surface) => surface.origin === page.origin && surface.path === page.path,
    ),
  );
  const outcome =
    pages.length === 0
      ? "session_required"
      : hasChallenge
        ? "challenge_required"
        : onlySessionLocations
          ? "session_required"
          : hasReviewedSurface
            ? "reviewed_surface"
            : "adapter_drift";
  const material = Object.freeze({
    schemaVersion: "geo.ctrip-surface-review.v1" as const,
    manifestVersion: CTRIP_SURFACE_REVIEW_MANIFEST.manifestVersion,
    outcome,
    observedAt,
    evidenceKind: "browser" as const,
    pages,
  });
  const sessionEvidenceHash = sha256Canonical({
    schemaVersion: material.schemaVersion,
    manifestVersion: material.manifestVersion,
    outcome: material.outcome,
    observedAt: material.observedAt,
    pages: pages.map((page) => ({
      origin: page.origin,
      path: page.path,
      observationStatus: page.observationStatus,
      sessionSignal: page.sessionSignal,
      challengeSignals: page.challengeSignals,
    })),
  });
  return Object.freeze({
    ...material,
    sessionEvidenceHash,
    evidenceHash: sha256Canonical({ ...material, sessionEvidenceHash }),
  });
}

export function assertCtripLiveCanaryReady(): CtripSurfaceReviewManifest {
  if (
    !CTRIP_SURFACE_REVIEW_MANIFEST.liveCanaryEnabled ||
    CTRIP_SURFACE_REVIEW_MANIFEST.reviewedSurfaces.length === 0
  ) {
    throw new Error("Ctrip live canary surface is not reviewed");
  }
  return CTRIP_SURFACE_REVIEW_MANIFEST;
}
