import { Check, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";

import type {
  Brand,
  BrandAgentProfile,
  BrandAgentProfileDocument,
  CreateBrandAgentProfileInput,
} from "./api.js";

import "./operations-console-tools.css";

const EMPTY_DOCUMENT: BrandAgentProfileDocument = {
  schemaVersion: "geo.brand-agent-profile.v1",
  voice: "克制、清晰、证据优先；先回答问题，再解释依据与边界",
  audiences: ["正在评估品牌服务并需要核验信息的潜在客户"],
  objectives: ["帮助读者基于当前证据理解服务事实、适用范围与下一步"],
  requiredPoints: ["区分已验证事实、适用条件和仍需确认的信息"],
  forbiddenClaims: ["无证据的保证、排名、独家资质、实时优惠或结果承诺"],
  callToAction: "请通过当前有效的官方联系方式核验具体服务范围与条件。",
  agentInstructions:
    "只选择有当前租户事实与证据支持的文章策略；优先直接回答、标明依据和有效期，并提供可执行的核验步骤。",
};

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .filter((item, index, values) => item.length > 0 && values.indexOf(item) === index);
}

function displayLines(value: readonly string[]): string {
  return value.join("\n");
}

export interface BrandAgentProfileEditorProps {
  readonly mode: "live" | "demo";
  readonly brands: readonly Brand[];
  readonly profiles: readonly BrandAgentProfile[];
  readonly capabilities: readonly string[];
  readonly demoBrandName?: string;
  readonly onSave: (brandId: string, input: CreateBrandAgentProfileInput) => Promise<void>;
  readonly onChanged?: () => void;
}

export function BrandAgentProfileEditor(props: BrandAgentProfileEditorProps) {
  const firstBrandId = props.brands[0]?.id ?? "demo-brand";
  const [brandId, setBrandId] = useState(firstBrandId);
  const [document, setDocument] = useState<BrandAgentProfileDocument>(EMPTY_DOCUMENT);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(
    null,
  );
  const profile = useMemo(
    () =>
      props.profiles.find((item) => item.brandId === brandId && item.status === "active") ?? null,
    [brandId, props.profiles],
  );
  const readOnly = props.mode === "demo" || !props.capabilities.includes("tenant:manage");

  useEffect(() => {
    if (props.brands.length > 0 && !props.brands.some((brand) => brand.id === brandId)) {
      setBrandId(props.brands[0]?.id ?? "demo-brand");
    }
  }, [brandId, props.brands]);

  useEffect(() => {
    setDocument(profile?.document ?? EMPTY_DOCUMENT);
    setReason("");
    setFeedback(null);
  }, [profile]);

  function update<K extends keyof BrandAgentProfileDocument>(
    key: K,
    value: BrandAgentProfileDocument[K],
  ) {
    setDocument((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (readOnly) return;
    setPending(true);
    setFeedback(null);
    try {
      await props.onSave(brandId, { document, reason: reason.trim() });
      setFeedback({ tone: "success", text: "品牌写作档案新版本已保存" });
      props.onChanged?.();
    } catch (error) {
      setFeedback({
        tone: "error",
        text: error instanceof Error ? error.message : "品牌写作档案保存失败",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="brand-profile-editor ops-console-tool ops-brand-profile">
      <div className="brand-profile-toolbar">
        <label className="brand-profile-selector">
          <span>当前品牌</span>
          <select
            value={brandId}
            disabled={props.mode === "demo" || props.brands.length === 0}
            onChange={(event) => setBrandId(event.target.value)}
          >
            {props.brands.length === 0 ? (
              <option value="demo-brand">{props.demoBrandName ?? "演示品牌"}</option>
            ) : (
              props.brands.map((brand) => (
                <option value={brand.id} key={brand.id}>
                  {brand.displayName}
                </option>
              ))
            )}
          </select>
        </label>
        <div className="brand-profile-metadata" role="list" aria-label="档案版本信息">
          <div className="brand-profile-version" role="listitem" aria-label="档案当前版本">
            <span>当前版本</span>
            <strong>{profile === null ? "未配置" : `v${profile.version}`}</strong>
          </div>
          <div className="brand-profile-version" role="listitem">
            <span>文档摘要</span>
            <strong title={profile?.documentHash ?? undefined}>
              {profile === null ? "-" : profile.documentHash.slice(0, 12)}
            </strong>
          </div>
          <div className="brand-profile-version" role="listitem">
            <span>生效时间</span>
            <strong>
              {profile === null ? "-" : new Date(profile.effectiveAt).toLocaleString("zh-CN")}
            </strong>
          </div>
        </div>
        <div className="brand-profile-boundary">
          <ShieldCheck aria-hidden="true" size={16} />
          <span>{props.mode === "demo" ? "演示样例 · 未写入 API" : "闭合正文 · 审计强制"}</span>
        </div>
      </div>

      {feedback === null ? null : (
        <div
          className={`governance-feedback governance-feedback-${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.tone === "success" ? <Check aria-hidden="true" size={15} /> : null}
          {feedback.text}
        </div>
      )}

      <form className="brand-profile-form" onSubmit={(event) => void submit(event)}>
        <fieldset className="brand-profile-group">
          <legend>策略基线</legend>
          <div className="brand-profile-group-grid">
            <label className="brand-profile-wide">
              品牌语气
              <textarea
                aria-label="品牌语气"
                rows={2}
                value={document.voice}
                readOnly={readOnly}
                required
                maxLength={1_000}
                onChange={(event) => update("voice", event.target.value)}
              />
            </label>
            <label>
              目标受众（每行一项）
              <textarea
                aria-label="目标受众"
                rows={4}
                value={displayLines(document.audiences)}
                readOnly={readOnly}
                required
                onChange={(event) => update("audiences", lines(event.target.value))}
              />
            </label>
            <label>
              内容目标（每行一项）
              <textarea
                aria-label="内容目标"
                rows={4}
                value={displayLines(document.objectives)}
                readOnly={readOnly}
                required
                onChange={(event) => update("objectives", lines(event.target.value))}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="brand-profile-group">
          <legend>内容约束</legend>
          <div className="brand-profile-group-grid">
            <label>
              必须覆盖（每行一项）
              <textarea
                aria-label="必须覆盖"
                rows={4}
                value={displayLines(document.requiredPoints)}
                readOnly={readOnly}
                onChange={(event) => update("requiredPoints", lines(event.target.value))}
              />
            </label>
            <label>
              禁止声明（每行一项）
              <textarea
                aria-label="禁止声明"
                rows={4}
                value={displayLines(document.forbiddenClaims)}
                readOnly={readOnly}
                onChange={(event) => update("forbiddenClaims", lines(event.target.value))}
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="brand-profile-group">
          <legend>输出编排</legend>
          <div className="brand-profile-group-grid">
            <label className="brand-profile-wide">
              行动引导
              <textarea
                aria-label="行动引导"
                rows={2}
                value={document.callToAction}
                readOnly={readOnly}
                required
                maxLength={1_000}
                onChange={(event) => update("callToAction", event.target.value)}
              />
            </label>
            <label className="brand-profile-wide">
              AI 写作编排约定
              <textarea
                aria-label="AI 写作编排约定"
                rows={5}
                value={document.agentInstructions}
                readOnly={readOnly}
                required
                maxLength={10_000}
                onChange={(event) => update("agentInstructions", event.target.value)}
              />
            </label>
          </div>
        </fieldset>

        <div className="brand-profile-submit-bar">
          <label>
            版本变更原因
            <input
              aria-label="档案版本变更原因"
              value={reason}
              readOnly={readOnly}
              required={!readOnly}
              minLength={3}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="button-primary"
            type="submit"
            disabled={readOnly || pending || props.brands.length === 0}
            title={
              props.mode === "demo"
                ? "演示样例不写入 API"
                : readOnly
                  ? "需要租户管理权限"
                  : undefined
            }
          >
            {pending ? (
              <LoaderCircle aria-hidden="true" className="spin" size={16} />
            ) : (
              <Save aria-hidden="true" size={16} />
            )}
            保存新版本
          </button>
        </div>
      </form>
    </div>
  );
}
