/**
 * Turns hub buckets into the totals the usage page shows, after device/tool/project filters.
 * Shapes follow T3 Code's usageMerge.ts (MIT, T3 Tools Inc.).
 */
import { TOOL_IDS, type ToolId, type UsageBucket, type UsageSummary } from "../../core/types.ts";

export interface Filters {
  devices: ReadonlySet<string> | null;
  tools: ReadonlySet<ToolId> | null;
  projects: ReadonlySet<string> | null;
}

export const NO_FILTERS: Filters = { devices: null, tools: null, projects: null };

export interface TokenMix {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface Totals extends TokenMix {
  costUsd: number;
  totalTokens: number;
  sessions: number;
  records: number;
  unpricedRecords: number;
  unpricedTokens: number;
  credits: number;
  cacheSavingsUsd: number;
  perSession: boolean;
}

export interface ProviderTotals extends Totals {
  provider: ToolId;
  costShare: number;
  tokenShare: number;
}

export interface ModelTotals extends Totals {
  provider: ToolId;
  model: string;
  costShare: number;
  tokenShare: number;
  costSource: "providerReported" | "modelPriced" | "unpriced" | "mixed";
}

export interface PeriodTotals extends Totals {
  period: string;
  byProvider: Map<ToolId, Totals>;
}

export interface GroupRow extends Totals {
  key: string;
  label: string;
  provider?: ToolId;
  costShare: number;
  tokenShare: number;
}

export interface CategoryCost {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  unsplit: number;
}

export interface Merged extends Totals {
  providers: ProviderTotals[];
  models: ModelTotals[];
  periods: PeriodTotals[];
  categoryCost: CategoryCost;
  speedCost: { standard: number; fast: number; ultrafast: number; premium: number };
  unpricedShare: number;
  projects: string[];
  buckets: UsageBucket[];
}

export function emptyTotals(): Totals {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    totalTokens: 0,
    sessions: 0,
    records: 0,
    unpricedRecords: 0,
    unpricedTokens: 0,
    credits: 0,
    cacheSavingsUsd: 0,
    perSession: false,
  };
}

export function bucketTokens(b: UsageBucket): number {
  return b.totals.uncachedInputTokens + b.totals.cachedInputTokens + b.totals.cacheCreationTokens + b.totals.outputTokens;
}

function addBucket(t: Totals, b: UsageBucket) {
  const tokens = bucketTokens(b);
  t.uncachedInputTokens += b.totals.uncachedInputTokens;
  t.cachedInputTokens += b.totals.cachedInputTokens;
  t.cacheCreationTokens += b.totals.cacheCreationTokens;
  t.outputTokens += b.totals.outputTokens;
  t.reasoningTokens += b.totals.reasoningTokens;
  t.totalTokens += tokens;
  t.costUsd += b.costUsd;
  t.sessions += b.sessions;
  t.records += b.records;
  t.unpricedRecords += b.unpricedRecords;
  if (b.records > 0) t.unpricedTokens += tokens * (b.unpricedRecords / b.records);
  t.credits += b.credits ?? 0;
  t.cacheSavingsUsd += b.cacheSavingsUsd;
  if (b.fidelity === "session") t.perSession = true;
}

export function filterBuckets(summary: UsageSummary, filters: Filters): UsageBucket[] {
  return summary.buckets.filter(
    (b) =>
      (filters.devices === null || filters.devices.has(b.device)) &&
      (filters.tools === null || filters.tools.has(b.provider)) &&
      (filters.projects === null || filters.projects.has(b.project ?? "")),
  );
}

export function merge(summary: UsageSummary, filters: Filters): Merged {
  const buckets = filterBuckets(summary, filters);
  const total = emptyTotals();
  const providers = new Map<ToolId, Totals>();
  const models = new Map<string, Totals & { provider: ToolId; model: string; sources: Set<string> }>();
  const periods = new Map<string, PeriodTotals>();
  const category: CategoryCost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 };
  const speed = { standard: 0, fast: 0, ultrafast: 0, premium: 0 };
  const projects = new Set<string>();

  for (const b of buckets) {
    addBucket(total, b);
    let p = providers.get(b.provider);
    if (!p) providers.set(b.provider, (p = emptyTotals()));
    addBucket(p, b);
    const mk = `${b.provider}:${b.model}`;
    let m = models.get(mk);
    if (!m) models.set(mk, (m = { ...emptyTotals(), provider: b.provider, model: b.model, sources: new Set() }));
    addBucket(m, b);
    m.sources.add(b.costSource);
    const key = b.hourStart ?? b.day;
    let period = periods.get(key);
    if (!period) periods.set(key, (period = { ...emptyTotals(), period: key, byProvider: new Map() }));
    addBucket(period, b);
    let pp = period.byProvider.get(b.provider);
    if (!pp) period.byProvider.set(b.provider, (pp = emptyTotals()));
    addBucket(pp, b);
    if (b.categoryCostUsd) {
      category.input += b.categoryCostUsd.input;
      category.cacheRead += b.categoryCostUsd.cacheRead;
      category.cacheWrite += b.categoryCostUsd.cacheWrite;
      category.output += b.categoryCostUsd.output;
      category.unsplit += b.costUsd - (b.categoryCostUsd.input + b.categoryCostUsd.cacheRead + b.categoryCostUsd.cacheWrite + b.categoryCostUsd.output);
    } else {
      category.unsplit += b.costUsd;
    }
    speed.fast += b.fastCostUsd ?? 0;
    speed.ultrafast += b.ultrafastCostUsd ?? 0;
    speed.premium += b.speedPremiumUsd ?? 0;
    if (b.project) projects.add(b.project);
  }
  speed.standard = total.costUsd - speed.fast - speed.ultrafast;
  const share = (v: number, of: number) => (of > 0 ? v / of : 0);

  const providerList: ProviderTotals[] = TOOL_IDS.filter((id) => providers.has(id)).map((id) => {
    const t = providers.get(id)!;
    return { ...t, provider: id, costShare: share(t.costUsd, total.costUsd), tokenShare: share(t.totalTokens, total.totalTokens) };
  });
  providerList.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const modelList: ModelTotals[] = [...models.values()]
    .map(({ sources, ...m }) => ({
      ...m,
      costShare: share(m.costUsd, total.costUsd),
      tokenShare: share(m.totalTokens, total.totalTokens),
      costSource: (sources.size === 1 ? [...sources][0] : "mixed") as ModelTotals["costSource"],
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  return {
    ...total,
    providers: providerList,
    models: modelList,
    periods: [...periods.values()].sort((a, b) => a.period.localeCompare(b.period)),
    categoryCost: category,
    speedCost: speed,
    unpricedShare: share(total.unpricedTokens, total.totalTokens),
    projects: [...projects].sort(),
    buckets,
  };
}

export type GroupBy = "model" | "day" | "device" | "project" | "tool";

export function groupRows(merged: Merged, by: GroupBy, deviceNames: Map<string, string>, toolLabel: (t: ToolId) => string): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  for (const b of merged.buckets) {
    let key: string;
    let label: string;
    let provider: ToolId | undefined;
    switch (by) {
      case "model":
        key = `${b.provider}:${b.model}`;
        label = b.model;
        provider = b.provider;
        break;
      case "day":
        key = b.hourStart ?? b.day;
        label = key;
        break;
      case "device":
        key = b.device;
        label = deviceNames.get(b.device) ?? b.device.slice(0, 8);
        break;
      case "project":
        key = b.project ?? "";
        label = b.project ?? "(no project)";
        break;
      case "tool":
        key = b.provider;
        label = toolLabel(b.provider);
        provider = b.provider;
        break;
    }
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { ...emptyTotals(), key, label, ...(provider ? { provider } : {}), costShare: 0, tokenShare: 0 }));
    addBucket(row, b);
  }
  const out = [...rows.values()];
  for (const row of out) {
    row.costShare = merged.costUsd > 0 ? row.costUsd / merged.costUsd : 0;
    row.tokenShare = merged.totalTokens > 0 ? row.totalTokens / merged.totalTokens : 0;
  }
  if (by === "day") out.sort((a, b) => b.key.localeCompare(a.key));
  else out.sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
  return out;
}

export function isCostUnknown(t: Totals): boolean {
  return t.records > 0 && t.unpricedRecords === t.records;
}
