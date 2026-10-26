import { UsageAggregator } from "../core/aggregate.ts";
import { createOverrideRateTable } from "../core/pricing.ts";
import { CONTRACT_VERSION, type ModelPriceOverride, type UsageSummary, type UsageSummaryInput } from "../core/types.ts";
import type { Rates } from "./rates.ts";
import type { HubStore } from "./store.ts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseSummaryInput(params: URLSearchParams): UsageSummaryInput {
  const sinceDay = params.get("since") ?? "";
  const untilDay = params.get("until") ?? "";
  if (!DAY_RE.test(sinceDay) || !DAY_RE.test(untilDay)) throw new Error("since and until must be YYYY-MM-DD");
  const resolution = params.get("resolution") === "hour" ? "hour" : "day";
  const input: UsageSummaryInput = {
    sinceDay,
    untilDay,
    timeZone: params.get("tz") || "UTC",
    resolution,
  };
  if (resolution === "hour") {
    const sinceTime = params.get("sinceTime");
    const untilTime = params.get("untilTime");
    if (!sinceTime || !untilTime || Number.isNaN(Date.parse(sinceTime)) || Number.isNaN(Date.parse(untilTime))) {
      throw new Error("hourly summaries need sinceTime and untilTime");
    }
    return { ...input, sinceTime, untilTime };
  }
  return input;
}

export interface SummaryOptions {
  priceOverrides: Readonly<Record<string, ModelPriceOverride>>;
  modelAliases: Readonly<Record<string, string>>;
}

/** Prices every stored record at query time so price fixes apply to history. */
export function buildSummary(store: HubStore, rates: Rates, input: UsageSummaryInput, options: SummaryOptions): UsageSummary {
  const started = Date.now();
  const aggregator = new UsageAggregator({
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    rates: rates.table,
    priceOverrides: createOverrideRateTable(options.priceOverrides),
    modelAliases: new Map(Object.entries(options.modelAliases)),
    ...(input.resolution === "hour"
      ? { resolution: "hour" as const, sinceTimeMs: Date.parse(input.sinceTime!), untilTimeMs: Date.parse(input.untilTime!) }
      : {}),
  });
  for (const { record, device } of store.records()) aggregator.add(record, device);
  const { buckets } = aggregator.finish();
  return {
    contractVersion: CONTRACT_VERSION,
    readAt: new Date().toISOString(),
    timeZone: input.timeZone,
    sinceDay: input.sinceDay,
    untilDay: input.untilDay,
    buckets,
    sources: store.sources(),
    devices: store.devices(),
    unknownFolders: store.unknownFolders(),
    pricing: rates.info,
    scanDurationMs: Date.now() - started,
  };
}
