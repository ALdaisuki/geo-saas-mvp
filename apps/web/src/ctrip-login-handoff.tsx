import { AlertTriangle, CheckCircle2, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { GeoApiError, type GeoApi } from "./api.js";

const LOGIN_STATUS_POLL_INTERVAL_MS = 2_000;
const LOGIN_WINDOW_CLOSE_GRACE_MS = 2_500;

type LoginHandoffPhase =
  "checking" | "waiting" | "challenge" | "error" | "unavailable" | "complete";

export interface CtripLoginHandoffInput {
  readonly accountId: string;
  readonly loginUrl: string;
}

export interface CtripLoginHandoffProps {
  readonly accountId: string;
  readonly api: Pick<GeoApi, "refreshChannelAccountStatus" | "refreshCtripAccountStatus">;
  readonly loginUrl: string;
  readonly onCompleted?: () => void;
}

function validatedLoopbackLoginUrl(value: string, accountId: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/vnc.html" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.searchParams.get("channelAccountId") !== accountId ||
      url.searchParams.get("path") !== `websockify/accounts/${accountId}`
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function publicLoginUrl(loopbackUrl: string, accountId: string, origin: string): string | null {
  try {
    const publicOrigin = new URL(origin);
    if (publicOrigin.protocol !== "https:") return null;
    const source = new URL(loopbackUrl);
    const accountPath = encodeURIComponent(accountId);
    const loginUrl = new URL(`/ctrip-vnc/accounts/${accountPath}/vnc.html`, publicOrigin);
    for (const parameter of ["autoconnect", "resize"] as const) {
      const value = source.searchParams.get(parameter);
      if (value !== null) loginUrl.searchParams.set(parameter, value);
    }
    loginUrl.searchParams.set("channelAccountId", accountId);
    loginUrl.searchParams.set(
      "path",
      `ctrip-vnc/accounts/${accountId}/websockify/accounts/${accountId}`,
    );
    return loginUrl.toString();
  } catch {
    return null;
  }
}

function validatedHandoffLoginUrl(value: string, accountId: string, origin: string): string | null {
  try {
    const handoffOrigin = new URL(origin);
    if (handoffOrigin.protocol === "https:") {
      const url = new URL(value);
      const accountPath = encodeURIComponent(accountId);
      if (
        url.origin !== handoffOrigin.origin ||
        url.pathname !== `/ctrip-vnc/accounts/${accountPath}/vnc.html` ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.hash !== "" ||
        url.searchParams.get("channelAccountId") !== accountId ||
        url.searchParams.get("path") !==
          `ctrip-vnc/accounts/${accountId}/websockify/accounts/${accountId}`
      ) {
        return null;
      }
      return url.toString();
    }
    const loopbackOrigin = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      handoffOrigin.hostname.toLowerCase(),
    );
    return handoffOrigin.protocol === "http:" && loopbackOrigin
      ? validatedLoopbackLoginUrl(value, accountId)
      : null;
  } catch {
    return null;
  }
}

function createLoginHandoffUrl(
  loginUrl: string,
  accountId: string,
  routePath: "/account-login" | "/ctrip-login",
  origin = window.location.origin,
): string {
  const validated = validatedLoopbackLoginUrl(loginUrl, accountId);
  if (validated === null) throw new Error("账号登录入口未通过本地 noVNC 边界校验");
  const originUrl = new URL(origin);
  const targetLoginUrl =
    originUrl.protocol === "https:" ? publicLoginUrl(validated, accountId, origin) : validated;
  if (targetLoginUrl === null) throw new Error("账号登录入口未通过公网 noVNC 边界校验");
  const handoff = new URL(routePath, origin);
  handoff.searchParams.set("channelAccountId", accountId);
  handoff.searchParams.set("loginUrl", targetLoginUrl);
  return handoff.toString();
}

export function createAccountLoginHandoffUrl(
  loginUrl: string,
  accountId: string,
  origin = window.location.origin,
): string {
  return createLoginHandoffUrl(loginUrl, accountId, "/account-login", origin);
}

export function createCtripLoginHandoffUrl(
  loginUrl: string,
  accountId: string,
  origin = window.location.origin,
): string {
  return createLoginHandoffUrl(loginUrl, accountId, "/ctrip-login", origin);
}

export function parseCtripLoginHandoff(
  search: string,
  origin = window.location.origin,
): CtripLoginHandoffInput | null {
  const parameters = new URLSearchParams(search);
  const accountId = parameters.get("channelAccountId")?.trim() ?? "";
  const loginUrl = parameters.get("loginUrl") ?? "";
  if (accountId.length === 0) return null;
  const validated = validatedHandoffLoginUrl(loginUrl, accountId, origin);
  return validated === null ? null : { accountId, loginUrl: validated };
}

function closeLoginWindow(): void {
  window.close();
  window.setTimeout(() => {
    if (!window.closed) window.location.replace("/accounts");
  }, 200);
}

function defaultCompletion(): void {
  window.setTimeout(closeLoginWindow, LOGIN_WINDOW_CLOSE_GRACE_MS);
}

function phaseMessage(phase: LoginHandoffPhase): string {
  if (phase === "complete") return "已检测到登录成功，可手动关闭此窗口";
  if (phase === "unavailable") return "账号已不存在，正在关闭登录窗口";
  if (phase === "challenge") return "平台要求处理登录验证";
  if (phase === "error") return "登录状态暂时无法确认，正在重试";
  if (phase === "waiting") return "等待平台账号登录";
  return "正在检测平台登录状态";
}

export function CtripLoginHandoff({
  accountId,
  api,
  loginUrl,
  onCompleted,
}: CtripLoginHandoffProps) {
  const [phase, setPhase] = useState<LoginHandoffPhase>("checking");

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    const schedule = () => {
      if (!active) return;
      timer = window.setTimeout(() => void poll(), LOGIN_STATUS_POLL_INTERVAL_MS);
    };
    const poll = async () => {
      if (!active) return;
      const refreshStatus = api.refreshChannelAccountStatus ?? api.refreshCtripAccountStatus;
      if (refreshStatus === undefined) {
        setPhase("error");
        schedule();
        return;
      }
      try {
        const account = await refreshStatus.call(api, accountId);
        if (!active) return;
        const runtime = account.ctripRuntime;
        if (account.id !== accountId || runtime?.channelAccountId !== accountId) {
          setPhase("error");
          schedule();
          return;
        }
        if (
          runtime.sessionAuthenticated === true ||
          runtime.sessionState === "authenticated" ||
          runtime.sessionState === "ready"
        ) {
          active = false;
          setPhase("complete");
          // Keep the authenticated runtime visible. The operator may still need
          // to inspect the account or complete a platform-side step; only an
          // explicit completion callback may close/navigate the handoff.
          onCompleted?.();
          return;
        }
        setPhase(runtime.sessionState === "challenge_required" ? "challenge" : "waiting");
      } catch (error) {
        if (!active) return;
        if (error instanceof GeoApiError && error.status === 404) {
          active = false;
          setPhase("unavailable");
          (onCompleted ?? defaultCompletion)();
          return;
        }
        setPhase("error");
      }
      schedule();
    };

    void poll();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [accountId, api, onCompleted]);

  const message = phaseMessage(phase);
  return (
    <main className="ctrip-login-handoff">
      <header className="ctrip-login-handoff-status" role="status">
        <div className="ctrip-login-handoff-status-message">
          {phase === "complete" ? (
            <CheckCircle2 size={17} />
          ) : phase === "challenge" || phase === "error" || phase === "unavailable" ? (
            <AlertTriangle size={17} />
          ) : (
            <LoaderCircle className="spin" size={17} />
          )}
          <strong>{message}</strong>
        </div>
        <button
          className="ctrip-login-handoff-close"
          type="button"
          aria-label="关闭登录窗口"
          onClick={closeLoginWindow}
        >
          <X size={15} />
          <span>关闭</span>
        </button>
      </header>
      {phase === "unavailable" ? null : (
        <iframe
          className="ctrip-login-handoff-frame"
          title="平台账号登录"
          src={loginUrl}
          referrerPolicy="no-referrer"
          allowFullScreen
        />
      )}
    </main>
  );
}

function InvalidCtripLoginHandoff() {
  useEffect(() => {
    defaultCompletion();
  }, []);

  return (
    <main className="ctrip-login-handoff ctrip-login-handoff-invalid" role="alert">
      <AlertTriangle size={22} />
      <strong>账号登录入口已失效，正在关闭</strong>
    </main>
  );
}

export function CtripLoginHandoffRoute({ api, search }: Readonly<{ api: GeoApi; search: string }>) {
  const input = parseCtripLoginHandoff(search);
  if (input === null) return <InvalidCtripLoginHandoff />;
  return <CtripLoginHandoff {...input} api={api} />;
}

export const AccountLoginHandoffRoute = CtripLoginHandoffRoute;
