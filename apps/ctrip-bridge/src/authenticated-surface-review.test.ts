import { describe, expect, it } from "vitest";

import {
  CTRIP_SURFACE_REVIEW_MANIFEST,
  assertCtripBridgeModeReady,
  assertCtripLiveCanaryReady,
  canonicalCtripPageLocation,
  ctripOperationalReadiness,
  reviewCtripAuthenticatedSurface,
  sanitizeCtripReviewLabel,
  type CtripSurfaceReviewPage,
} from "./authenticated-surface-review.js";

const now = "2026-07-16T12:00:00.000Z";

const reviewedControls = Object.freeze([
  {
    probeId: "title_editor",
    rawLabel: "title_editor",
    rawAttributes: [
      { name: "contenteditable", rawValue: "true" },
      { name: "role", rawValue: "textbox" },
    ],
  },
  {
    probeId: "body_editor",
    rawLabel: "body_editor",
    rawAttributes: [
      { name: "contenteditable", rawValue: "true" },
      { name: "role", rawValue: "combobox" },
    ],
  },
  {
    probeId: "image_input",
    rawLabel: "image_input",
    rawAttributes: [
      { name: "accept", rawValue: "image/*" },
      { name: "type", rawValue: "file" },
    ],
  },
  {
    probeId: "action",
    rawLabel: "上传图片",
    rawAttributes: [{ name: "role", rawValue: "button" }],
  },
  {
    probeId: "action",
    rawLabel: "存草稿",
    rawAttributes: [{ name: "type", rawValue: "button" }],
  },
  {
    probeId: "action",
    rawLabel: "发 布",
    rawAttributes: [{ name: "type", rawValue: "button" }],
  },
]);

const authenticatedHomeControls = Object.freeze([
  {
    probeId: "account_entry",
    rawLabel: "account_entry",
  },
  {
    probeId: "account_destination",
    rawLabel: "account_destination",
  },
  {
    probeId: "order_entry",
    rawLabel: "我的订单",
  },
]);

function reviewPage(options: {
  readonly url: string;
  readonly title?: string;
  readonly controls?: readonly {
    readonly probeId: string;
    readonly rawLabel: string;
    readonly rawAttributes?: readonly { readonly name: string; readonly rawValue: string }[];
  }[];
  readonly challengeSignals?: readonly string[];
  readonly unavailable?: boolean;
}): CtripSurfaceReviewPage {
  return {
    currentUrl: () => options.url,
    readControls: async () => {
      if (options.unavailable === true) throw new Error("page closed");
      return options.controls ?? [];
    },
    detectChallengeSignals: async () => options.challengeSignals ?? [],
  };
}

describe("Ctrip authenticated surface review", () => {
  it("allows only credential-free HTTPS Ctrip locations and drops query secrets", () => {
    expect(
      canonicalCtripPageLocation(
        "https://you.ctrip.com/community/write?access_token=secret#account",
      ),
    ).toEqual({ origin: "https://you.ctrip.com", path: "/community/write" });
    expect(canonicalCtripPageLocation("https://ctrip.com/")).toEqual({
      origin: "https://ctrip.com",
      path: "/",
    });
    expect(canonicalCtripPageLocation("http://you.ctrip.com/write")).toBeNull();
    expect(canonicalCtripPageLocation("https://ctrip.com.evil.example/write")).toBeNull();
    expect(canonicalCtripPageLocation("https://user:secret@you.ctrip.com/write")).toBeNull();
  });

  it("redacts sensitive label material and applies a hard length bound", () => {
    const sanitized = sanitizeCtripReviewLabel(
      " Publish 13800138000 person@example.com https://example.test/private " + "x".repeat(120),
    );

    expect(sanitized).toContain("[phone]");
    expect(sanitized).toContain("[email]");
    expect(sanitized).toContain("[url]");
    expect(sanitized).not.toContain("13800138000");
    expect(sanitized).not.toContain("person@example.com");
    expect(sanitized?.length).toBeLessThanOrEqual(80);
  });

  it("emits stable bounded drift evidence without page-controlled probe identities", async () => {
    const pages = [
      reviewPage({ url: "https://evil.example/?token=secret" }),
      reviewPage({
        url: "https://you.ctrip.com/",
        controls: [{ probeId: "action", rawLabel: "My account: private name" }],
      }),
      reviewPage({
        url: "https://we.ctrip.com/publish/publishPictureText?token=secret#private",
        title: "Draft for person@example.com",
        controls: [
          {
            probeId: "action",
            rawLabel: " Publish 13800138000 ",
            rawAttributes: [
              { name: "title", rawValue: " Publish 13800138000 " },
              { name: "data-testid", rawValue: "publish-button" },
              { name: "onclick", rawValue: "stealPrivateArticle()" },
              { name: "title", rawValue: " Publish 13800138000 " },
            ],
          },
          { probeId: "unknown_page_probe", rawLabel: "must not survive" },
          { probeId: "action", rawLabel: "Publish 13800138000" },
        ],
        challengeSignals: ["unknown_page_signal"],
      }),
    ];

    const first = await reviewCtripAuthenticatedSurface(pages, { now: () => new Date(now) });
    const second = await reviewCtripAuthenticatedSurface([...pages].reverse(), {
      now: () => new Date(now),
    });

    expect(first).toMatchObject({
      schemaVersion: "geo.ctrip-surface-review.v2",
      manifestVersion: CTRIP_SURFACE_REVIEW_MANIFEST.manifestVersion,
      outcome: "adapter_drift",
      observedAt: now,
      evidenceKind: "browser",
      pages: [
        {
          origin: "https://we.ctrip.com",
          path: "/publish/publishPictureText",
          observationStatus: "complete",
          sessionSignal: null,
          controls: [
            { probeId: "action", label: "Publish [phone]", attributes: [] },
            {
              probeId: "action",
              label: "Publish [phone]",
              attributes: [
                { name: "data-testid", value: "publish-button" },
                { name: "title", value: "Publish [phone]" },
              ],
            },
          ],
          challengeSignals: [],
        },
        {
          origin: "https://you.ctrip.com",
          path: "/",
          controls: [],
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain("secret");
    expect(JSON.stringify(first)).not.toContain("person@example.com");
    expect(JSON.stringify(first)).not.toContain("must not survive");
    expect(JSON.stringify(first)).not.toContain("private name");
    expect(JSON.stringify(first)).not.toContain("stealPrivateArticle");
    expect(second.evidenceHash).toBe(first.evidenceHash);
    expect(second.sessionEvidenceHash).toBe(first.sessionEvidenceHash);
  });

  it("classifies missing sessions, challenges and unavailable observations", async () => {
    await expect(
      reviewCtripAuthenticatedSurface([reviewPage({ url: "https://example.com" })], {
        now: () => new Date(now),
      }),
    ).resolves.toMatchObject({ outcome: "session_required", pages: [] });

    await expect(
      reviewCtripAuthenticatedSurface([reviewPage({ url: "https://accounts.ctrip.com/login" })], {
        now: () => new Date(now),
      }),
    ).resolves.toMatchObject({
      outcome: "session_required",
      pages: [{ sessionSignal: "login_location" }],
    });

    await expect(
      reviewCtripAuthenticatedSurface(
        [
          reviewPage({
            url: "https://we.ctrip.com/account/fastLogin?isredirect=true",
          }),
        ],
        { now: () => new Date(now) },
      ),
    ).resolves.toMatchObject({
      outcome: "session_required",
      pages: [{ sessionSignal: "login_location" }],
    });

    await expect(
      reviewCtripAuthenticatedSurface(
        [
          reviewPage({
            url: "https://accounts.ctrip.com/login",
            challengeSignals: ["captcha_frame"],
          }),
        ],
        { now: () => new Date(now) },
      ),
    ).resolves.toMatchObject({ outcome: "challenge_required" });

    await expect(
      reviewCtripAuthenticatedSurface(
        [
          reviewPage({
            url: "https://we.ctrip.com/publish/publishPictureText",
            unavailable: true,
          }),
        ],
        { now: () => new Date(now) },
      ),
    ).resolves.toMatchObject({
      outcome: "adapter_drift",
      pages: [{ observationStatus: "unavailable" }],
    });
  });

  it("opens supervised and unattended publication for the compiled editor contract", () => {
    expect(CTRIP_SURFACE_REVIEW_MANIFEST.liveCanaryEnabled).toBe(true);
    expect(CTRIP_SURFACE_REVIEW_MANIFEST.unattendedEnabled).toBe(true);
    expect(CTRIP_SURFACE_REVIEW_MANIFEST.discoverySurfaces).toEqual([
      { origin: "https://we.ctrip.com", path: "/publish/publishPictureText" },
    ]);
    expect(CTRIP_SURFACE_REVIEW_MANIFEST.reviewedSurfaces).toHaveLength(1);
    expect(CTRIP_SURFACE_REVIEW_MANIFEST.reviewedSurfaces[0]?.requiredControls).toHaveLength(6);
    expect(() => assertCtripLiveCanaryReady()).not.toThrow();
  });

  it("allows supervised and unattended startup after the reviewed rollout decision", () => {
    expect(() => assertCtripBridgeModeReady("browser_supervised")).not.toThrow();
    expect(() => assertCtripBridgeModeReady("browser_unattended")).not.toThrow();

    expect(() => assertCtripBridgeModeReady("simulator")).not.toThrow();
    expect(() => assertCtripBridgeModeReady("browser_preflight")).not.toThrow();
    expect(() => assertCtripBridgeModeReady("browser_draft")).not.toThrow();
  });

  it("requires the complete reviewed control contract for operational readiness", async () => {
    const readyEvidence = await reviewCtripAuthenticatedSurface(
      [
        reviewPage({
          url: "https://we.ctrip.com/publish/publishPictureText",
          controls: reviewedControls,
        }),
      ],
      { now: () => new Date(now) },
    );
    expect(readyEvidence.outcome).toBe("reviewed_surface");
    expect(ctripOperationalReadiness(readyEvidence)).toMatchObject({
      schemaVersion: "geo.ctrip-operational-readiness.v1",
      status: "ready",
      observedAt: now,
    });

    const incompleteEvidence = await reviewCtripAuthenticatedSurface(
      [reviewPage({ url: "https://we.ctrip.com/publish/publishPictureText" })],
      { now: () => new Date(now) },
    );
    expect(incompleteEvidence.outcome).toBe("adapter_drift");
    expect(ctripOperationalReadiness(incompleteEvidence).status).toBe("unavailable");

    const loginEvidence = await reviewCtripAuthenticatedSurface(
      [reviewPage({ url: "https://accounts.ctrip.com/login" })],
      { now: () => new Date(now) },
    );
    expect(ctripOperationalReadiness(loginEvidence).status).toBe("session_required");

    const challengeEvidence = await reviewCtripAuthenticatedSurface(
      [
        reviewPage({
          url: "https://we.ctrip.com/publish/publishPictureText",
          challengeSignals: ["captcha_frame"],
        }),
      ],
      { now: () => new Date(now) },
    );
    expect(ctripOperationalReadiness(challengeEvidence).status).toBe("challenge_required");
  });

  it("keeps the reviewed editor surface inside the bounded page sample", async () => {
    const unrelatedPages = Array.from({ length: 10 }, (_, index) =>
      reviewPage({ url: `https://m.ctrip.com/webapp/you/community/detail/${index}` }),
    );
    const evidence = await reviewCtripAuthenticatedSurface(
      [
        ...unrelatedPages,
        reviewPage({
          url: "https://we.ctrip.com/publish/publishPictureText",
          controls: reviewedControls,
        }),
      ],
      { now: () => new Date(now) },
    );

    expect(evidence.pages).toHaveLength(10);
    expect(evidence.outcome).toBe("reviewed_surface");
    expect(ctripOperationalReadiness(evidence).status).toBe("ready");
  });

  it("recognizes the authenticated Ctrip account home without treating it as publish readiness", async () => {
    const evidence = await reviewCtripAuthenticatedSurface(
      [reviewPage({ url: "https://my.ctrip.com/myinfo/home" })],
      { now: () => new Date(now) },
    );

    expect(evidence.outcome).toBe("adapter_drift");
    expect(ctripOperationalReadiness(evidence)).toMatchObject({
      status: "unavailable",
      authenticated: true,
    });
  });

  it("recognizes the authenticated Ctrip public home only with the complete account control pair", async () => {
    const evidence = await reviewCtripAuthenticatedSurface(
      [
        reviewPage({
          url: "https://www.ctrip.com/",
          controls: authenticatedHomeControls,
        }),
      ],
      { now: () => new Date(now) },
    );

    expect(evidence.outcome).toBe("adapter_drift");
    expect(ctripOperationalReadiness(evidence)).toMatchObject({
      status: "unavailable",
      authenticated: true,
    });
  });

  it.each([
    {
      label: "content management",
      url: "https://we.ctrip.com/publish/contentManagement",
      controls: [
        {
          probeId: "content_management_entry",
          rawLabel: "内容管理",
          rawAttributes: [{ name: "href", rawValue: "/publish/contentManagement" }],
        },
        {
          probeId: "content_management_search",
          rawLabel: "请输入关键字",
          rawAttributes: [{ name: "placeholder", rawValue: "请输入关键字" }],
        },
      ],
    },
    {
      label: "content analytics",
      url: "https://we.ctrip.com/analyse/contentAnalysis",
      controls: [
        {
          probeId: "analytics_tab",
          rawLabel: "内容概况",
          rawAttributes: [{ name: "role", rawValue: "tab" }],
        },
        {
          probeId: "analytics_tab",
          rawLabel: "单条分析",
          rawAttributes: [{ name: "role", rawValue: "tab" }],
        },
      ],
    },
  ])("recognizes the authenticated Ctrip $label workspace", async ({ url, controls }) => {
    const evidence = await reviewCtripAuthenticatedSurface([reviewPage({ url, controls })], {
      now: () => new Date(now),
    });

    expect(evidence.authenticated).toBe(true);
    expect(ctripOperationalReadiness(evidence)).toMatchObject({
      status: "unavailable",
      authenticated: true,
    });
  });

  it.each(authenticatedHomeControls.map((control, index) => [control.rawLabel, index] as const))(
    "keeps the Ctrip public home unauthenticated when home control %s is missing",
    async (_label, missingIndex) => {
      const evidence = await reviewCtripAuthenticatedSurface(
        [
          reviewPage({
            url: "https://www.ctrip.com/",
            controls: authenticatedHomeControls.filter((_, index) => index !== missingIndex),
          }),
        ],
        { now: () => new Date(now) },
      );

      expect(evidence.authenticated).toBe(false);
      expect(ctripOperationalReadiness(evidence).status).toBe("unavailable");
    },
  );

  it.each(reviewedControls.map((control, index) => [control.rawLabel, index] as const))(
    "fails closed when required control %s is missing",
    async (_label, missingIndex) => {
      const controls = reviewedControls.filter((_, index) => index !== missingIndex);
      const evidence = await reviewCtripAuthenticatedSurface(
        [
          reviewPage({
            url: "https://we.ctrip.com/publish/publishPictureText",
            controls,
          }),
        ],
        { now: () => new Date(now) },
      );

      expect(evidence.outcome).toBe("adapter_drift");
      expect(ctripOperationalReadiness(evidence).status).toBe("unavailable");
    },
  );

  it.each(reviewedControls.map((control, index) => [control.rawLabel, index] as const))(
    "fails closed when required control %s is duplicated",
    async (_label, duplicateIndex) => {
      const duplicate = reviewedControls[duplicateIndex];
      const evidence = await reviewCtripAuthenticatedSurface(
        [
          reviewPage({
            url: "https://we.ctrip.com/publish/publishPictureText",
            controls: duplicate === undefined ? reviewedControls : [...reviewedControls, duplicate],
          }),
        ],
        { now: () => new Date(now) },
      );

      expect(evidence.outcome).toBe("adapter_drift");
      expect(ctripOperationalReadiness(evidence).status).toBe("unavailable");
    },
  );

  it("fails closed when a required control attribute drifts", async () => {
    const controls = reviewedControls.map((control) =>
      control.rawLabel === "title_editor"
        ? {
            ...control,
            rawAttributes: [
              { name: "contenteditable", rawValue: "true" },
              { name: "role", rawValue: "combobox" },
            ],
          }
        : control,
    );
    const evidence = await reviewCtripAuthenticatedSurface(
      [
        reviewPage({
          url: "https://we.ctrip.com/publish/publishPictureText",
          controls,
        }),
      ],
      { now: () => new Date(now) },
    );

    expect(evidence.outcome).toBe("adapter_drift");
    expect(ctripOperationalReadiness(evidence).status).toBe("unavailable");
  });
});
