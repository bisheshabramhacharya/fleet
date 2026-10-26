/**
 * Grok CLI session updates. Parsing ported from T3 Code's provider-grok usage.ts (MIT, T3 Tools Inc.).
 */
import path from "node:path";
import { tokenCount, totalTokens } from "../core/totals.ts";
import type { TokenTotals, UsageRecord } from "../core/types.ts";
import { walkFiles } from "../core/fs.ts";
import type { LineFormat, SourceReader } from "./types.ts";
import { existingHomes, obj, parseJson } from "./util.ts";

const TICKS_PER_DOLLAR = 10_000_000_000;

function ticksToUsd(ticks: unknown): number | null {
  return typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0 ? ticks / TICKS_PER_DOLLAR : null;
}

interface GrokTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  ticks: number | null;
}

function readTotals(value: unknown): GrokTotals | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  return {
    input: tokenCount(r.inputTokens),
    output: tokenCount(r.outputTokens),
    cacheRead: tokenCount(r.cachedReadTokens),
    cacheWrite: tokenCount(r.cacheCreationTokens),
    reasoning: tokenCount(r.reasoningTokens),
    ticks: typeof r.costUsdTicks === "number" && Number.isFinite(r.costUsdTicks) ? r.costUsdTicks : null,
  };
}

function toUsage(t: GrokTotals): TokenTotals {
  // Grok reports input inclusive of the cached portion, like Codex.
  return {
    uncachedInputTokens: Math.max(0, t.input - t.cacheRead - t.cacheWrite),
    cachedInputTokens: t.cacheRead,
    cacheCreationTokens: t.cacheWrite,
    outputTokens: t.output,
    reasoningTokens: Math.min(t.output, t.reasoning),
  };
}

export function parseGrokLine(line: string): UsageRecord[] {
  const record = parseJson(line);
  if (record === null) return [];
  const params = obj(record.params);
  const update = obj(params.update);
  if (update.sessionUpdate !== "turn_completed") return [];
  const usage = update.usage;
  if (typeof usage !== "object" || usage === null) return [];
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
  const promptId = typeof update.prompt_id === "string" ? update.prompt_id : null;
  let timestampMs: number | null = null;
  const agentMs = obj(params._meta).agentTimestampMs;
  if (typeof agentMs === "number" && Number.isFinite(agentMs)) timestampMs = agentMs;
  if (timestampMs === null && typeof record.timestamp === "number") {
    timestampMs = record.timestamp > 1e12 ? record.timestamp : record.timestamp * 1000;
  }
  if (timestampMs === null) return [];
  const top = readTotals(usage);
  if (top === null) return [];

  const entries: { model: string; totals: GrokTotals }[] = [];
  for (const [model, raw] of Object.entries(obj((usage as Record<string, unknown>).modelUsage))) {
    const totals = readTotals(raw);
    if (model.length > 0 && totals !== null) entries.push({ model, totals });
  }
  if (entries.length === 0) {
    if (totalTokens(toUsage(top)) === 0) return [];
    return [
      {
        provider: "grok",
        timestampMs,
        model: "grok",
        sessionId,
        totals: toUsage(top),
        reportedCostUsd: ticksToUsd(top.ticks),
        speed: "standard",
        dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:grok`,
      },
    ];
  }

  const topCost = ticksToUsd(top.ticks);
  let tickedCost = 0;
  let untickedTokens = 0;
  for (const entry of entries) {
    const tokens = totalTokens(toUsage(entry.totals));
    if (tokens === 0) continue;
    if (entry.totals.ticks !== null) tickedCost += ticksToUsd(entry.totals.ticks) ?? 0;
    else untickedTokens += tokens;
  }
  const remaining = topCost === null ? null : Math.max(0, topCost - tickedCost);
  const out: UsageRecord[] = [];
  for (const entry of entries) {
    const totals = toUsage(entry.totals);
    if (totalTokens(totals) === 0) continue;
    let cost = ticksToUsd(entry.totals.ticks);
    if (cost === null && remaining !== null && untickedTokens > 0) cost = remaining * (totalTokens(totals) / untickedTokens);
    out.push({
      provider: "grok",
      timestampMs,
      model: entry.model,
      sessionId,
      totals,
      reportedCostUsd: cost,
      speed: "standard",
      dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${entry.model}`,
    });
  }
  return out;
}

const format: LineFormat<void> = {
  kind: "lines",
  usageMarkers: ['"turn_completed"'],
  parseLine: (line) => parseGrokLine(line),
};

export const grokReader: SourceReader = {
  tool: "grok",
  fidelity: "call",
  knownFolders: [".grok"],
  format,
  homes: (ctx) => {
    const home = ctx.env.GROK_HOME?.trim() || path.join(ctx.homeDir, ".grok");
    return existingHomes(ctx, [{ dir: path.join(home, "sessions") }]);
  },
  // Only updates.jsonl carries usage; skip the large chat history and event logs.
  files: (home) => walkFiles(home.dir, (name) => name === "updates.jsonl"),
};
