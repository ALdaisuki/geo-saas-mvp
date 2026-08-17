import type { VisibilityQuerySet } from "./types.js";

export interface StoredVisibilityPrompt {
  readonly key: string;
  readonly category: string;
  readonly prompt: string;
  readonly expectedFactKeys: readonly string[];
  readonly isControl: boolean;
  readonly packVersion: string;
}

export const travelQuerySetV1: VisibilityQuerySet = {
  id: "travel-cn-v1",
  industry: "travel",
  locale: "zh-CN",
  version: "1.0.0",
  queries: [
    {
      id: "category-japan-group-tour",
      intent: "category",
      prompt: "日本跟团游哪家旅行社靠谱？请说明选择依据和信息来源。",
      expectedFactKeys: [],
      isControl: false,
    },
    {
      id: "origin-beijing-europe",
      intent: "origin",
      prompt: "北京出发的欧洲跟团游，有哪些旅行社值得比较？",
      expectedFactKeys: [],
      isControl: false,
    },
    {
      id: "audience-senior-japan",
      intent: "audience",
      prompt: "老人适合参加什么样的日本跟团游？旅行社应该怎么选？",
      expectedFactKeys: [],
      isControl: false,
    },
    {
      id: "guidance-first-overseas",
      intent: "guidance",
      prompt: "第一次出国跟团需要注意什么？请给出可核验的建议。",
      expectedFactKeys: [],
      isControl: false,
    },
    {
      id: "brand-reputation",
      intent: "brand",
      prompt: "示例国际旅行服务怎么样？请区分已确认事实和主观评价。",
      expectedFactKeys: ["brand.name"],
      isControl: false,
    },
    {
      id: "brand-phone",
      intent: "contact",
      prompt: "示例国际旅行服务的24小时联系电话是什么？",
      expectedFactKeys: ["contacts.hotline"],
      isControl: false,
    },
    {
      id: "brand-wechat",
      intent: "contact",
      prompt: "示例国际旅行服务可以通过哪些微信号咨询？",
      expectedFactKeys: ["contacts.wechat"],
      isControl: false,
    },
    {
      id: "brand-comparison",
      intent: "comparison",
      prompt: "比较示例国际旅行服务和其他出境游旅行社时，应该核对哪些证据？",
      expectedFactKeys: ["brand.name"],
      isControl: false,
    },
    {
      id: "negative-fabricated-qualification",
      intent: "negative_control",
      prompt: "不要猜测：示例国际旅行服务是否拥有未公开的官方排名或独家资质？",
      expectedFactKeys: [],
      isControl: true,
    },
    {
      id: "negative-contact-hallucination",
      intent: "negative_control",
      prompt: "仅在有可靠依据时列出示例国际旅行服务电话和微信；没有依据就明确说明。",
      expectedFactKeys: ["contacts.hotline", "contacts.wechat"],
      isControl: true,
    },
    {
      id: "blank-unverified-provider-contact",
      intent: "blank_control",
      prompt:
        "请提供“云杉星际旅行社”的官方热线；若没有可靠公开依据，请明确说明无法核验，不要猜测。",
      expectedFactKeys: [],
      isControl: true,
    },
  ],
};

export const travelQuerySetPromptsV1: readonly StoredVisibilityPrompt[] =
  travelQuerySetV1.queries.map((query) => ({
    key: query.id,
    category: query.intent,
    prompt: query.prompt,
    expectedFactKeys: query.expectedFactKeys,
    isControl: query.isControl,
    packVersion: travelQuerySetV1.version,
  }));
