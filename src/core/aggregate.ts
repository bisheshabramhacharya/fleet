/**
 * Buckets usage records by day (or hour), tool, model, device and project.
 * Ported from T3 Code's usageAggregation.ts (MIT, T3 Tools Inc.).
 */
import { EMPTY_TOTALS } from "./totals.ts";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./pricing.ts";
import type { TokenTotals, UsageBucket, UsageCategoryCost, UsageRecord, UsageResolution } from "./types.ts";

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// en-CA gives ISO-ordered parts in the requested zone; Date getters are host-local.
export function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", { timeZone, ...options });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", ...options });
  }
  // Cache quarter-hour slots to avoid per-record Intl calls; fixed-offset midnight can split slots and needs exact formatting.
  const days = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = format.format(new Date(slot * QUARTER_HOUR_MS));
      const last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null;
      days.set(slot, day);
    }
    return day ?? format.format(new Date(timestampMs));
  };
}

interface MutableBucket {
  totals: TokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd: UsageCategoryCost | null;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
  credits: number;
  perSession: boolean;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
  /** Leave project out of bucket keys to keep summaries small. */
  readonly groupByProject?: boolean;
}

export interface AggregateResult {
  readonly buckets: UsageBucket[];
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
}

/** Deduplicates across the whole scan; Claude copies records into resumed or forked transcripts. */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
    if (options.resolution === "hour") {
      if (options.sinceTimeMs === undefined || options.untilTimeMs === undefined) {
        throw new Error("Hourly usage aggregation requires exact time bounds");
      }
      this.#hourlyWindow = { sinceTimeMs: options.sinceTimeMs, untilTimeMs: options.untilTimeMs };
    } else {
      this.#hourlyWindow = null;
    }
  }

  add(input: UsageRecord, device: string): boolean {
    const record = this.#mapModel(input);
    if (record.dedupeKey !== null) {
      const key = `${record.provider}\u0000${record.dedupeKey}`;
      if (this.#seen.has(key)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(key);
    }
    const window = this.#hourlyWindow;
    if (window !== null && (record.timestampMs < window.sinceTimeMs || record.timestampMs >= window.untilTimeMs)) {
      this.#outOfWindow += 1;
      return false;
    }
    const day = this.#toDay(record.timestampMs);
    if (window === null && (day < this.#options.sinceDay || day > this.#options.untilDay)) {
      this.#outOfWindow += 1;
      return false;
    }
    const hourIndex = window === null ? -1 : Math.floor((record.timestampMs - window.sinceTimeMs) / HOUR_MS);
    const project = this.#options.groupByProject === false ? "" : (record.project ?? "");
    const bucket = this.#bucketFor(day, hourIndex, record.provider, record.model, device, project);

    const priced = priceUsage(this.#options.rates, record, this.#options.priceOverrides);
    const totals = bucket.totals;
    totals.uncachedInputTokens += record.totals.uncachedInputTokens;
    totals.cachedInputTokens += record.totals.cachedInputTokens;
    totals.cacheCreationTokens += record.totals.cacheCreationTokens;
    totals.outputTokens += record.totals.outputTokens;
    totals.reasoningTokens += record.totals.reasoningTokens;
    bucket.costUsd += priced.costUsd;
    if (priced.categoryCostUsd !== null) {
      const sum = bucket.categoryCostUsd;
      const add = priced.categoryCostUsd;
      bucket.categoryCostUsd =
        sum === null
          ? { ...add }
          : {
              input: sum.input + add.input,
              cacheRead: sum.cacheRead + add.cacheRead,
              cacheWrite: sum.cacheWrite + add.cacheWrite,
              output: sum.output + add.output,
            };
    }
    if (record.speed === "fast") bucket.fastCostUsd += priced.costUsd;
    if (record.speed === "ultrafast") bucket.ultrafastCostUsd += priced.costUsd;
    bucket.speedPremiumUsd += priced.speedPremiumUsd;
    bucket.cacheSavingsUsd += cacheSavingsUsd(this.#options.rates, record, this.#options.priceOverrides);
    bucket.records += 1;
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
    if (record.credits !== undefined) bucket.credits += record.credits;
    if (record.fidelity === "session") bucket.perSession = true;
    return true;
  }

  #mapModel(record: UsageRecord): UsageRecord {
    const model = this.#options.modelAliases?.get(record.model);
    if (model === undefined) return record;
    const { rateModel: _rateModel, ...rest } = record;
    return { ...rest, model };
  }

  #bucketFor(day: string, hourIndex: number, provider: string, model: string, device: string, project: string): MutableBucket {
    const window = this.#hourlyWindow;
    const hourStart = window === null ? "" : new Date(window.sinceTimeMs + hourIndex * HOUR_MS).toISOString();
    const key = [day, hourStart, provider, model, device, project].join("\u0000");
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        totals: { ...EMPTY_TOTALS },
        costUsd: 0,
        cacheSavingsUsd: 0,
        categoryCostUsd: null,
        fastCostUsd: 0,
        ultrafastCostUsd: 0,
        speedPremiumUsd: 0,
        records: 0,
        unpricedRecords: 0,
        providerReportedRecords: 0,
        sessions: new Set<string>(),
        credits: 0,
        perSession: false,
      };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", provider = "", model = "", device = "", project = ""] = key.split("\u0000");
      const category = bucket.categoryCostUsd;
      const fastCostUsd = roundUsd(bucket.fastCostUsd);
      const ultrafastCostUsd = roundUsd(bucket.ultrafastCostUsd);
      const speedPremiumUsd = roundUsd(bucket.speedPremiumUsd);
      buckets.push({
        day,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        device,
        ...(project === "" ? {} : { project }),
        totals: { ...bucket.totals },
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...(category === null
          ? {}
          : {
              categoryCostUsd: {
                input: roundUsd(category.input),
                cacheRead: roundUsd(category.cacheRead),
                cacheWrite: roundUsd(category.cacheWrite),
                output: roundUsd(category.output),
              },
            }),
        ...(fastCostUsd === 0 ? {} : { fastCostUsd }),
        ...(ultrafastCostUsd === 0 ? {} : { ultrafastCostUsd }),
        ...(speedPremiumUsd === 0 ? {} : { speedPremiumUsd }),
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
        ...(bucket.credits === 0 ? {} : { credits: bucket.credits }),
        ...(bucket.perSession ? { fidelity: "session" as const } : {}),
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        a.device.localeCompare(b.device),
    );
    return { buckets, duplicatesDropped: this.#duplicatesDropped, outOfWindow: this.#outOfWindow };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
