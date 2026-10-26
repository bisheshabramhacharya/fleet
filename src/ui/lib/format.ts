/** Number and date formats ported from T3 Code's usageFormat.ts (MIT, T3 Tools Inc.). */
const CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INTEGER = new Intl.NumberFormat("en-US");
const HOUR_MS = 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${percent.toFixed(digits)}%`;
}

export function formatDayShort(day: string): string {
  const [, month, dayOfMonth] = day.split("-").map(Number);
  if (!month || !dayOfMonth) return day;
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}

export function enumerateDays(sinceDay: string, untilDay: string): string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;
  for (let cursor = start; cursor <= end; cursor += 86_400_000) days.push(new Date(cursor).toISOString().slice(0, 10));
  return days;
}

export function enumerateHourStarts(sinceTime: string, untilTime: string): string[] {
  const starts: string[] = [];
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  for (let cursor = start; cursor < end; cursor += HOUR_MS) starts.push(new Date(cursor).toISOString());
  return starts;
}

export function formatHourShort(hourStart: string, timeZone?: string): string {
  const date = new Date(hourStart);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", ...(timeZone ? { timeZone } : {}) }).format(date);
}

export function formatDateTimeShort(instant: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", ...(timeZone ? { timeZone } : {}) }).format(new Date(instant));
}

export function formatRelative(instant: string | number | null | undefined): string {
  if (instant === null || instant === undefined) return "never";
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  if (Number.isNaN(ms)) return "unknown";
  const diff = Date.now() - ms;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let text: string;
  if (mins < 1) text = "just now";
  else if (mins < 60) text = `${mins}m`;
  else if (mins < 48 * 60) text = `${Math.round(mins / 60)}h`;
  else text = `${Math.round(mins / 1440)}d`;
  if (text === "just now") return text;
  return future ? `in ${text}` : `${text} ago`;
}

export interface UsageWindow {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  resolution: "day" | "hour";
  sinceTime?: string;
  untilTime?: string;
}

export function makeWindow(days: number, now = new Date()): UsageWindow {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const untilDay = format.format(now);
  if (days === 1) {
    const untilMs = Math.floor(now.getTime() / 60_000) * 60_000;
    const sinceMs = untilMs - 24 * HOUR_MS;
    return {
      sinceDay: format.format(new Date(sinceMs)),
      untilDay: format.format(new Date(untilMs)),
      timeZone,
      resolution: "hour",
      sinceTime: new Date(sinceMs).toISOString(),
      untilTime: new Date(untilMs).toISOString(),
    };
  }
  const [y = 0, m = 1, d = 1] = untilDay.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d - (days - 1)));
  return { sinceDay: start.toISOString().slice(0, 10), untilDay, timeZone, resolution: "day" };
}

/** A window from `sinceDay` to `untilDay` inclusive, for the custom range picker. */
export function customWindow(sinceDay: string, untilDay: string): UsageWindow {
  return { sinceDay, untilDay, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", resolution: "day" };
}
