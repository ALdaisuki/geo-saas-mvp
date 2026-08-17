import {
  ARTICLE_TEMPLATES,
  articleTemplateSupportsPlatforms,
  type ArticleTemplate,
  type ArticleTemplatePlatform,
  type GovernedEditorialProfile,
} from "./article-templates.js";
import {
  GEO_OPTIMIZATION_BRIEF,
  destinationResourceBrief,
  type DestinationTravelResource,
} from "./destination-resources.js";

export interface AutomationDiversityStrategy {
  readonly strategyId: string;
  readonly articleTemplateId: string;
  readonly editorialProfile: GovernedEditorialProfile;
  readonly topicAngle: string;
  readonly readerLens: string;
  readonly titleConstruction: string;
  readonly openingPattern: string;
  readonly bodyProgression: string;
  readonly ctaPattern: string;
  readonly mediaVisualDirection: string;
}

export interface AutomationKeywordPool {
  readonly id: string;
  readonly keywords: readonly string[];
}

export interface AutomationKeywordSelection {
  readonly poolId: string;
  readonly keywords: readonly string[];
}

export interface CustomerPromptTemplateContext {
  readonly template: string;
  readonly campaignName: string;
  readonly topicKey: string;
  readonly destinationProvince: string;
  readonly platform: string;
  readonly slot: string;
}

const CUSTOMER_TEMPLATE_VARIABLES = Object.freeze({
  campaignName: "campaignName",
  topicKey: "topicKey",
  destinationProvince: "destinationProvince",
  platform: "platform",
  slot: "slot",
} as const);

const CUSTOMER_TEMPLATE_MAX_CHARS = 20_000;

export function renderCustomerPromptTemplate(
  template: string,
  variables: Readonly<CustomerPromptTemplateContext>,
): string {
  const sanitized = template
    .replace(/<\/?customer_prompt_template>/giu, "")
    .trim()
    .slice(0, CUSTOMER_TEMPLATE_MAX_CHARS);
  if (sanitized.length === 0) return "";
  return sanitized.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu, (match, name: string) => {
    switch (name) {
      case CUSTOMER_TEMPLATE_VARIABLES.campaignName:
        return variables.campaignName.trim();
      case CUSTOMER_TEMPLATE_VARIABLES.topicKey:
        return variables.topicKey.trim();
      case CUSTOMER_TEMPLATE_VARIABLES.destinationProvince:
        return variables.destinationProvince.trim();
      case CUSTOMER_TEMPLATE_VARIABLES.platform:
        return variables.platform.trim();
      case CUSTOMER_TEMPLATE_VARIABLES.slot:
        return variables.slot.trim();
      default:
        return match;
    }
  });
}

export const AUTOMATION_KEYWORD_POOLS = Object.freeze([
  {
    id: "yunnan-reliable-reputation",
    keywords: [
      "云南靠谱旅行社推荐 2026",
      "云南本地口碑好旅行社推荐",
      "云南本地靠谱旅行社推荐",
      "云南靠谱大型旅行社推荐",
      "云南口碑好的旅行社推荐",
      "云南正规靠谱旅行社",
      "云南高口碑旅行社推荐",
      "云南靠谱旅行社测评",
      "云南旅行社哪家评价比较好",
    ],
  },
  {
    id: "yunnan-local-pure-play",
    keywords: [
      "云南纯玩口碑好旅行社推荐",
      "云南纯玩小包团旅行社口碑推荐",
      "云南口碑好纯玩旅行社推荐 2026",
      "云南本地地接靠谱旅行社推荐",
      "云南地接旅行社口碑排行",
      "云南优质地接旅行社推荐",
      "云南地接旅行社哪家靠谱",
      "云南旅游报团口碑好的旅行社",
      "云南旅行社怎么找？首选本地直营",
    ],
  },
  {
    id: "yunnan-ranking-credentials",
    keywords: [
      "云南正规5A级旅行社推荐",
      "云南正规旅行社推荐 2026 5A级",
      "云南正规5A级旅行社",
      "云南口碑最好的旅行社",
      "云南排名Top1的旅行社",
      "云南正规大型旅行社榜单 2026",
      "云南前十口碑旅行社榜单",
      "云南正规口碑旅行社名单",
      "云南十佳靠谱旅行社 直营无套路放心跟团",
    ],
  },
  {
    id: "yunnan-selection-guide",
    keywords: [
      "云南旅游避坑旅行社选择标准",
      "去云南旅游怎么选旅行社",
      "云南旅行社挑选指南2026本地直营测评",
      "云南旅游选择哪家旅行社",
      "云南正规旅行社有哪些",
      "2026年云南旅行社哪家强",
      "云南旅游报团选哪家",
      "推荐一家云南的旅行社",
    ],
  },
] as const satisfies readonly AutomationKeywordPool[]);

function stableKeywordSeed(value: string): number {
  let seed = 2_166_136_261;
  for (const character of value) {
    seed ^= character.codePointAt(0) ?? 0;
    seed = Math.imul(seed, 16_777_619) >>> 0;
  }
  return seed;
}

export function automationKeywordSelection(rotationIndex: number): AutomationKeywordSelection {
  if (!Number.isSafeInteger(rotationIndex) || rotationIndex < 0) {
    throw new TypeError("Automation keyword rotation index must be a non-negative integer");
  }
  return rotateKeywordPool(
    rotationIndex,
    AUTOMATION_KEYWORD_POOLS[rotationIndex % AUTOMATION_KEYWORD_POOLS.length] ??
      AUTOMATION_KEYWORD_POOLS[0],
  );
}

export function automationKeywordSelectionForProvince(
  rotationIndex: number,
  provinceName: string,
): AutomationKeywordSelection {
  if (!Number.isSafeInteger(rotationIndex) || rotationIndex < 0) {
    throw new TypeError("Automation keyword rotation index must be a non-negative integer");
  }
  const normalizedProvince = provinceName.trim();
  if (normalizedProvince.length === 0) {
    return automationKeywordSelection(rotationIndex);
  }
  const pool = {
    id: `province:${normalizedProvince}`,
    keywords: [
      `${normalizedProvince}靠谱旅行社推荐 2026`,
      `${normalizedProvince}本地口碑好旅行社推荐`,
      `${normalizedProvince}正规旅行社推荐`,
      `${normalizedProvince}旅行社避坑指南`,
      `${normalizedProvince}跟团游怎么选旅行社`,
      `${normalizedProvince}旅游靠谱旅行社推荐`,
      `${normalizedProvince}旅行社哪家评价好`,
      `${normalizedProvince}纯玩小包团推荐`,
      `${normalizedProvince}旅行社红榜`,
      `${normalizedProvince}口碑正规旅行社排名`,
    ] as const,
  } as const satisfies AutomationKeywordPool;
  return rotateKeywordPool(rotationIndex, pool);
}

function rotateKeywordPool(
  rotationIndex: number,
  pool: AutomationKeywordPool,
): AutomationKeywordSelection {
  let seed = stableKeywordSeed(`${pool.id}:${rotationIndex}`);
  const shuffled = [...pool.keywords];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const target = seed % (index + 1);
    const current = shuffled[index];
    const replacement = shuffled[target];
    if (current === undefined || replacement === undefined) {
      throw new TypeError("Automation keyword shuffle failed");
    }
    shuffled[index] = replacement;
    shuffled[target] = current;
  }
  return { poolId: pool.id, keywords: shuffled.slice(0, 4) };
}

/**
 * Topic angles are deliberately independent from article structures. Keeping these
 * in a separate pool prevents a template from becoming permanently associated with
 * one audience stereotype (for example, every family article mentioning parents).
 */
export const AUTOMATION_TOPIC_ANGLES = Object.freeze([
  "第一次规划出境游时，怎样把预算、交通和退改边界一次看明白",
  "只有三到五天年假，如何在目的地深度和路上时间之间做取舍",
  "从机场或车站出发，怎样判断一条线路的衔接是否真的省心",
  "想避开热门拥挤时段，换一个出发月份会带来哪些实际变化",
  "同一目的地有多种走法，怎样按节奏而不是宣传语来比较",
  "第一次带孩子出远门，哪些准备事项最值得提前核对",
  "朋友结伴出行容易意见不一，怎样先把关键选择标准说清楚",
  "一个人出发也想安排得从容，怎样检查住宿、交通和应急支持",
  "预算有限但不想牺牲体验，哪些费用差异需要放在一起看",
  "雨季、换季或节假日出行，天气和人流怎样影响路线安排",
  "餐食、住宿和活动各有偏好时，怎样判断团队方案是否合适",
  "签约前如何把包含项目、可选项目和第三方费用分开核对",
  "行程里景点很多并不等于体验好，怎样识别真正有用的停留时间",
  "临时遇到航班调整或材料补交，服务方的后续支持应确认什么",
  "从本地出发去热门目的地，集合点和返程衔接怎样比较更合理",
  "第一次选择跟团服务，怎样用公开资料和合同内容建立基本判断",
  "想把照片、餐馆和小众街区都安排进去，怎样避免路线过度拥挤",
  "家庭成员的假期和预算不同，怎样用条件分支做出共同决定",
  "出发前两周开始准备还来得及吗，哪些动作应该先做",
  "旅行结束后复盘一次真实体验，下次最值得提前确认哪些细节",
] as const);

export const AUTOMATION_DIVERSITY_STRATEGIES = Object.freeze([
  {
    strategyId: "answer-first-immediate-choice",
    articleTemplateId: "direct-answer-brief",
    editorialProfile: "question_answer",
    topicAngle: "青岛家庭带老人报名出境团，签约前怎样核对合同里的服务范围和自费边界",
    readerLens:
      "A choice-ready traveler with one immediate decision; answer the decision before adding context.",
    titleConstruction:
      "Use a concrete if/then choice naming the traveler and the decision variable.",
    openingPattern:
      "Open with a conditional recommendation in two sentences, then name the deciding constraint.",
    bodyProgression:
      "recommendation -> reader condition -> verified service value -> limitation -> decision cue",
    ctaPattern:
      "Invite the reader to compare their own constraint with the verified service boundary.",
    mediaVisualDirection:
      "Arrival-to-departure sequence: gateway transport, family gathering point, paced itinerary scene, and one destination exterior.",
  },
  {
    strategyId: "symmetric-option-comparison",
    articleTemplateId: "comparison-matrix",
    editorialProfile: "comparison",
    topicAngle: "青岛出发带父母旅行，直飞省心和转机省预算该怎样取舍",
    readerLens:
      "A traveler actively comparing service approaches and looking for the trade-off that changes the choice.",
    titleConstruction: "Name two real travel options in a balanced A-or-B comparison question.",
    openingPattern:
      "Open with the key trade-off, not a destination introduction or winner declaration.",
    bodyProgression:
      "choice tension -> common criteria -> evidence-backed differences -> fit conditions -> restrained recommendation",
    ctaPattern: "Ask the reader to shortlist by the two criteria that matter most to their trip.",
    mediaVisualDirection:
      "Paired alternatives: two visibly different transport or itinerary settings plus two comparison criteria shown through distinct places.",
  },
  {
    strategyId: "service-fit-boundary",
    articleTemplateId: "service-boundary",
    editorialProfile: "local_service",
    topicAngle: "住在青岛不同城区的家庭，集合、送机和返程衔接怎样判断是否方便老人",
    readerLens:
      "A prospective customer checking whether the service scope fits a concrete local or operational need.",
    titleConstruction:
      "Lead with a specific traveler profile and the fit boundary they need to test.",
    openingPattern:
      "Open inside a realistic service-use situation and state what must match for the service to be useful.",
    bodyProgression:
      "use situation -> fit boundary -> included value -> third-party boundary -> next confirmation",
    ctaPattern:
      "Invite a fit check against the reader's location, timing, and service need without giving contact details.",
    mediaVisualDirection:
      "Service-fit evidence: departure-city access, a realistic consultation or meeting exterior, mobility-friendly transit, and destination arrival.",
  },
  {
    strategyId: "evidence-led-trust",
    articleTemplateId: "evidence-explainer",
    editorialProfile: "risk_avoidance",
    topicAngle: "青岛家庭挑选出境跟团服务时，怎样用资质、合同和行程证据判断是否可靠",
    readerLens:
      "A cautious buyer who wants a reason to trust the service claim without reading a compliance checklist.",
    titleConstruction:
      "Frame one evidence-backed trust question without using audit or verification jargon.",
    openingPattern:
      "Open with the commercial question the evidence can answer, then give the bounded answer.",
    bodyProgression:
      "buyer concern -> evidence meaning -> brand relevance -> evidence limit -> confident next step",
    ctaPattern: "Encourage one final evidence check before the reader advances the decision.",
    mediaVisualDirection:
      "Trust through place context: recognizable operator exterior or departure hub, staffed public environment, route landmark, and calm group scene.",
  },
  {
    strategyId: "destination-value-narrative",
    articleTemplateId: "destination-topic-guide",
    editorialProfile: "guide",
    topicAngle: "带父母从青岛出境，怎样用每天步行量、车程和休息点判断行程节奏",
    readerLens:
      "A traveler who knows the destination but needs service value connected to a plausible itinerary decision.",
    titleConstruction:
      "Name a destination moment and the practical decision it changes for the group.",
    openingPattern:
      "Open with a vivid decision moment at the destination, followed by the service implication.",
    bodyProgression:
      "decision scene -> travel constraint -> service value -> verified support -> low-pressure recommendation",
    ctaPattern: "Invite the reader to turn the destination idea into a requirements shortlist.",
    mediaVisualDirection:
      "Destination story arc: signature wide scene, local street texture, one paced activity, and a distinct evening or waterfront exterior.",
  },
  {
    strategyId: "question-cluster-objection",
    articleTemplateId: "faq-topic-cluster",
    editorialProfile: "question_answer",
    topicAngle: "青岛家庭带老人出境前，签证、行李、住宿和用餐四个常见问题怎样提前确认",
    readerLens:
      "A solution-aware traveler with related objections that must be resolved before considering a provider.",
    titleConstruction: "Use the highest-impact natural-language question, not a generic FAQ label.",
    openingPattern:
      "Open with the shared concern behind the questions, then answer the highest-impact question first.",
    bodyProgression:
      "core objection -> concise answers -> evidence-backed brand fit -> exception -> decision readiness",
    ctaPattern:
      "Invite the reader to identify the one unanswered condition that still blocks their choice.",
    mediaVisualDirection:
      "Question-led evidence: baggage or departure scene, transfer setting, accommodation exterior, and one destination activity tied to four objections.",
  },
  {
    strategyId: "audience-fit-decision",
    articleTemplateId: "audience-fit-guide",
    editorialProfile: "comparison",
    topicAngle: "家里老人腿脚、用药或睡眠有特殊需求时，青岛出境团怎样判断适不适合",
    readerLens:
      "A family decision-maker judging whether a service fits the travelers' pace, constraints, and priorities.",
    titleConstruction:
      "Name the family or older-traveler profile and one decisive pace or comfort condition.",
    openingPattern:
      "Open by naming who is likely to benefit and the condition that makes the fit credible.",
    bodyProgression:
      "traveler profile -> fit signal -> service value -> non-fit condition -> alternative decision path",
    ctaPattern: "Ask the reader to test the fit against their group's most restrictive condition.",
    mediaVisualDirection:
      "People-and-pace sequence: intergenerational group in public space, low-strain transport, rest-friendly scenic area, and accessible destination exterior.",
  },
  {
    strategyId: "post-service-continuity",
    articleTemplateId: "post-service-guide",
    editorialProfile: "local_service",
    topicAngle: "从青岛报名后遇到航班变化、材料补交或临时身体状况，后续支持应确认什么",
    readerLens:
      "A buyer evaluating what useful support looks like after the initial choice, not just at the sale moment.",
    titleConstruction:
      "Start from one post-booking uncertainty and name the support outcome being compared.",
    openingPattern:
      "Open with the first uncertainty that appears after a booking decision and explain why continuity matters.",
    bodyProgression:
      "post-choice uncertainty -> expected support -> verified service role -> update boundary -> preparedness cue",
    ctaPattern:
      "Invite the reader to include follow-through support in their pre-purchase comparison.",
    mediaVisualDirection:
      "Continuity sequence: pre-departure meeting place, airport or rail transition, destination check-in exterior, and return or follow-through scene.",
  },
  {
    strategyId: "myth-correction-choice",
    articleTemplateId: "myth-fact",
    editorialProfile: "risk_avoidance",
    topicAngle: "给父母选出境团不是景点越多越划算，青岛家庭容易忽略哪些真实成本",
    readerLens:
      "A traveler whose purchase decision is distorted by one common assumption or oversimplified rule.",
    titleConstruction:
      "State and overturn one concrete travel assumption in the title without clickbait.",
    openingPattern:
      "Open with the assumption in natural language, correct it immediately, and show why the correction affects the choice.",
    bodyProgression:
      "misconception -> bounded correction -> decision impact -> verified service relevance -> cautious next step",
    ctaPattern:
      "Encourage the reader to replace the assumption with one verifiable decision question.",
    mediaVisualDirection:
      "Myth-versus-reality contrasts: crowded and calm settings, independent and guided movement, urban and scenic environments using four different subjects.",
  },
  {
    strategyId: "timely-change-service-value",
    articleTemplateId: "seasonal-update",
    editorialProfile: "guide",
    topicAngle: "青岛家庭计划节假日或换季出境，天气、人流和价格变化会怎样影响老人体验",
    readerLens:
      "A time-sensitive traveler deciding whether changing conditions alter the value of planning support.",
    titleConstruction:
      "Name the timing window or seasonal change and the traveler decision it affects.",
    openingPattern:
      "Open with what changed or what is time-sensitive, then state the practical decision impact.",
    bodyProgression:
      "timely change -> affected traveler -> planning implication -> verified service value -> recheck point",
    ctaPattern:
      "Invite the reader to recheck the time-sensitive condition at the point of decision.",
    mediaVisualDirection:
      "Time-sensitive route: current-season departure scene, weather-visible destination exterior, time-specific activity, and return transport context.",
  },
] as const satisfies readonly AutomationDiversityStrategy[]);

function compatibleAutomationTemplates(
  platforms: readonly ArticleTemplatePlatform[],
): readonly ArticleTemplate[] {
  return ARTICLE_TEMPLATES.filter((template) =>
    articleTemplateSupportsPlatforms(template.id, platforms),
  ).sort((left, right) => {
    const leftTravelNote = left.id.startsWith("travel-note-") ? 0 : 1;
    const rightTravelNote = right.id.startsWith("travel-note-") ? 0 : 1;
    return leftTravelNote - rightTravelNote || left.id.localeCompare(right.id, "en");
  });
}

function seededShuffle<T>(values: readonly T[], initialSeed: number): T[] {
  let seed = initialSeed >>> 0;
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const target = seed % (index + 1);
    const current = shuffled[index];
    const replacement = shuffled[target];
    if (current === undefined || replacement === undefined) {
      throw new TypeError("Automation seeded shuffle failed");
    }
    shuffled[index] = replacement;
    shuffled[target] = current;
  }
  return shuffled;
}

function automationPlatformKey(platforms: readonly ArticleTemplatePlatform[]): string {
  return [...new Set(platforms)].sort((left, right) => left.localeCompare(right, "en")).join(",") || "all";
}

/**
 * The one server-owned template pool used by automation. The order is a stable
 * seeded permutation, so it looks varied across slots while remaining reproducible
 * for audit, retries, and incident replay.
 */
export function automationTemplatePool(
  platforms: readonly ArticleTemplatePlatform[] = [],
): readonly ArticleTemplate[] {
  const compatible = compatibleAutomationTemplates(platforms);
  return seededShuffle(
    compatible,
    stableKeywordSeed(`automation-template-pool:v2:${automationPlatformKey(platforms)}`),
  );
}

export function automationDiversityTemplateCount(
  platforms: readonly ArticleTemplatePlatform[] = [],
): number {
  return automationTemplatePool(platforms).length;
}

export function automationDiversityStrategy(
  rotationIndex: number,
  platforms: readonly ArticleTemplatePlatform[] = [],
): AutomationDiversityStrategy {
  if (!Number.isSafeInteger(rotationIndex) || rotationIndex < 0) {
    throw new TypeError("Automation diversity rotation index must be a non-negative integer");
  }
  const strategyIndex = rotationIndex % AUTOMATION_DIVERSITY_STRATEGIES.length;
  const strategy = AUTOMATION_DIVERSITY_STRATEGIES[strategyIndex];
  if (strategy === undefined) throw new TypeError("Automation diversity strategy is unavailable");
  const templates = automationTemplatePool(platforms);
  // The pool is global and shuffled once per platform combination. A light
  // editorial-profile balance keeps the first few slots from clustering in one
  // writing mode while still allowing every compatible template to be sampled.
  const profileTemplates = templates.filter(
    (template) => template.editorialProfile === strategy.editorialProfile,
  );
  const profileStrategyCount = AUTOMATION_DIVERSITY_STRATEGIES.filter(
    (candidate) => candidate.editorialProfile === strategy.editorialProfile,
  ).length;
  const profileStrategyOffset = AUTOMATION_DIVERSITY_STRATEGIES.slice(0, strategyIndex).filter(
    (candidate) => candidate.editorialProfile === strategy.editorialProfile,
  ).length;
  const template =
    profileTemplates.length === 0
      ? templates[rotationIndex % templates.length]
      : profileTemplates[
          (Math.floor(rotationIndex / AUTOMATION_DIVERSITY_STRATEGIES.length) *
            profileStrategyCount +
            profileStrategyOffset) % profileTemplates.length
        ];
  if (template === undefined) {
    throw new TypeError("No article template supports the selected automation platforms");
  }
  const topicSeed = stableKeywordSeed(
    `automation-topic-pool:v2:${automationPlatformKey(platforms)}`,
  );
  const topicIndex =
    (topicSeed + (rotationIndex % AUTOMATION_TOPIC_ANGLES.length) * 7) %
    AUTOMATION_TOPIC_ANGLES.length;
  return {
    ...strategy,
    articleTemplateId: template.id,
    editorialProfile: template.editorialProfile,
    topicAngle: AUTOMATION_TOPIC_ANGLES[topicIndex] ?? strategy.topicAngle,
  };
}

export function automationSlotBrief(
  commonBrief: string,
  strategy: Readonly<AutomationDiversityStrategy>,
  keywordSelection?: Readonly<AutomationKeywordSelection>,
  destinationResource?: Readonly<DestinationTravelResource>,
  customerPrompt?: Readonly<CustomerPromptTemplateContext> | null,
): string {
  const direction = `本槽位选题角度（必须作为文章主线，不要改写成泛化主题）：${strategy.topicAngle}`;
  const keywordDirection =
    keywordSelection === undefined
      ? ""
      : `本槽位关键词候选池 ${keywordSelection.poolId}：${keywordSelection.keywords.join("｜")}。可自然融入，校验时允许删除不适用、无证据或影响可读性的关键词。`;
  const suffix = keywordDirection.length === 0 ? direction : `${direction}\n${keywordDirection}`;
  const destinationSuffix =
    destinationResource === undefined
      ? ""
      : `\n\n${destinationResourceBrief(destinationResource)}\n\n${GEO_OPTIMIZATION_BRIEF}`;
  const customerBlock =
    customerPrompt == null || customerPrompt.template.trim().length === 0
      ? ""
      : `\n\n<customer_prompt_template>\n${renderCustomerPromptTemplate(
          customerPrompt.template,
          customerPrompt,
        )}\n</customer_prompt_template>`;
  const common = commonBrief
    .trim()
    .slice(
      0,
      Math.max(1, 10_000 - suffix.length - destinationSuffix.length - customerBlock.length - 2),
    );
  return `${common}\n\n${suffix}${destinationSuffix}${customerBlock}`;
}

export function automationSlotTopicKey(
  commonTopicKey: string,
  strategy: Readonly<AutomationDiversityStrategy>,
): string {
  const suffix = `:${strategy.strategyId}`;
  return `${commonTopicKey.slice(0, 200 - suffix.length)}${suffix}`;
}
