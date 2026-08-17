import type { PublicationGovernanceContext } from "./publication-governance.js";
import { describe, expect, it } from "vitest";

import { PlasticPromiseGovernanceClient, type McpToolCaller } from "./governance.js";
import {
  PlasticPromisePublicationGate,
  PublicationGovernanceDeniedError,
} from "./publication-governance.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const grantId = "00000000-0000-4000-8000-000000000003";

const validPublicationDefense = {
  decision: "allow",
  trust_score: 0.5,
  tool_name: "geo_publication_request",
  risk_level: "high",
  required_trust: 0.5,
  manifest: {
    name: "geo_publication_request",
    side_effects: ["external_publish"],
  },
} as const;

function governanceCaller(
  calls: Array<Parameters<McpToolCaller["callTool"]>[0]>,
  defense: Readonly<Record<string, unknown>> = validPublicationDefense,
): McpToolCaller {
  return {
    callTool: async (input) => {
      calls.push(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(input.name === "audit_pre_check" ? { passed: true } : defense),
          },
        ],
      };
    },
  };
}

describe("Plastic Promise publication gate", () => {
  it("sends an allowlisted grant and audit context without publication credentials", async () => {
    const calls: Array<Parameters<McpToolCaller["callTool"]>[0]> = [];
    const gate = new PlasticPromisePublicationGate(
      new PlasticPromiseGovernanceClient(governanceCaller(calls)),
    );
    const contextWithUnexpectedSecrets = {
      grant: {
        id: grantId,
        status: "issued",
        issuedAt: "2026-07-14T00:00:00.000Z",
        expiresAt: "2026-07-14T00:10:00.000Z",
        token: "raw-publication-token",
      },
      artifact: {
        id: "00000000-0000-4000-8000-000000000004",
        tenantId,
        variantId: "00000000-0000-4000-8000-000000000005",
        channelAccountId: "00000000-0000-4000-8000-000000000006",
        platform: "toutiao",
        payloadHash: "a".repeat(64),
        factSnapshotHash: "b".repeat(64),
        policyHash: "c".repeat(64),
        policyVersion: "travel-v1",
        auditHash: "d".repeat(64),
        status: "passed",
        findings: [
          {
            ruleId: "contact-integrity",
            ruleVersion: "1",
            severity: "info",
            message: "provider token=artifact-secret",
            evidence: ["Authorization: Bearer nested-secret"],
          },
        ],
        createdAt: "2026-07-14T00:00:00.000Z",
        expiresAt: "2026-07-14T00:10:00.000Z",
        tokenHash: "raw-token-hash",
      },
    } as unknown as PublicationGovernanceContext;

    await expect(
      gate.evaluate({
        phase: "grant_consumption",
        tenantId,
        actorId,
        resourceId: grantId,
        executionLevel: "dry_run",
        requestFingerprint: "e".repeat(64),
        publicationContext: contextWithUnexpectedSecrets,
      }),
    ).resolves.toMatchObject({ allowed: true, reason: "allowed" });

    const precheckCall = calls.find((call) => call.name === "audit_pre_check");
    const actionDescription = String(precheckCall?.arguments?.action_description);
    expect(JSON.parse(actionDescription)).toMatchObject({
      schema: "geo.publication-governance.v1",
      phase: "grant_consumption",
      resourceId: grantId,
      publicationContext: {
        grant: {
          id: grantId,
          status: "issued",
          expiresAt: "2026-07-14T00:10:00.000Z",
        },
        auditArtifact: {
          payloadHash: "a".repeat(64),
          policyHash: "c".repeat(64),
          auditHash: "d".repeat(64),
          status: "passed",
          findings: [
            {
              message: "provider token=[REDACTED]",
              evidence: ["Authorization: Bearer [REDACTED]"],
            },
          ],
        },
      },
    });
    expect(actionDescription).not.toContain("raw-publication-token");
    expect(actionDescription).not.toContain("raw-token-hash");
    expect(actionDescription).not.toContain("artifact-secret");
    expect(actionDescription).not.toContain("nested-secret");
  });

  it("marks the Pi proposal pre-check as non-authoritative until the API loads a grant", async () => {
    const calls: Array<Parameters<McpToolCaller["callTool"]>[0]> = [];
    const gate = new PlasticPromisePublicationGate(
      new PlasticPromiseGovernanceClient(governanceCaller(calls)),
    );

    await gate.evaluate({
      phase: "pre_authorization",
      tenantId,
      actorId,
      resourceId: "00000000-0000-4000-8000-000000000005",
      executionLevel: "dry_run",
      requestFingerprint: "fixture-publication-request",
    });

    const precheckCall = calls.find((call) => call.name === "audit_pre_check");
    const action = JSON.parse(String(precheckCall?.arguments?.action_description)) as {
      phase: string;
      publicationContext: unknown;
    };
    expect(action).toMatchObject({
      phase: "pre_authorization",
      publicationContext: { availability: "deferred_to_api_grant_consumption" },
    });
  });

  it("allows an exact high-risk external-publication classification", async () => {
    const gate = new PlasticPromisePublicationGate(
      new PlasticPromiseGovernanceClient(governanceCaller([])),
    );

    await expect(
      gate.evaluate({
        phase: "pre_authorization",
        tenantId,
        actorId,
        resourceId: "00000000-0000-4000-8000-000000000005",
        executionLevel: "dry_run",
        requestFingerprint: "valid-publication-defense",
      }),
    ).resolves.toMatchObject({ allowed: true, reason: "allowed" });
  });

  it("temporarily allows an ask decision when the reported publication trust is positive", async () => {
    const gate = new PlasticPromisePublicationGate(
      new PlasticPromiseGovernanceClient(
        governanceCaller([], {
          ...validPublicationDefense,
          decision: "ask",
          trust_score: 0.495,
          required_trust: 0.6,
        }),
      ),
    );

    await expect(
      gate.evaluate({
        phase: "pre_authorization",
        tenantId,
        actorId,
        resourceId: "00000000-0000-4000-8000-000000000005",
        executionLevel: "unattended",
        requestFingerprint: "positive-trust-publication-defense",
      }),
    ).resolves.toMatchObject({ allowed: true, reason: "allowed" });
  });

  it.each([undefined, 0, -0.01, Number.NaN])(
    "denies an ask decision when the reported publication trust is not positive (%s)",
    async (trustScore) => {
      const gate = new PlasticPromisePublicationGate(
        new PlasticPromiseGovernanceClient(
          governanceCaller([], {
            ...validPublicationDefense,
            decision: "ask",
            trust_score: trustScore,
            required_trust: 0.6,
          }),
        ),
      );

      await expect(
        gate.evaluate({
          phase: "pre_authorization",
          tenantId,
          actorId,
          resourceId: "00000000-0000-4000-8000-000000000005",
          executionLevel: "unattended",
          requestFingerprint: "non-positive-trust-publication-defense",
        }),
      ).resolves.toMatchObject({ allowed: false, reason: "defense_denied" });
    },
  );

  it.each([
    {
      name: "legacy low-risk read classification",
      defense: {
        decision: "allow",
        tool_name: "geo_publication_request",
        risk_level: "low",
        required_trust: 0,
        manifest: { name: "geo_publication_request", side_effects: ["read"] },
      },
    },
    {
      name: "mismatched tool classification",
      defense: {
        ...validPublicationDefense,
        tool_name: "geo_draft_proposal",
        manifest: { ...validPublicationDefense.manifest, name: "geo_draft_proposal" },
      },
    },
    {
      name: "low risk level",
      defense: { ...validPublicationDefense, risk_level: "low" },
    },
    {
      name: "non-positive trust requirement",
      defense: { ...validPublicationDefense, required_trust: 0 },
    },
    {
      name: "missing external publication side effect",
      defense: {
        ...validPublicationDefense,
        manifest: { ...validPublicationDefense.manifest, side_effects: ["read"] },
      },
    },
    {
      name: "mismatched manifest tool name",
      defense: {
        ...validPublicationDefense,
        manifest: { ...validPublicationDefense.manifest, name: "geo_draft_proposal" },
      },
    },
  ])("denies an allowed decision with $name", async ({ defense }) => {
    const gate = new PlasticPromisePublicationGate(
      new PlasticPromiseGovernanceClient(governanceCaller([], defense)),
    );

    await expect(
      gate.evaluate({
        phase: "pre_authorization",
        tenantId,
        actorId,
        resourceId: "00000000-0000-4000-8000-000000000005",
        executionLevel: "dry_run",
        requestFingerprint: "invalid-publication-defense",
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "defense_semantics_invalid",
    });
  });

  it("projects a grant-consumption denial into a bounded structured error", () => {
    const error = new PublicationGovernanceDeniedError({
      decision: {
        allowed: false,
        reason: "audit_pre_check_denied",
        evidence: {
          precheck: {
            passed: false,
            reason: "operator approval missing",
            authorization: "Bearer precheck-secret",
          },
          defense: {
            ...validPublicationDefense,
            cookie: "defense-secret",
          },
        },
      },
      phase: "grant_consumption",
      platformContext: {
        tenantId,
        actorId,
        resourceId: grantId,
        variantId: "00000000-0000-4000-8000-000000000005",
        channelAccountId: "00000000-0000-4000-8000-000000000006",
        platform: "toutiao",
        executionLevel: "unattended",
      },
    });

    expect(error).toMatchObject({
      code: "PUBLICATION_POLICY_DENIED",
      status: 403,
      retryable: false,
      reason: "audit_pre_check_denied",
      phase: "grant_consumption",
      evidenceSummary: {
        auditPreCheck: { passed: false },
        defense: {
          decision: "allow",
          toolName: "geo_publication_request",
          riskLevel: "high",
          requiredTrust: 0.5,
          manifestName: "geo_publication_request",
          sideEffects: ["external_publish"],
        },
        defenseSemanticsValid: true,
      },
      platformContext: {
        tenantId,
        actorId,
        resourceId: grantId,
        platform: "toutiao",
        executionLevel: "unattended",
      },
    });
    expect(Object.isFrozen(error.evidenceSummary)).toBe(true);
    expect(Object.isFrozen(error.platformContext)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("precheck-secret");
    expect(JSON.stringify(error)).not.toContain("defense-secret");
    expect(JSON.stringify(error)).not.toContain("operator approval missing");
  });
});
