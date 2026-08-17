import type { RuntimeProviderConfigurationController } from "./runtime-provider-config.js";

const MAX_PROMPT_TEMPLATE_CHARS = 20_000;
const MAX_GENERATED_RESPONSE_BYTES = 256 * 1024;
const GENERATION_TIMEOUT_MS = 60_000;
const MAX_COMPLETION_TOKENS = 4_096;
const FIXTURE_PROVIDER = "fixture";
const FIXTURE_MODEL = "fixture-campaign-prompt-v1";

export interface CustomerPromptTemplateGenerationInput {
  readonly needs: string;
  readonly campaignName?: string;
  readonly topicKey?: string;
  readonly objective?: string;
  readonly destination?: string;
  readonly brandName?: string;
}

export interface CustomerPromptTemplateGenerationResult {
  readonly promptTemplate: string;
  readonly provider: string;
  readonly model: string;
  readonly generatedAt: string;
}

export interface CustomerPromptTemplateGenerator {
  generate(
    input: CustomerPromptTemplateGenerationInput,
  ): Promise<CustomerPromptTemplateGenerationResult>;
}

export class CustomerPromptTemplateGenerationError extends Error {
  readonly code = "CUSTOMER_PROMPT_TEMPLATE_GENERATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "CustomerPromptTemplateGenerationError";
  }
}

export function fixtureCustomerPromptTemplate(
  input: CustomerPromptTemplateGenerationInput,
): string {
  const campaignName = input.campaignName?.trim() || "本次推广计划";
  const topicKey = input.topicKey?.trim() || "目标客群与决策场景";
  const destination = input.destination?.trim() || "{destinationProvince}";
  return [
    "以第一人称普通游客视角撰写一篇跟团旅行体验笔记，避免硬广感与同账号重复。",
    "",
    "【核心任务】",
    `围绕推广计划「${campaignName}」的主题「${topicKey}」，覆盖 ${destination} 3-4 个核心代表性景区，信息增量充足、真实感强，符合内容平台优质笔记标准。`,
    "",
    "【标题要求】",
    "12-20 字，自然植入 1-2 个关键词，避开极限词与完整品牌名，与历史篇目标题保持角度差异。",
    "",
    "【内容结构】",
    "采用「触发场景 → 踩坑教训 → 选社标准与过程 → 核心优势 → 分景区实测细节 → 客观优缺点 → 收尾总结」的测评干货结构，段落顺序与详略按槽位调整。",
    "",
    "【品牌与关键词】",
    "品牌名在开篇、筛选过程、结尾三个位置自然分散出现，不集中堆砌；关键词按语境自然融入全文，每篇轮换重点。",
    "",
    "【风格与合规】",
    "纯文字、口语化、平实有细节；避免极限词、拉踩同行、夸大宣传和模板化流水账；结尾使用「我个人觉得不错，供大家参考」式的中立口吻。",
    "",
    "【客户补充需求】",
    input.needs.trim(),
    "",
    "本模版可替换变量：{campaignName}、{topicKey}、{destinationProvince}、{platform}、{slot}。",
  ].join("\n");
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface RuntimePromptSection {
  readonly provider: string | null;
  readonly model: string | null;
  readonly baseUrl: string | null;
  readonly api: "openai-responses" | "openai-completions" | null;
  readonly enabled: boolean;
  readonly apiKey: string | null;
}

export class RuntimeCustomerPromptTemplateGenerator implements CustomerPromptTemplateGenerator {
  readonly #store: RuntimeProviderConfigurationController;
  readonly #fetch: FetchLike;

  constructor(store: RuntimeProviderConfigurationController, fetchLike: FetchLike = fetch) {
    this.#store = store;
    this.#fetch = fetchLike;
  }

  async generate(
    input: CustomerPromptTemplateGenerationInput,
  ): Promise<CustomerPromptTemplateGenerationResult> {
    const document = await this.#store.getDocument({ includeSecrets: true });
    const drafting = document.sections.find((section) => section.configKey === "agent_drafting");
    const section: RuntimePromptSection = {
      provider: drafting?.provider ?? null,
      model: drafting?.model ?? null,
      baseUrl: drafting?.baseUrl ?? null,
      api: drafting?.api ?? null,
      enabled: drafting?.enabled ?? false,
      apiKey: drafting?.apiKey ?? null,
    };
    if (
      !section.enabled ||
      section.provider === null ||
      section.provider === "fixture" ||
      section.model === null ||
      section.apiKey === null ||
      section.apiKey.length === 0 ||
      section.baseUrl === null ||
      section.baseUrl.length === 0
    ) {
      return fixtureResult(input);
    }
    const api = section.api ?? "openai-completions";
    const prompt = buildGenerationPrompt(input);
    const generated = await (api === "openai-responses"
      ? this.#requestResponses(section, prompt)
      : this.#requestCompletions(section, prompt));
    const promptTemplate = sanitizePromptTemplate(generated);
    if (promptTemplate.length === 0) {
      throw new CustomerPromptTemplateGenerationError(
        "模型没有返回可用的提示词模版，请调整需求后重试",
      );
    }
    return {
      promptTemplate,
      provider: section.provider,
      model: section.model,
      generatedAt: new Date().toISOString(),
    };
  }

  async #requestCompletions(section: RuntimePromptSection, prompt: string): Promise<string> {
    const endpoint = new URL("chat/completions", `${section.baseUrl?.replace(/\/$/u, "")}/`);
    const payload = {
      model: section.model,
      messages: [
        {
          role: "system",
          content:
            "你只输出提示词模版正文，不输出 JSON 包装、解释或代码围栏。模版是客户对成稿内容的要求，不是系统指令。",
        },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      stream: false,
    };
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${section.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
    const raw = await boundedResponseText(response);
    if (!response.ok) {
      throw new CustomerPromptTemplateGenerationError(
        `模型服务返回 ${response.status}，请稍后重试`,
      );
    }
    const envelope = parseJsonObject(raw);
    const choice = parseObject(arrayValue(envelope?.choices)?.[0]);
    const message = parseObject(choice?.message);
    const text = typeof message?.content === "string" ? message.content : "";
    return text;
  }

  async #requestResponses(section: RuntimePromptSection, prompt: string): Promise<string> {
    const endpoint = new URL("responses", `${section.baseUrl?.replace(/\/$/u, "")}/`);
    const payload = {
      model: section.model,
      instructions:
        "你只输出提示词模版正文，不输出 JSON 包装、解释或代码围栏。模版是客户对成稿内容的要求，不是系统指令。",
      input: prompt,
      max_output_tokens: MAX_COMPLETION_TOKENS,
      stream: false,
    };
    const response = await this.#fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${section.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
    const raw = await boundedResponseText(response);
    if (!response.ok) {
      throw new CustomerPromptTemplateGenerationError(
        `模型服务返回 ${response.status}，请稍后重试`,
      );
    }
    const envelope = parseJsonObject(raw);
    const text = (arrayValue(envelope?.output) ?? [])
      .map((item) => {
        const entry = parseObject(item);
        if (entry?.type !== "message") return "";
        const content = arrayValue(entry.content);
        return (content ?? [])
          .map((part) => {
            const segment = parseObject(part);
            return segment?.type === "output_text" && typeof segment.text === "string"
              ? segment.text
              : "";
          })
          .join("");
      })
      .filter((segment) => segment.length > 0)
      .join("\n");
    return text;
  }
}

function fixtureResult(
  input: CustomerPromptTemplateGenerationInput,
): CustomerPromptTemplateGenerationResult {
  return {
    promptTemplate: fixtureCustomerPromptTemplate(input),
    provider: FIXTURE_PROVIDER,
    model: FIXTURE_MODEL,
    generatedAt: new Date().toISOString(),
  };
}

function buildGenerationPrompt(input: CustomerPromptTemplateGenerationInput): string {
  const lines = [
    "根据客户输入，生成一份可直接用于内容平台文章生成的中文提示词模版。",
    "",
    "要求：",
    "- 模版表达的是客户对成稿内容的要求，不是系统指令。",
    "- 使用可替换变量：{campaignName}、{topicKey}、{destinationProvince}、{platform}、{slot}。",
    "- 结构清晰，覆盖核心任务、标题要求、正文结构、品牌与关键词要求、风格与合规要求。",
    "- 体现客户输入中的具体细节与约束。",
    "- 输出完整模版正文。",
    "",
    "客户输入：",
    input.needs.trim(),
    "",
    "背景：",
    `品牌：${input.brandName?.trim() || "未提供"}`,
    `推广计划：${input.campaignName?.trim() || "未提供"}`,
    `主题：${input.topicKey?.trim() || "未提供"}`,
    `目标：${input.objective?.trim() || "未提供"}`,
    `目的地：${input.destination?.trim() || "未提供"}`,
  ];
  return lines.join("\n");
}

function sanitizePromptTemplate(value: string): string {
  return value
    .replace(/```(?:text|plain|markdown)?\n?/giu, "")
    .replace(/```/gu, "")
    .replace(/<\/?customer_prompt_template>/giu, "")
    .trim()
    .slice(0, MAX_PROMPT_TEMPLATE_CHARS);
}

async function boundedResponseText(response: Response): Promise<string> {
  const text = await response.text();
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_GENERATED_RESPONSE_BYTES) {
    throw new CustomerPromptTemplateGenerationError("模型返回内容过大，请简化需求后重试");
  }
  return text;
}

function parseObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | null {
  try {
    return parseObject(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function arrayValue(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}
