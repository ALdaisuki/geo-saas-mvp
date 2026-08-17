import { sha256Canonical } from "@geo/core";

import type { CtripBridgeMode } from "./config.js";
import {
  CTRIP_BODY_EDITOR_SELECTOR,
  CTRIP_ACTION_SELECTOR,
  CTRIP_DRAFT_ACTION_LABEL,
  CTRIP_EDITOR_CONTROL_PROBES,
  CTRIP_EDITOR_ORIGIN,
  CTRIP_EDITOR_PATH,
  CTRIP_IMAGE_INPUT_SELECTOR,
  CTRIP_PUBLISH_ACTION_LABEL,
  CTRIP_TITLE_EDITOR_SELECTOR,
  CTRIP_UPLOAD_ACTION_LABEL,
} from "./editor-surface-contract.js";

const MAX_LABEL_LENGTH = 80;
const MAX_PAGES = 10;
const MAX_CONTROLS_PER_PAGE = 40;
const MAX_ATTRIBUTES_PER_CONTROL = 12;

interface CtripControlProbe {
  readonly id: string;
  readonly selector: string;
  readonly readText: boolean;
  readonly visibility: "visible" | "attached";
}

interface CtripChallengeProbe {
  readonly id: string;
  readonly selector: string;
}

interface CtripSurfaceLocation {
  readonly origin: string;
  readonly path: string;
}

interface CtripReviewedControl {
  readonly probeId: string;
  readonly label: string;
  readonly selector: string;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
}

interface CtripReviewedSurface extends CtripSurfaceLocation {
  readonly requiredControls: readonly CtripReviewedControl[];
}

interface CtripAuthenticatedSurface extends CtripSurfaceLocation {
  readonly requiredControls: readonly CtripReviewedControl[];
}

interface CtripSurfaceReviewManifest {
  readonly schemaVersion: "geo.ctrip-surface-manifest.v3";
  readonly manifestVersion: string;
  readonly allowedHostnameSuffix: "ctrip.com";
  readonly liveCanaryEnabled: boolean;
  readonly unattendedEnabled: boolean;
  readonly discoverySurfaces: readonly CtripSurfaceLocation[];
  readonly reviewedSurfaces: readonly CtripReviewedSurface[];
  readonly authenticatedSurfaces: readonly CtripAuthenticatedSurface[];
  readonly sessionHostnameLabels: readonly string[];
  readonly sessionPathSegments: readonly string[];
  readonly controlProbes: readonly CtripControlProbe[];
  readonly controlAttributeNames: readonly string[];
  readonly challengeProbes: readonly CtripChallengeProbe[];
}

const CTRIP_AUTHENTICATED_HOME_PROBES = Object.freeze([
  Object.freeze({
    id: "account_entry",
    selector: "#hp_nfes_accountbar",
    readText: false,
    visibility: "visible" as const,
  }),
  Object.freeze({
    id: "account_destination",
    selector: 'a[href^="https://my.ctrip.com/myinfo/"]',
    readText: false,
    visibility: "visible" as const,
  }),
  Object.freeze({
    id: "order_entry",
    selector: 'button[class*="order"]',
    readText: true,
    visibility: "visible" as const,
  }),
]);

const CTRIP_AUTHENTICATED_WORKSPACE_PROBES = Object.freeze([
  Object.freeze({
    id: "content_management_entry",
    selector: 'a[href="/publish/contentManagement"]',
    readText: true,
    visibility: "visible" as const,
  }),
  Object.freeze({
    id: "content_management_search",
    selector: 'input[placeholder="请输入关键字"]',
    readText: false,
    visibility: "visible" as const,
  }),
  Object.freeze({
    id: "analytics_tab",
    selector: '[role="tab"]',
    readText: true,
    visibility: "visible" as const,
  }),
]);

export const CTRIP_SURFACE_REVIEW_MANIFEST: CtripSurfaceReviewManifest = Object.freeze({
  schemaVersion: "geo.ctrip-surface-manifest.v3",
  manifestVersion: "ctrip-community-surface-review-v5",
  allowedHostnameSuffix: "ctrip.com",
  liveCanaryEnabled: true,
  unattendedEnabled: true,
  discoverySurfaces: Object.freeze([
    Object.freeze({
      origin: CTRIP_EDITOR_ORIGIN,
      path: CTRIP_EDITOR_PATH,
    }),
  ]),
  reviewedSurfaces: Object.freeze([
    Object.freeze({
      origin: CTRIP_EDITOR_ORIGIN,
      path: CTRIP_EDITOR_PATH,
      requiredControls: Object.freeze([
        Object.freeze({
          probeId: "title_editor",
          label: "title_editor",
          selector: CTRIP_TITLE_EDITOR_SELECTOR,
          attributes: Object.freeze([
            Object.freeze({ name: "contenteditable", value: "true" }),
            Object.freeze({ name: "role", value: "textbox" }),
          ]),
        }),
        Object.freeze({
          probeId: "body_editor",
          label: "body_editor",
          selector: CTRIP_BODY_EDITOR_SELECTOR,
          attributes: Object.freeze([
            Object.freeze({ name: "contenteditable", value: "true" }),
            Object.freeze({ name: "role", value: "combobox" }),
          ]),
        }),
        Object.freeze({
          probeId: "image_input",
          label: "image_input",
          selector: CTRIP_IMAGE_INPUT_SELECTOR,
          attributes: Object.freeze([
            Object.freeze({ name: "accept", value: "image/*" }),
            Object.freeze({ name: "type", value: "file" }),
          ]),
        }),
        Object.freeze({
          probeId: "action",
          label: CTRIP_UPLOAD_ACTION_LABEL,
          selector: CTRIP_ACTION_SELECTOR,
          attributes: Object.freeze([Object.freeze({ name: "role", value: "button" })]),
        }),
        Object.freeze({
          probeId: "action",
          label: CTRIP_DRAFT_ACTION_LABEL,
          selector: CTRIP_ACTION_SELECTOR,
          attributes: Object.freeze([Object.freeze({ name: "type", value: "button" })]),
        }),
        Object.freeze({
          probeId: "action",
          label: CTRIP_PUBLISH_ACTION_LABEL,
          selector: CTRIP_ACTION_SELECTOR,
          attributes: Object.freeze([Object.freeze({ name: "type", value: "button" })]),
        }),
      ]),
    }),
  ]),
  authenticatedSurfaces: Object.freeze([
    Object.freeze({
      origin: "https://we.ctrip.com",
      path: "/publish/contentManagement",
      requiredControls: Object.freeze([
        Object.freeze({
          probeId: "content_management_entry",
          label: "内容管理",
          selector: 'a[href="/publish/contentManagement"]',
          attributes: Object.freeze([
            Object.freeze({ name: "href", value: "/publish/contentManagement" }),
          ]),
        }),
        Object.freeze({
          probeId: "content_management_search",
          label: "请输入关键字",
          selector: 'input[placeholder="请输入关键字"]',
          attributes: Object.freeze([
            Object.freeze({ name: "placeholder", value: "请输入关键字" }),
          ]),
        }),
      ]),
    }),
    Object.freeze({
      origin: "https://we.ctrip.com",
      path: "/analyse/contentAnalysis",
      requiredControls: Object.freeze([
        Object.freeze({
          probeId: "analytics_tab",
          label: "内容概况",
          selector: '[role="tab"]',
          attributes: Object.freeze([Object.freeze({ name: "role", value: "tab" })]),
        }),
        Object.freeze({
          probeId: "analytics_tab",
          label: "单条分析",
          selector: '[role="tab"]',
          attributes: Object.freeze([Object.freeze({ name: "role", value: "tab" })]),
        }),
      ]),
    }),
    Object.freeze({
      origin: "https://www.ctrip.com",
      path: "/",
      requiredControls: Object.freeze([
        Object.freeze({
          probeId: "account_entry",
          label: "account_entry",
          selector: "#hp_nfes_accountbar",
          attributes: Object.freeze([]),
        }),
        Object.freeze({
          probeId: "account_destination",
          label: "account_destination",
          selector: 'a[href^="https://my.ctrip.com/myinfo/"]',
          attributes: Object.freeze([]),
        }),
        Object.freeze({
          probeId: "order_entry",
          label: "我的订单",
          selector: 'button[class*="order"]',
          attributes: Object.freeze([]),
        }),
      ]),
    }),
  ]),
  sessionHostnameLabels: Object.freeze(["account", "accounts", "passport"]),
  sessionPathSegments: Object.freeze(["login", "fastlogin", "signin", "passport"]),
  controlProbes: Object.freeze([
    ...CTRIP_EDITOR_CONTROL_PROBES,
    ...CTRIP_AUTHENTICATED_HOME_PROBES,
    ...CTRIP_AUTHENTICATED_WORKSPACE_PROBES,
  ]),
  controlAttributeNames: Object.freeze([
    "aria-label",
    "aria-disabled",
    "title",
    "placeholder",
    "role",
    "type",
    "name",
    "id",
    "data-testid",
    "contenteditable",
    "accept",
    "disabled",
    "href",
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
  readonly rawAttributes?: readonly { readonly name: string; readonly rawValue: string }[];
}

export interface CtripSurfaceReviewPage {
  currentUrl(): string;
  readControls(
    probes: readonly CtripControlProbe[],
    attributeNames: readonly string[],
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
  readonly authenticatedSessionSignal: "account_location" | null;
  readonly controls: readonly {
    readonly probeId: string;
    readonly label: string;
    readonly attributes: readonly { readonly name: string; readonly value: string }[];
  }[];
  readonly challengeSignals: readonly string[];
}

export interface CtripSurfaceReviewEvidence {
  readonly schemaVersion: "geo.ctrip-surface-review.v2";
  readonly manifestVersion: string;
  readonly outcome:
    "session_required" | "challenge_required" | "adapter_drift" | "reviewed_surface";
  readonly observedAt: string;
  readonly evidenceKind: "browser";
  readonly sessionEvidenceHash: string;
  readonly evidenceHash: string;
  readonly authenticated: boolean;
  readonly pages: readonly CtripSurfaceReviewPageEvidence[];
}

export interface CtripOperationalReadiness {
  readonly schemaVersion: "geo.ctrip-operational-readiness.v1";
  readonly status: "ready" | "session_required" | "challenge_required" | "unavailable";
  readonly observedAt: string;
  readonly manifestVersion: string;
  readonly sessionEvidenceHash: string;
  readonly evidenceHash: string;
  readonly authenticated: boolean;
}

const CTRIP_AUTHENTICATED_ACCOUNT_ORIGIN = "https://my.ctrip.com";
const CTRIP_AUTHENTICATED_ACCOUNT_PATH_PREFIX = "/myinfo";

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

function matchesRequiredControl(
  observed: CtripSurfaceReviewPageEvidence["controls"][number],
  required: CtripReviewedControl,
): boolean {
  return (
    observed.probeId === required.probeId &&
    observed.label === required.label &&
    required.attributes.every((requiredAttribute) =>
      observed.attributes.some(
        (observedAttribute) =>
          observedAttribute.name === requiredAttribute.name &&
          observedAttribute.value === requiredAttribute.value,
      ),
    )
  );
}

function hasRequiredControlExactlyOnce(
  controls: CtripSurfaceReviewPageEvidence["controls"],
  required: CtripReviewedControl,
): boolean {
  const sameIdentity = controls.filter(
    (control) => control.probeId === required.probeId && control.label === required.label,
  );
  return (
    sameIdentity.length === 1 &&
    matchesRequiredControl(sameIdentity[0] as (typeof sameIdentity)[number], required)
  );
}

function pageMatchesReviewedSurface(
  page: CtripSurfaceReviewPageEvidence,
  surface: CtripReviewedSurface,
): boolean {
  return (
    page.origin === surface.origin &&
    page.path === surface.path &&
    page.observationStatus === "complete" &&
    page.sessionSignal === null &&
    page.challengeSignals.length === 0 &&
    surface.requiredControls.length > 0 &&
    surface.requiredControls.every((required) =>
      hasRequiredControlExactlyOnce(page.controls, required),
    )
  );
}

function pageMatchesAuthenticatedSurface(
  page: CtripSurfaceReviewPageEvidence,
  surface: CtripAuthenticatedSurface,
): boolean {
  return (
    page.origin === surface.origin &&
    page.path === surface.path &&
    page.observationStatus === "complete" &&
    page.sessionSignal === null &&
    page.challengeSignals.length === 0 &&
    surface.requiredControls.length > 0 &&
    surface.requiredControls.every((required) =>
      hasRequiredControlExactlyOnce(page.controls, required),
    )
  );
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

function authenticatedSessionSignal(
  location: CtripCanonicalPageLocation,
): CtripSurfaceReviewPageEvidence["authenticatedSessionSignal"] {
  return location.origin === CTRIP_AUTHENTICATED_ACCOUNT_ORIGIN &&
    (location.path === CTRIP_AUTHENTICATED_ACCOUNT_PATH_PREFIX ||
      location.path.startsWith(`${CTRIP_AUTHENTICATED_ACCOUNT_PATH_PREFIX}/`))
    ? "account_location"
    : null;
}

async function inspectPage(
  page: CtripSurfaceReviewPage,
  location: CtripCanonicalPageLocation,
): Promise<CtripSurfaceReviewPageEvidence> {
  const isDiscoverySurface = CTRIP_SURFACE_REVIEW_MANIFEST.discoverySurfaces.some(
    (surface) => surface.origin === location.origin && surface.path === location.path,
  );
  const isAuthenticatedSurface = CTRIP_SURFACE_REVIEW_MANIFEST.authenticatedSurfaces.some(
    (surface) => surface.origin === location.origin && surface.path === location.path,
  );
  try {
    const [rawControls, rawSignals] = await Promise.all([
      isDiscoverySurface || isAuthenticatedSurface
        ? page.readControls(
            CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes,
            CTRIP_SURFACE_REVIEW_MANIFEST.controlAttributeNames,
            MAX_CONTROLS_PER_PAGE,
          )
        : Promise.resolve([]),
      page.detectChallengeSignals(CTRIP_SURFACE_REVIEW_MANIFEST.challengeProbes),
    ]);
    const allowedControlIds = new Set(
      CTRIP_SURFACE_REVIEW_MANIFEST.controlProbes.map((probe) => probe.id),
    );
    const allowedAttributeNames = new Set(CTRIP_SURFACE_REVIEW_MANIFEST.controlAttributeNames);
    const controls: Array<CtripSurfaceReviewPageEvidence["controls"][number]> = [];
    for (const control of rawControls.slice(0, MAX_CONTROLS_PER_PAGE)) {
      if (!allowedControlIds.has(control.probeId)) continue;
      const label = sanitizeCtripReviewLabel(control.rawLabel);
      if (label === null) continue;
      const attributes = new Map<string, { readonly name: string; readonly value: string }>();
      for (const attribute of (control.rawAttributes ?? []).slice(0, MAX_ATTRIBUTES_PER_CONTROL)) {
        if (!allowedAttributeNames.has(attribute.name)) continue;
        const value = sanitizeCtripReviewLabel(attribute.rawValue);
        if (value === null) continue;
        attributes.set(`${attribute.name}\u0000${value}`, { name: attribute.name, value });
      }
      const canonicalAttributes = Object.freeze([...attributes.values()].sort(compareCanonical));
      const observedControl = Object.freeze({
        probeId: control.probeId,
        label,
        attributes: canonicalAttributes,
      });
      controls.push(observedControl);
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
      authenticatedSessionSignal: authenticatedSessionSignal(location),
      controls: Object.freeze(controls.sort(compareCanonical)),
      challengeSignals: Object.freeze(challengeSignals),
    });
  } catch {
    return Object.freeze({
      ...location,
      observationStatus: "unavailable" as const,
      sessionSignal: sessionSignal(location),
      authenticatedSessionSignal: authenticatedSessionSignal(location),
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
    .sort((left, right) => {
      const leftIsDiscoverySurface = CTRIP_SURFACE_REVIEW_MANIFEST.discoverySurfaces.some(
        (surface) => surface.origin === left.location.origin && surface.path === left.location.path,
      );
      const rightIsDiscoverySurface = CTRIP_SURFACE_REVIEW_MANIFEST.discoverySurfaces.some(
        (surface) =>
          surface.origin === right.location.origin && surface.path === right.location.path,
      );
      if (leftIsDiscoverySurface !== rightIsDiscoverySurface) {
        return leftIsDiscoverySurface ? -1 : 1;
      }
      return compareCanonical(left.location, right.location);
    })
    .slice(0, MAX_PAGES);
  const pages = Object.freeze(
    (await Promise.all(eligible.map(({ page, location }) => inspectPage(page, location)))).sort(
      compareCanonical,
    ),
  );
  const hasChallenge = pages.some((page) => page.challengeSignals.length > 0);
  const authenticated = pages.some(
    (page) =>
      page.observationStatus === "complete" &&
      page.sessionSignal === null &&
      (page.authenticatedSessionSignal !== null ||
        CTRIP_SURFACE_REVIEW_MANIFEST.authenticatedSurfaces.some((surface) =>
          pageMatchesAuthenticatedSurface(page, surface),
        )) &&
      page.challengeSignals.length === 0,
  );
  const onlySessionLocations = pages.every((page) => page.sessionSignal !== null);
  const hasReviewedSurface = pages.some((page) =>
    CTRIP_SURFACE_REVIEW_MANIFEST.reviewedSurfaces.some((surface) =>
      pageMatchesReviewedSurface(page, surface),
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
    schemaVersion: "geo.ctrip-surface-review.v2" as const,
    manifestVersion: CTRIP_SURFACE_REVIEW_MANIFEST.manifestVersion,
    outcome,
    authenticated,
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
      authenticatedSessionSignal: page.authenticatedSessionSignal,
      challengeSignals: page.challengeSignals,
    })),
  });
  return Object.freeze({
    ...material,
    sessionEvidenceHash,
    evidenceHash: sha256Canonical({ ...material, sessionEvidenceHash }),
  });
}

export function ctripOperationalReadiness(
  evidence: CtripSurfaceReviewEvidence,
): CtripOperationalReadiness {
  const publishSurfaceReady = evidence.pages.some((page) =>
    CTRIP_SURFACE_REVIEW_MANIFEST.reviewedSurfaces.some((surface) =>
      pageMatchesReviewedSurface(page, surface),
    ),
  );
  const status =
    evidence.outcome === "challenge_required"
      ? "challenge_required"
      : publishSurfaceReady
        ? "ready"
        : evidence.outcome === "session_required"
          ? "session_required"
          : "unavailable";
  return Object.freeze({
    schemaVersion: "geo.ctrip-operational-readiness.v1",
    status,
    observedAt: evidence.observedAt,
    manifestVersion: evidence.manifestVersion,
    sessionEvidenceHash: evidence.sessionEvidenceHash,
    evidenceHash: evidence.evidenceHash,
    authenticated: evidence.authenticated,
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

export function assertCtripBridgeModeReady(mode: CtripBridgeMode): void {
  if (mode === "browser_supervised") {
    assertCtripLiveCanaryReady();
  }
  if (mode === "browser_unattended") {
    assertCtripLiveCanaryReady();
    if (!CTRIP_SURFACE_REVIEW_MANIFEST.unattendedEnabled) {
      throw new Error("Ctrip unattended browser mode is not reviewed");
    }
  }
}
