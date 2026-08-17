import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GeoApiError, HttpGeoApi, type ChannelAccount } from "./api.js";
import {
  CtripLoginHandoff,
  CtripLoginHandoffRoute,
  createCtripLoginHandoffUrl,
  parseCtripLoginHandoff,
} from "./ctrip-login-handoff.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.cookie = "geo_csrf=; Max-Age=0; path=/";
});

const authenticatedAccount = {
  id: "account-ctrip",
  platform: "ctrip_community",
  displayName: "中通携程社区",
  capability: "browser_assisted",
  supportedExecutionLevels: ["dry_run", "assisted"],
  evidenceType: "api_response",
  evidenceRefs: ["platform_readback"],
  status: "active",
  lastVerifiedAt: null,
  dailyPublishQuota: 10,
  maxConcurrentPublications: 1,
  quotaTimezone: "Asia/Shanghai",
  ctripRuntime: {
    id: "runtime-ctrip",
    channelAccountId: "account-ctrip",
    sessionState: "authenticated",
    sessionAuthenticated: true,
    bridgePrincipalId: "bridge-principal",
    lastCheckedAt: "2026-07-29T13:30:00.000Z",
    lastReadyAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    updatedAt: "2026-07-29T13:30:00.000Z",
  },
} as const satisfies ChannelAccount;

describe("CtripLoginHandoff", () => {
  it("rewrites a loopback noVNC URL to the authenticated public same-origin route", () => {
    const handoff = createCtripLoginHandoffUrl(
      "http://127.0.0.1:10007/vnc.html?autoconnect=true&resize=scale&channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
      "account-ctrip",
      "https://geo.example.test",
    );

    const parsed = parseCtripLoginHandoff(new URL(handoff).search, "https://geo.example.test");
    expect(parsed).toEqual({
      accountId: "account-ctrip",
      loginUrl:
        "https://geo.example.test/ctrip-vnc/accounts/account-ctrip/vnc.html?autoconnect=true&resize=scale&channelAccountId=account-ctrip&path=ctrip-vnc%2Faccounts%2Faccount-ctrip%2Fwebsockify%2Faccounts%2Faccount-ctrip",
    });
    expect(handoff).not.toContain("127.0.0.1%3A10007");
  });

  it("wraps only the account-bound loopback noVNC URL", () => {
    const handoff = createCtripLoginHandoffUrl(
      "http://127.0.0.1:10007/vnc.html?autoconnect=true&channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
      "account-ctrip",
      "http://127.0.0.1:10003",
    );

    expect(parseCtripLoginHandoff(new URL(handoff).search)).toEqual({
      accountId: "account-ctrip",
      loginUrl:
        "http://127.0.0.1:10007/vnc.html?autoconnect=true&channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip",
    });
    expect(() =>
      createCtripLoginHandoffUrl(
        "https://example.test/vnc.html?channelAccountId=account-ctrip",
        "account-ctrip",
        "http://127.0.0.1:10003",
      ),
    ).toThrow("本地 noVNC 边界校验");
    expect(() =>
      createCtripLoginHandoffUrl(
        "http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip",
        "account-ctrip",
        "http://127.0.0.1:10003",
      ),
    ).toThrow("本地 noVNC 边界校验");
  });

  it("stops polling and unloads noVNC when the account no longer exists", async () => {
    const refreshCtripAccountStatus = vi.fn(async () => {
      throw new GeoApiError(404, "RESOURCE_NOT_FOUND", "Channel account was not found");
    });

    render(
      <CtripLoginHandoff
        accountId="account-ctrip"
        api={{ refreshCtripAccountStatus }}
        loginUrl="http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip"
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshCtripAccountStatus).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("平台账号登录")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("账号已不存在");
  });

  it("closes an invalid stale handoff instead of leaving a disconnected noVNC frame", async () => {
    vi.useFakeTimers();
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);

    render(
      <CtripLoginHandoffRoute
        api={{} as HttpGeoApi}
        search="?channelAccountId=account-ctrip&loginUrl=http%3A%2F%2F127.0.0.1%3A10007%2Fvnc.html%3FchannelAccountId%3Daccount-ctrip"
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the authenticated runtime open and stops polling", async () => {
    vi.useFakeTimers();
    const refreshCtripAccountStatus = vi.fn(async () => authenticatedAccount);
    const onCompleted = vi.fn();

    render(
      <CtripLoginHandoff
        accountId={authenticatedAccount.id}
        api={{ refreshCtripAccountStatus }}
        loginUrl="http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip"
        onCompleted={onCompleted}
      />,
    );

    expect(screen.getByTitle("平台账号登录")).toBeInTheDocument();

    await act(async () => {
      await Promise.resolve();
    });

    expect(refreshCtripAccountStatus).toHaveBeenCalledWith(authenticatedAccount.id);
    expect(screen.getByTitle("平台账号登录")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("可手动关闭此窗口");
    expect(onCompleted).toHaveBeenCalledTimes(1);
  });

  it("lets an operator close the login tab while status confirmation is still pending", () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const refreshCtripAccountStatus = vi.fn(() => new Promise<ChannelAccount>(() => undefined));

    render(
      <CtripLoginHandoff
        accountId={authenticatedAccount.id}
        api={{ refreshCtripAccountStatus }}
        loginUrl="http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "关闭登录窗口" }));

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("polls through the bound production API client", async () => {
    document.cookie = "geo_csrf=test-token; path=/";
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(authenticatedAccount), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      ),
    );
    const api = new HttpGeoApi("", fetchImpl);
    const onCompleted = vi.fn();

    render(
      <CtripLoginHandoff
        accountId={authenticatedAccount.id}
        api={api}
        loginUrl="http://127.0.0.1:10007/vnc.html?channelAccountId=account-ctrip&path=websockify%2Faccounts%2Faccount-ctrip"
        onCompleted={onCompleted}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/channel-accounts/${authenticatedAccount.id}/session-status`,
      expect.objectContaining({ method: "POST" }),
    );
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    expect(screen.getByTitle("平台账号登录")).toBeInTheDocument();
  });
});
