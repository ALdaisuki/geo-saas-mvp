import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { ARTICLE_TEMPLATE_CATALOG_VERSION, ARTICLE_TEMPLATES } from "@geo/contracts";

const routes = [
  { href: "/overview", label: "运营概览", heading: "运营概览", slug: "overview" },
  { href: "/customers", label: "客户与品牌", heading: "客户与品牌", slug: "customers" },
  { href: "/content", label: "内容资产", heading: "内容资产", slug: "content" },
  { href: "/publishing", label: "投放中心", heading: "投放中心", slug: "publishing" },
  { href: "/automation", label: "自动化批次", heading: "自动化批次", slug: "automation" },
  { href: "/visibility", label: "AI 可见性", heading: "AI 可见性", slug: "visibility" },
  { href: "/audit", label: "审计与证据", heading: "审计与证据", slug: "audit" },
  { href: "/settings", label: "系统设置", heading: "系统设置", slug: "settings" },
] as const;

async function assertNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

async function openRoute(page: Page, label: string, mobile: boolean): Promise<void> {
  if (mobile) {
    await page.getByRole("button", { name: "打开导航" }).click();
  }
  await page.getByRole("link", { name: label, exact: true }).click();
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  slug: string,
  fullPage = true,
): Promise<void> {
  await testInfo.attach(`${testInfo.project.name}-${slug}`, {
    body: await page.screenshot({ fullPage }),
    contentType: "image/png",
  });
}

async function assertNoDirectChildOverlap(page: Page, selectors: readonly string[]): Promise<void> {
  const overlaps = await page.evaluate((candidateSelectors) => {
    const findings: string[] = [];
    for (const selector of candidateSelectors) {
      for (const [groupIndex, group] of [
        ...document.querySelectorAll<HTMLElement>(selector),
      ].entries()) {
        const children = [...group.children].filter((child): child is HTMLElement => {
          if (!(child instanceof HTMLElement)) return false;
          const style = getComputedStyle(child);
          const rect = child.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0
          );
        });
        for (let leftIndex = 0; leftIndex < children.length; leftIndex += 1) {
          const left = children[leftIndex]?.getBoundingClientRect();
          if (left === undefined) continue;
          for (let rightIndex = leftIndex + 1; rightIndex < children.length; rightIndex += 1) {
            const right = children[rightIndex]?.getBoundingClientRect();
            if (right === undefined) continue;
            const overlapWidth =
              Math.min(left.right, right.right) - Math.max(left.left, right.left);
            const overlapHeight =
              Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
            if (overlapWidth > 1 && overlapHeight > 1) {
              findings.push(`${selector}[${groupIndex}] children ${leftIndex}/${rightIndex}`);
            }
          }
        }
      }
    }
    return findings;
  }, selectors);
  expect(overlaps).toEqual([]);
}

async function installAutomationApiFixture(page: Page): Promise<{
  readonly agentRunRequests: Array<{
    readonly authorization: string | undefined;
    readonly csrf: string | undefined;
    readonly body: Readonly<Record<string, unknown>>;
  }>;
  readonly ctripCommandRequests: Array<{
    readonly command: "prepare" | "submit" | "readback";
    readonly csrf: string | undefined;
    readonly body: Readonly<Record<string, unknown>>;
  }>;
}> {
  await page
    .context()
    .addCookies([{ name: "geo_csrf", value: "web-e2e-csrf", domain: "127.0.0.1", path: "/" }]);
  const tenantId = "10000000-0000-4000-8000-000000000001";
  const actorId = "10000000-0000-4000-8000-000000000101";
  const brandId = "10000000-0000-4000-8000-000000000301";
  const campaignId = "10000000-0000-4000-8000-000000001001";
  const accountId = "10000000-0000-4000-8000-000000000701";
  const batchId = "10000000-0000-4000-8000-000000002001";
  const runId = "10000000-0000-4000-8000-000000003001";
  const querySetId = "10000000-0000-4000-8000-000000007001";
  const querySetVersionOneId = "10000000-0000-4000-8000-000000007002";
  const querySetVersionTwoId = "10000000-0000-4000-8000-000000007003";
  const now = "2026-07-15T08:00:00.000Z";
  const contentItemId = "10000000-0000-4000-8000-000000005101";
  const contentVersionId = "10000000-0000-4000-8000-000000005102";
  const variantId = "10000000-0000-4000-8000-000000005103";
  const ctripAccountId = "10000000-0000-4000-8000-000000000703";
  const ctripHandoffId = "10000000-0000-4000-8000-000000009001";
  const agentRunRequests: Array<{
    authorization: string | undefined;
    csrf: string | undefined;
    body: Readonly<Record<string, unknown>>;
  }> = [];
  const ctripCommandRequests: Array<{
    command: "prepare" | "submit" | "readback";
    csrf: string | undefined;
    body: Readonly<Record<string, unknown>>;
  }> = [];
  const generatedPayload = {
    title: "日本线路服务边界核验指南",
    summary: "仅使用当前已验证事实与联系方式。",
    bodyMarkdown: "## 当前可核验信息\n\n请以签约前提供的最终行程为准。",
    titleBlocks: [{ type: "template", templateId: "generic.title.verified-service" }],
    summaryBlocks: [{ type: "template", templateId: "generic.summary.verified-sources" }],
    bodyBlocks: [{ type: "template", templateId: "generic.body.guidance.verified" }],
    tagTemplateIds: ["generic.tag.verified"],
    media: [],
    claims: [],
    contactIds: [],
    tags: ["服务核验"],
  };
  const generatedContent = {
    id: contentItemId,
    campaignId,
    brandId,
    title: generatedPayload.title,
    contentType: "guide",
    state: "draft",
    topicKey: "agent:e2e",
    latestVersion: 1,
    latestVersionId: contentVersionId,
  };
  const session = {
    actor: {
      id: actorId,
      displayName: "自动化运营员",
      role: "owner",
      capabilities: [
        "tenant:read",
        "tenant:manage",
        "content:read",
        "content:write",
        "automation:manage",
        "publish:request",
        "publish:cancel",
        "receipt:read",
        "visibility:read",
        "visibility:run",
      ],
    },
    tenant: {
      id: tenantId,
      slug: "zhongtong-international-travel",
      displayName: "中通国际旅行社",
    },
    expiresAt: "2026-07-16T08:00:00.000Z",
  };
  const campaigns = [
    {
      id: campaignId,
      brandId,
      name: "日本线路问答",
      objective: "生成并审计暑期旅行服务问答",
      industry: "travel",
      status: "active",
      topicKey: "japan-travel",
    },
    {
      id: "10000000-0000-4000-8000-000000001002",
      brandId,
      name: "东南亚亲子线路",
      objective: "准备下一批已核验主题",
      industry: "travel",
      status: "draft",
      topicKey: "sea-family",
    },
  ];
  const accounts = [
    {
      id: accountId,
      platform: "toutiao",
      displayName: "中通头条号",
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      evidenceType: "manual_import",
      evidenceRefs: ["operator-verification"],
      status: "active",
      lastVerifiedAt: now,
    },
    {
      id: "10000000-0000-4000-8000-000000000702",
      platform: "sohu",
      displayName: "中通搜狐号",
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      evidenceType: "manual_import",
      evidenceRefs: ["operator-verification"],
      status: "active",
      lastVerifiedAt: now,
    },
    {
      id: ctripAccountId,
      platform: "ctrip_community",
      displayName: "中通携程社区",
      capability: "manual_only",
      supportedExecutionLevels: ["dry_run"],
      evidenceType: "manual_import",
      evidenceRefs: ["operator-verification"],
      status: "active",
      lastVerifiedAt: now,
    },
  ];
  const policies = [
    {
      id: "10000000-0000-4000-8000-000000000501",
      version: "travel-policy-v1",
      status: "active",
      policyHash: "a".repeat(64),
      document: {
        schemaVersion: "geo.audit-policy.v2",
        rulesVersion: "travel-policy-v1",
        industry: "travel",
        audit: {
          artifactTtlMs: 3_600_000,
          maxEvidenceAgeMs: 30 * 86_400_000,
          minClaims: 2,
          duplicateThreshold: 0.88,
          minDuplicateCharacters: 160,
          prohibitedGuarantees: ["保证", "百分百"],
        },
      },
      effectiveAt: now,
      retiredAt: null,
      createdAt: now,
    },
  ];
  const batch = {
    id: batchId,
    campaignId,
    name: "暑期日本线路预演",
    state: "completed",
    executionLevel: "dry_run",
    scheduledFor: now,
    runCount: 1,
    completedRunCount: 1,
    failedRunCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const querySets = [
    {
      id: querySetId,
      name: "国内 AI 旅行决策问题集",
      industry: "travel",
      status: "active",
      currentVersion: 2,
      description: "分别记录豆包与千问的旅行服务发现、核验和比较问题",
      currentVersionId: querySetVersionTwoId,
      prompts: [
        {
          key: "service-boundary",
          category: "verification",
          prompt: "如何核验出境游服务边界？",
        },
      ],
      promptHash: "b".repeat(64),
      createdAt: now,
      updatedAt: now,
    },
  ];
  const querySetVersions = [
    {
      id: querySetVersionTwoId,
      querySetId,
      version: 2,
      prompts: [
        {
          key: "service-boundary",
          category: "verification",
          prompt: "如何核验出境游服务边界？",
        },
        {
          key: "contact-check",
          category: "verification",
          prompt: "中通国际旅行社的官方咨询方式是什么？",
        },
      ],
      promptHash: "b".repeat(64),
      createdByActorId: actorId,
      createdAt: now,
    },
    {
      id: querySetVersionOneId,
      querySetId,
      version: 1,
      prompts: [
        {
          key: "service-discovery",
          category: "discovery",
          prompt: "有哪些适合首次出境游客的服务？",
        },
      ],
      promptHash: "a".repeat(64),
      createdByActorId: actorId,
      createdAt: "2026-07-14T08:00:00.000Z",
    },
  ];
  const run = {
    id: runId,
    batchId,
    campaignId,
    brandId,
    slotKey: "slot-001",
    topicKey: "japan-travel",
    brief: "面向亲子家庭说明日本暑期线路的已核验服务范围",
    state: "completed",
    stage: "delivery",
    availableAt: now,
    attemptCount: 1,
    maxAttempts: 5,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: now,
    checkpoint: {},
    contentItemId: "10000000-0000-4000-8000-000000005001",
    contentVersionId: "10000000-0000-4000-8000-000000005002",
    lastErrorCode: null,
    lastErrorMessage: null,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
    targets: [
      {
        id: "10000000-0000-4000-8000-000000004001",
        runId,
        channelAccountId: accountId,
        platform: "toutiao",
        state: "preview_completed",
        variantId: "10000000-0000-4000-8000-000000006001",
        auditRunId: "10000000-0000-4000-8000-000000006002",
        auditArtifactId: "10000000-0000-4000-8000-000000006003",
        publicationJobId: "10000000-0000-4000-8000-000000006004",
        lastErrorCode: null,
        lastErrorMessage: null,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  let ctripHandoff = {
    id: ctripHandoffId,
    jobId: "10000000-0000-4000-8000-000000009002",
    attemptId: "10000000-0000-4000-8000-000000009003",
    channelAccountId: ctripAccountId,
    variantId,
    platform: "ctrip_community",
    state: "handoff_pending",
    payloadHash: "3".repeat(64),
    auditHash: "4".repeat(64),
    previewHash: "5".repeat(64),
    adapterVersion: "ctrip-community-simulator-v1",
    bridgeServicePrincipalId: "10000000-0000-4000-8000-000000009004",
    leaseOwnerActorId: null as string | null,
    leaseExpiresAt: null as string | null,
    heartbeatAt: null as string | null,
    sessionEvidenceHash: null as string | null,
    draftEvidenceHash: null as string | null,
    submitEvidenceHash: null as string | null,
    submitPermitIssued: false,
    submitPermitExpiresAt: null as string | null,
    submitPermitConsumedAt: null as string | null,
    submitPermitIssuedByActorId: null as string | null,
    submitPermitConsumedByPrincipalId: null as string | null,
    submitOutcome: null as "accepted" | "uncertain" | "rejected" | null,
    submitEvidenceKind: null as "simulation" | "browser" | null,
    submitObservedAt: null as string | null,
    publicationReceiptId: null as string | null,
    publicationReadbackId: null as string | null,
    readbackOutcome: null as
      "confirmed" | "not_found" | "mismatch" | "unavailable" | "simulation_only" | null,
    readbackEvidenceKind: null as "simulation" | "browser" | "platform_readback" | null,
    readbackEvidenceHash: null as string | null,
    readbackObservedAt: null as string | null,
    observedPayloadHash: null as string | null,
    externalDraftId: null as string | null,
    externalId: null as string | null,
    externalUrl: null as string | null,
    expiresAt: "2099-07-15T09:00:00.000Z",
    cancellationReason: null as string | null,
    lastErrorCode: null as string | null,
    lastErrorMessage: null as string | null,
    createdAt: now,
    updatedAt: now,
  };

  const items = (values: readonly unknown[]) => ({ items: values });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/agent/runs" && route.request().method() === "POST") {
      agentRunRequests.push({
        authorization: route.request().headers()["authorization"],
        csrf: route.request().headers()["x-csrf-token"],
        body: route.request().postDataJSON() as Readonly<Record<string, unknown>>,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          capability: {
            mode: "fixture",
            provider: "fixture",
            model: "fixture-geo-writer-v1",
          },
          result: {
            providerMode: "fixture",
            contentItemId,
            contentVersionId,
            variantId,
            auditRunId: "10000000-0000-4000-8000-000000005104",
            auditArtifactId: "10000000-0000-4000-8000-000000005105",
            publicationRequestId: "10000000-0000-4000-8000-000000005106",
            publicationJobId: "10000000-0000-4000-8000-000000005107",
            outboxEventId: "10000000-0000-4000-8000-000000005108",
            steps: [
              "plastic_context_supply",
              "geo_tenant_context",
              "geo_template_catalog",
              "geo_brand_profile",
              "geo_fact_lookup",
              "geo_draft_proposal",
              "geo_variant_preview",
              "geo_audit_request",
              "geo_publication_request",
            ],
          },
        }),
      });
      return;
    }
    const ctripCommand = url.pathname.match(
      new RegExp(
        `^/api/publication-assisted-handoffs/${ctripHandoffId}/(claim|prepare|submit|readback)$`,
      ),
    )?.[1];
    if (ctripCommand !== undefined && route.request().method() === "POST") {
      if (ctripCommand === "claim") {
        ctripHandoff = {
          ...ctripHandoff,
          leaseOwnerActorId: actorId,
          leaseExpiresAt: "2099-07-15T08:10:00.000Z",
          heartbeatAt: now,
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ handoff: ctripHandoff }),
        });
        return;
      }
      const command = ctripCommand as "prepare" | "submit" | "readback";
      ctripCommandRequests.push({
        command,
        csrf: route.request().headers()["x-csrf-token"],
        body: route.request().postDataJSON() as Readonly<Record<string, unknown>>,
      });
      const bridgeBase = {
        schemaVersion: "geo.ctrip-bridge.result.v1",
        tenantId,
        handoffId: ctripHandoffId,
        bridgePrincipalId: ctripHandoff.bridgeServicePrincipalId,
        adapterVersion: ctripHandoff.adapterVersion,
        observedAt: now,
        evidenceHash: "6".repeat(64),
        evidenceKind: "simulation",
      };
      if (command === "prepare") {
        ctripHandoff = {
          ...ctripHandoff,
          state: "draft_prepared",
          draftEvidenceHash: "6".repeat(64),
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            handoff: ctripHandoff,
            bridge: {
              ...bridgeBase,
              command,
              outcome: "prepared",
              state: "draft_prepared",
            },
          }),
        });
        return;
      }
      if (command === "submit") {
        ctripHandoff = {
          ...ctripHandoff,
          state: "readback_pending",
          submitPermitIssued: true,
          submitPermitConsumedAt: now,
          submitOutcome: "accepted",
          submitEvidenceKind: "simulation",
          submitObservedAt: now,
          publicationReceiptId: "10000000-0000-4000-8000-000000009005",
          publicationReadbackId: "10000000-0000-4000-8000-000000009006",
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            handoff: ctripHandoff,
            bridge: {
              ...bridgeBase,
              command,
              outcome: "accepted",
              state: "readback_pending",
              receiptId: ctripHandoff.publicationReceiptId,
              readbackId: ctripHandoff.publicationReadbackId,
            },
          }),
        });
        return;
      }
      ctripHandoff = {
        ...ctripHandoff,
        state: "needs_review",
        readbackOutcome: "simulation_only",
        readbackEvidenceKind: "simulation",
        readbackEvidenceHash: "7".repeat(64),
        readbackObservedAt: now,
        observedPayloadHash: ctripHandoff.payloadHash,
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          handoff: ctripHandoff,
          bridge: {
            ...bridgeBase,
            command,
            outcome: "simulation_only",
            state: "needs_review",
            externalId: null,
            externalUrl: null,
          },
        }),
      });
      return;
    }
    const responses = new Map<string, unknown>([
      ["/api/auth/session", session],
      [
        "/api/tenant",
        {
          id: tenantId,
          slug: session.tenant.slug,
          displayName: session.tenant.displayName,
          legalName: session.tenant.displayName,
          industry: "travel",
          status: "active",
          defaultLocale: "zh-CN",
        },
      ],
      [
        "/api/auth/tenants",
        items([
          {
            id: tenantId,
            slug: session.tenant.slug,
            displayName: session.tenant.displayName,
            role: "owner",
            status: "active",
          },
        ]),
      ],
      [
        "/api/contacts",
        items([
          {
            id: "10000000-0000-4000-8000-000000000401",
            tenantId,
            type: "phone",
            label: "24小时热线",
            value: "4001133986",
            isPrimary: true,
            validFrom: now,
            validUntil: null,
          },
        ]),
      ],
      ["/api/channel-accounts", items(accounts)],
      [
        "/api/agent/capability",
        {
          available: true,
          mode: "fixture",
          provider: "fixture",
          model: "fixture-geo-writer-v1",
        },
      ],
      [
        "/api/brands",
        items([
          {
            id: brandId,
            canonicalName: "zhongtong-international-travel",
            displayName: "中通国际旅行社",
            aliases: [],
            description: null,
            industry: "travel",
            websiteUrl: null,
            isPrimary: true,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      ],
      ["/api/brand-agent-profiles", items([])],
      ["/api/service-principals", items([])],
      ["/api/members", items([])],
      ["/api/policies", items(policies)],
      ["/api/query-sets", items(querySets)],
      [`/api/query-sets/${querySetId}/versions`, items(querySetVersions)],
      ["/api/evidence-sources", items([])],
      [
        "/api/article-templates",
        { version: ARTICLE_TEMPLATE_CATALOG_VERSION, items: ARTICLE_TEMPLATES },
      ],
      ["/api/facts", items([])],
      ["/api/campaigns", items(campaigns)],
      ["/api/content", items(agentRunRequests.length === 0 ? [] : [generatedContent])],
      [
        `/api/content-versions/${contentVersionId}`,
        {
          id: contentVersionId,
          contentItemId,
          version: 1,
          summary: generatedPayload.summary,
          bodyMarkdown: generatedPayload.bodyMarkdown,
          payload: generatedPayload,
          payloadHash: "c".repeat(64),
          frozenAt: null,
        },
      ],
      [
        `/api/content/${contentItemId}/variants`,
        items([
          {
            id: variantId,
            contentVersionId,
            channelAccountId: accountId,
            platform: "toutiao",
            variantVersion: 1,
            payload: generatedPayload,
            payloadHash: "d".repeat(64),
            state: "frozen",
            frozenAt: now,
          },
        ]),
      ],
      ["/api/audits", items([])],
      ["/api/publication-jobs", items([])],
      ["/api/publication-assisted-handoffs", items([ctripHandoff])],
      ["/api/receipts", items([])],
      ["/api/visibility/summary", items([])],
      [
        "/api/automation",
        {
          control: {
            mode: "unattended",
            killSwitchEnabled: false,
            reason: "Dry-run unattended operations approved",
            quota: {
              maxConcurrent: 2,
              perMinute: 30,
              perDay: 300,
              cooldownSeconds: 5,
              errorBudget: 10,
            },
            updatedAt: now,
          },
          controls: [
            {
              id: "10000000-0000-4000-8000-000000008001",
              scopeType: "platform",
              scopeKey: "toutiao",
              mode: "supervised",
              killSwitchEnabled: false,
              reason: "Toutiao canary quota",
              quota: {
                maxConcurrent: 1,
                perMinute: 10,
                perDay: 100,
                cooldownSeconds: 10,
                errorBudget: 5,
              },
              updatedAt: now,
            },
          ],
          circuits: [
            {
              id: "10000000-0000-4000-8000-000000008002",
              scopeType: "platform",
              scopeKey: "sohu",
              state: "closed",
              failureCount: 0,
              openedAt: null,
              retryAt: null,
              reason: "Manual recovery completed",
              updatedAt: now,
            },
          ],
        },
      ],
      ["/api/automation-batches", items([batch])],
      ["/api/automation-runs", items([run])],
      [`/api/automation-runs/${runId}`, run],
    ]);
    const response = responses.get(url.pathname);
    if (response === undefined) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "TEST_ROUTE_MISSING", message: url.pathname } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  return { agentRunRequests, ctripCommandRequests };
}

test("demo console keeps every primary workflow truthful and responsive", async ({
  page,
}, testInfo) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const source = message.location().url;
      consoleErrors.push(source === "" ? message.text() : `${message.text()} @ ${source}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "登录运营台" })).toBeVisible();
  await expect(page.getByText("离线演示", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "进入演示模式" }).click();

  const mobile = testInfo.project.name.startsWith("mobile-");
  for (const [index, route] of routes.entries()) {
    if (index > 0) await openRoute(page, route.label, mobile);
    await expect(page).toHaveURL(route.href);
    await expect(page.getByRole("heading", { name: route.heading, exact: true })).toBeVisible();
    await assertNoPageOverflow(page);
    await attachScreenshot(page, testInfo, route.slug);
  }

  await openRoute(page, "投放中心", mobile);
  const platformHealth = page.locator(".platform-health-band");
  await expect(platformHealth.getByText("头条号", { exact: true })).toBeVisible();
  await expect(platformHealth.getByText("Manual only · Dry-run", { exact: true })).toHaveCount(3);
  await openRoute(page, "自动化批次", mobile);
  await expect(page.getByText("离线演示不创建自动化批次", { exact: true })).toBeVisible();
  await openRoute(page, "AI 可见性", mobile);
  await expect(page.getByText("演示证据：Fixture")).toBeVisible();
  await expect(page.getByText(/不与 Google 排名合并/)).toBeVisible();

  const denseTable = page.locator(".visibility-query-table");
  const tableDimensions = await denseTable.evaluate((table) => ({
    clientWidth: table.clientWidth,
    scrollWidth: table.scrollWidth,
  }));
  if (mobile) {
    expect(tableDimensions.scrollWidth).toBeGreaterThan(390);
    const intentCell = denseTable.locator("tbody tr:first-child td:nth-child(2)");
    await expect(intentCell).toHaveCSS("white-space", "nowrap");
  } else {
    expect(tableDimensions.scrollWidth).toBeLessThanOrEqual(tableDimensions.clientWidth + 1);
  }

  const expectedOfflineSessionErrors = consoleErrors.filter(
    (message) => message.includes("502 (Bad Gateway)") && message.endsWith("/api/auth/session"),
  );
  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) => !expectedOfflineSessionErrors.includes(message),
  );
  expect(expectedOfflineSessionErrors.length).toBeGreaterThan(0);
  expect(unexpectedConsoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("live automation operations remain bounded and non-overlapping", async ({
  page,
}, testInfo) => {
  await installAutomationApiFixture(page);
  await page.goto("/automation");

  await expect(page.getByRole("heading", { level: 1, name: "自动化批次" })).toBeVisible();
  await expect(
    page.getByLabel("Campaign 状态列表").getByText("日本线路问答", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Dry-run 预演完成", { exact: true })).toBeVisible();
  await expect(page.getByText(/不执行外部发送/)).toBeVisible();
  await expect(page.getByText(/已真实发布/)).toHaveCount(0);
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [
    ".automation-campaign-row",
    ".automation-campaign-actions",
    ".automation-run-list > button",
    ".automation-target-list > div",
    ".automation-operations .ops-form-grid",
  ]);

  const mobile = testInfo.project.name.startsWith("mobile-");
  if (mobile) {
    await page.getByRole("button", { name: "打开导航" }).click();
    await expect(page.getByRole("link", { name: "自动化批次", exact: true })).toBeVisible();
    const sidebarRegions = await page.evaluate(() => {
      const navigation = document.querySelector<HTMLElement>(".main-nav")?.getBoundingClientRect();
      const footer = document
        .querySelector<HTMLElement>(".sidebar-footer")
        ?.getBoundingClientRect();
      return navigation === undefined || footer === undefined
        ? null
        : { navigationBottom: navigation.bottom, footerTop: footer.top };
    });
    expect(sidebarRegions).not.toBeNull();
    expect(sidebarRegions?.navigationBottom ?? 1).toBeLessThanOrEqual(
      (sidebarRegions?.footerTop ?? 0) + 1,
    );
    await page.getByRole("button", { name: "关闭导航", exact: true }).click();
  }

  await attachScreenshot(page, testInfo, "automation-live");
  await page.getByRole("button", { name: "完成 Campaign 日本线路问答" }).click();
  await expect(page.getByRole("dialog", { name: "确认完成 Campaign" })).toBeVisible();
  await expect(page.getByText(/完成是不可逆终态/)).toBeVisible();
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [".modal-header", ".modal-actions"]);
});

test("live Ctrip simulator flow requires approval and ends in review", async ({
  page,
}, testInfo) => {
  const fixture = await installAutomationApiFixture(page);
  await page.goto("/publishing");

  await expect(page.getByRole("heading", { level: 1, name: "投放中心" })).toBeVisible();
  await expect(page.getByText(/当前环境为 Simulator/)).toBeVisible();
  await page.getByRole("button", { name: /认领交接单/ }).click();
  await page.getByRole("button", { name: /准备携程草稿/ }).click();
  await expect(page.getByText("草稿已准备", { exact: true })).toBeVisible();
  await expect(page.getByText("尚未提交", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /批准提交/ }).click();
  const dialog = page.getByRole("dialog", { name: "批准携程提交" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/当前为 Simulator/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认提交" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /确认已核对审计/ }).check();
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [
    ".ctrip-submit-modal .modal-header",
    ".ctrip-submit-summary",
    ".ctrip-submit-modal .modal-actions",
  ]);
  await attachScreenshot(page, testInfo, "ctrip-submit-approval", false);
  await dialog.getByRole("button", { name: "确认提交" }).click();

  await expect(page.getByText("模拟接受 · 未确认", { exact: true })).toBeVisible();
  await expect(page.getByText("等待公开回读", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /执行携程回读/ }).click();
  await expect(page.getByText("需复核", { exact: true })).toBeVisible();
  await expect(page.getByText("仅仿真证据 · 未产生真实发布", { exact: true })).toBeVisible();

  expect(fixture.ctripCommandRequests).toEqual([
    { command: "prepare", csrf: "web-e2e-csrf", body: {} },
    { command: "submit", csrf: "web-e2e-csrf", body: {} },
    { command: "readback", csrf: "web-e2e-csrf", body: {} },
  ]);
  expect(JSON.stringify(fixture.ctripCommandRequests)).not.toContain("submitPermit");
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [".handoff-actions", ".handoff-environment"]);
  await attachScreenshot(page, testInfo, "ctrip-simulator-reviewed");
});

test("live governed agent generation stays tenant-scoped and responsive", async ({
  page,
}, testInfo) => {
  const fixture = await installAutomationApiFixture(page);
  await page.goto("/content");

  await expect(page.getByRole("heading", { level: 1, name: "内容资产" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "受治理文章生成" })).toBeVisible();
  await expect(page.getByText("fixture · fixture-geo-writer-v1")).toBeVisible();
  await page
    .getByRole("textbox", { name: "Agent 主题与内容目标" })
    .fill("面向上海家庭客群核验日本暑期线路服务边界与官方咨询方式");
  await page.getByRole("button", { name: "实时生成文章" }).click();

  await expect(page.getByText("文章与 Dry-run 已生成")).toBeVisible();
  await expect(page.getByText(/geo_template_catalog.*geo_audit_request/u)).toBeVisible();
  await expect(page.getByRole("heading", { name: "日本线路服务边界核验指南" })).toBeVisible();
  expect(fixture.agentRunRequests).toHaveLength(1);
  expect(fixture.agentRunRequests[0]).toMatchObject({
    authorization: undefined,
    csrf: "web-e2e-csrf",
    body: {
      brandId: "10000000-0000-4000-8000-000000000301",
      campaignId: "10000000-0000-4000-8000-000000001001",
      channelAccountId: "10000000-0000-4000-8000-000000000701",
      platform: "toutiao",
      articleTemplateId: "step-by-step-guide",
    },
  });

  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [
    ".ops-agent-heading",
    ".ops-agent-actions",
    ".ops-agent-result",
    ".ops-agent-form .ops-form-grid",
  ]);
  await attachScreenshot(page, testInfo, "agent-live-generation");
});

test("live policy draft editor stays usable across viewports", async ({ page }, testInfo) => {
  await installAutomationApiFixture(page);
  await page.goto("/customers");

  await expect(page.getByRole("heading", { level: 1, name: "客户与品牌" })).toBeVisible();
  await page.getByRole("button", { name: "新建策略版本" }).click();
  const dialog = page.getByRole("dialog", { name: "新建审计策略版本" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("基于策略版本")).toHaveValue("travel-policy-v1");
  await expect(dialog.getByLabel("最少事实声明数")).toHaveValue("2");
  await expect(dialog.getByLabel("禁止保证词（每行一项）")).toHaveValue("保证\n百分百");

  const dialogBounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect(dialogBounds.top).toBeGreaterThanOrEqual(-1);
  expect(dialogBounds.left).toBeGreaterThanOrEqual(-1);
  expect(dialogBounds.right).toBeLessThanOrEqual(dialogBounds.viewportWidth + 1);
  expect(dialogBounds.bottom).toBeLessThanOrEqual(dialogBounds.viewportHeight + 1);
  expect(dialogBounds.scrollWidth).toBeLessThanOrEqual(dialogBounds.clientWidth + 1);
  expect(dialogBounds.overflowY).toBe("auto");
  if (testInfo.project.name.startsWith("mobile-")) {
    expect(dialogBounds.scrollHeight).toBeGreaterThan(dialogBounds.clientHeight);
  }
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [
    ".governance-dialog > header",
    ".governance-dialog-actions",
  ]);
  await attachScreenshot(page, testInfo, "policy-draft-editor", false);
});

test("live query-set governance remains readable and bounded", async ({ page }, testInfo) => {
  await installAutomationApiFixture(page);
  await page.goto("/visibility");

  await expect(page.getByRole("heading", { level: 1, name: "AI 可见性" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "问题集治理" })).toBeVisible();
  await expect(page.getByText("国内 AI 旅行决策问题集", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("v2", { exact: true })).toBeVisible();
  await expect(page.getByText("当前", { exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [
    ".query-set-manager > .panel-heading",
    ".query-set-version-heading",
    ".query-version-list > div",
  ]);
  await attachScreenshot(page, testInfo, "query-set-governance");

  await page.getByRole("button", { name: "新版本", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /创建 国内 AI 旅行决策问题集 新版本/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("问题内容 1")).toHaveValue("如何核验出境游服务边界？");
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [".modal-header", ".modal-actions"]);
  await attachScreenshot(page, testInfo, "query-set-version-dialog", false);
});

test("live automation settings expose scoped controls without overlap", async ({
  page,
}, testInfo) => {
  await installAutomationApiFixture(page);
  await page.goto("/settings");

  await expect(page.getByRole("heading", { level: 1, name: "系统设置" })).toBeVisible();
  await expect(page.getByText("细分范围控制", { exact: true })).toBeVisible();
  await expect(page.getByText("platform:toutiao", { exact: true })).toBeVisible();
  await expect(page.getByText("platform:sohu", { exact: true })).toBeVisible();
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [
    ".automation-subsection-heading",
    ".scope-control-list > div",
    ".circuit-list > div",
  ]);
  await attachScreenshot(page, testInfo, "automation-settings-live");

  await page.getByRole("button", { name: "添加范围控制" }).click();
  const scopedDialog = page.getByRole("dialog", { name: "添加范围控制" });
  await expect(scopedDialog).toBeVisible();
  await expect(scopedDialog.getByLabel("范围类型")).toHaveValue("platform");
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [".modal-header", ".modal-actions"]);
  await attachScreenshot(page, testInfo, "scoped-control-dialog", false);
  await scopedDialog.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "手动熔断" }).click();
  const circuitDialog = page.getByRole("dialog", { name: "人工熔断处置" });
  await expect(circuitDialog).toBeVisible();
  await expect(circuitDialog.getByLabel("熔断范围类型")).toHaveValue("tenant");
  await assertNoPageOverflow(page);
  await assertNoDirectChildOverlap(page, [".modal-header", ".modal-actions"]);
  await attachScreenshot(page, testInfo, "circuit-dialog", false);
});
