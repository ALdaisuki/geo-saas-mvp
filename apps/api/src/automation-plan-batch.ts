import { sha256Canonical } from "@geo/core";

import type {
  CreateAutomationBatchInput,
  DueCampaignAutomationPlanView,
} from "./automation-repository.js";

export interface BuildAutomationPlanBatchOptions {
  readonly plan: DueCampaignAutomationPlanView;
  readonly scheduledAt: string;
  readonly uuid: () => string;
  readonly idempotencyKey?: string;
  readonly name?: string;
}

export function buildAutomationPlanBatchInput(
  options: BuildAutomationPlanBatchOptions,
): CreateAutomationBatchInput {
  const plan = options.plan;
  const scheduledFor = Date.parse(options.scheduledAt);
  if (!Number.isFinite(scheduledFor)) {
    throw new TypeError("Campaign automation plan scheduled time is invalid");
  }
  const batchId = options.uuid();
  const idempotencyKey =
    options.idempotencyKey ?? `campaign-automation-plan:v1:${plan.planId}:${plan.nextRunAt}`;
  const requestMaterial = {
    schemaVersion: "geo.campaign-automation-plan-batch.v1",
    planId: plan.planId,
    campaignId: plan.campaignId,
    platforms: plan.platforms,
    executionLevel: plan.executionLevel,
    slotCount: plan.slotCount,
    intervalMinutes: plan.intervalMinutes,
  } as const;
  const runs = Array.from({ length: plan.slotCount }, (_, offset) => {
    const runId = options.uuid();
    const targets = plan.platforms.map(() => {
      const targetId = options.uuid();
      return {
        targetId,
        channelAccountId: null as string | null,
        variantIdempotencyKey: `automation:${runId}:target:${targetId}:variant:v1`,
        auditIdempotencyKey: `automation:${runId}:target:${targetId}:audit:v1`,
        publicationIdempotencyKey: `automation:${runId}:target:${targetId}:publication:v1`,
      };
    });
    return {
      runId,
      slotKey: `plan-slot-${String(offset + 1).padStart(3, "0")}`,
      topicKey: plan.campaignTopicKey,
      brief: campaignPlanBrief(plan),
      availableAt: new Date(scheduledFor + offset * plan.intervalMinutes * 60_000).toISOString(),
      idempotencyKey: `automation:${runId}:run:v1`,
      requestHash: sha256Canonical({ ...requestMaterial, offset }),
      targets,
    };
  });
  return {
    batchId,
    campaignId: plan.campaignId,
    idempotencyKey,
    requestHash: sha256Canonical({ ...requestMaterial, idempotencyKey }),
    name: options.name ?? `自动投放 · ${plan.campaignName}`,
    executionLevel: plan.executionLevel,
    distribution: {
      mode: "platforms_round_robin",
      platforms: [...plan.platforms],
    },
    runs,
  };
}

export function nextCampaignAutomationRunAt(
  plan: Pick<DueCampaignAutomationPlanView, "intervalMinutes" | "dailyTimes" | "timezone">,
  after: Date = new Date(),
): string {
  const afterMs = after.getTime();
  const intervalMs = plan.intervalMinutes * 60_000;
  if (plan.dailyTimes.length === 0) {
    return new Date(afterMs + intervalMs).toISOString();
  }
  const nowParts = timeZoneParts(plan.timezone, afterMs);
  const today = `${nowParts.year}-${pad2(nowParts.month)}-${pad2(nowParts.day)}`;
  const sortedTimes = [...plan.dailyTimes].sort();
  for (const dayOffset of [0, 1, 2]) {
    const localDate = addDays(today, dayOffset);
    for (const time of sortedTimes) {
      const candidate = zonedTimestamp(localDate, time, plan.timezone);
      if (candidate > afterMs) return new Date(candidate).toISOString();
    }
  }
  return new Date(afterMs + intervalMs).toISOString();
}

function campaignPlanBrief(plan: DueCampaignAutomationPlanView): string {
  return `依据推广计划“${plan.campaignName}”主题“${plan.campaignTopicKey}”与目标“${plan.campaignObjective}”创作原创文章；保持受众、事实和推广目标一致，文章模板、目的地资源、读者切入、正文结构和行动引导由服务端按槽位绑定。`;
}

function timeZoneParts(
  timeZone: string,
  utcMs: number,
): { readonly year: number; readonly month: number; readonly day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcMs);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
  };
}

function timeZoneOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcMs);
  const value = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

function zonedTimestamp(localDate: string, time: string, timeZone: string): number {
  const [yearText, monthText, dayText] = localDate.split("-");
  const [hourText, minuteText] = time.split(":");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (![year, month, day, hour, minute].every(Number.isFinite)) {
    throw new TypeError("Campaign automation plan time is invalid");
  }
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(naive)) throw new TypeError("Campaign automation plan time is invalid");
  const offset = timeZoneOffsetMinutes(timeZone, naive);
  const candidate = naive - offset * 60_000;
  const corrected = timeZoneOffsetMinutes(timeZone, candidate);
  return corrected === offset ? candidate : naive - corrected * 60_000;
}

function addDays(localDate: string, offset: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new TypeError("Campaign automation plan local date is invalid");
  }
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
