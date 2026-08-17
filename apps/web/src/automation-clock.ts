const AUTOMATION_TIME_ZONE = "Asia/Shanghai";
const AUTOMATION_TIME_ZONE_OFFSET_MS = 8 * 60 * 60 * 1_000;

function automationDateTimeParts(value: Date): Record<Intl.DateTimeFormatPartTypes, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AUTOMATION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  ) as Record<Intl.DateTimeFormatPartTypes, string>;
}

export function automationDateTimeInput(value: Date): string {
  const parts = automationDateTimeParts(value);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function parseAutomationDateTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return Number.NaN;
  const [, year, month, day, hour, minute] = match;
  const businessTimestamp =
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) -
    AUTOMATION_TIME_ZONE_OFFSET_MS;
  return Number.isNaN(businessTimestamp) ? Number.NaN : businessTimestamp;
}

export function localAutomationDateTime(minutesFromNow = 5, now = Date.now()): string {
  const date = new Date(now + minutesFromNow * 60_000);
  if (date.getSeconds() > 0 || date.getMilliseconds() > 0) {
    date.setMinutes(date.getMinutes() + 1, 0, 0);
  }
  return automationDateTimeInput(date);
}

export function formatAutomationDateTime(value: string | null): string {
  if (value === null) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: AUTOMATION_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}
