import { expect, test, type Page, type TestInfo } from "@playwright/test";

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

async function installAutomationApiFixture(page: Page): Promise<void> {
  const tenantId = "10000000-0000-4000-8000-000000000001";
  const actorId = "10000000-0000-4000-8000-000000000101";
  const brandId = "10000000-0000-4000-8000-000000000301";
  const campaignId = "10000000-0000-4000-8000-000000001001";
  const accountId = "10000000-0000-4000-8000-000000000701";
  const batchId = "10000000-0000-4000-8000-000000002001";
  const runId = "10000000-0000-4000-8000-000000003001";
  const now = "2026-07-15T08:00:00.000Z";
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
        "receipt:read",
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
      id: "10000000-0000-4000-8000-000000000703",
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

  const items = (values: readonly unknown[]) => ({ items: values });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
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
      ["/api/members", items([])],
      ["/api/policies", items(policies)],
      ["/api/query-sets", items([])],
      ["/api/evidence-sources", items([])],
      ["/api/facts", items([])],
      ["/api/campaigns", items(campaigns)],
      ["/api/content", items([])],
      ["/api/audits", items([])],
      ["/api/publication-jobs", items([])],
      ["/api/receipts", items([])],
      ["/api/visibility/summary", items([])],
      [
        "/api/automation",
        {
          control: {
            mode: "unattended",
            killSwitchEnabled: false,
            reason: null,
            quota: { dryRunOnly: true },
            updatedAt: now,
          },
          circuits: [],
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
