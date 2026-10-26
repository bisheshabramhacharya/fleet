import { createHash } from "node:crypto";
import { walkFiles } from "../core/fs.ts";
import { parseTimestampMs, tokenCount } from "../core/totals.ts";
import type { UsageRecord } from "../core/types.ts";
import type { LineFormat, SourceReader } from "./types.ts";
import { parseJson, existingHomes } from "./util.ts";

/**
 * Your own scripts report AI calls by appending one JSON line per call to any `.jsonl` file in
 * the fleet inbox folder:
 *
 *   {"time":"2026-10-26T18:00:00Z","app":"listing-hub","model":"gpt-6.1-sol",
 *    "input":1200,"output":300,"cacheRead":0,"cacheWrite":0,"costUsd":0.004}
 *
 * Only `model` and one token count or cost are required. `time` defaults to now is not
 * allowed: a line without a time is skipped so re-reads never move it.
 */
export function parseInboxLine(line: string): UsageRecord[] {
  const entry = parseJson(line);
  if (entry === null) return [];
  const timestampMs = parseTimestampMs(entry.time ?? entry.timestamp);
  const model = typeof entry.model === "string" ? entry.model.trim() : "";
  if (timestampMs === null || model.length === 0) return [];
  const outputTokens = tokenCount(entry.output ?? entry.outputTokens);
  const totals = {
    uncachedInputTokens: tokenCount(entry.input ?? entry.inputTokens),
    cachedInputTokens: tokenCount(entry.cacheRead ?? entry.cachedInputTokens),
    cacheCreationTokens: tokenCount(entry.cacheWrite ?? entry.cacheCreationTokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(entry.reasoning)),
  };
  const cost = entry.costUsd ?? entry.cost;
  const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : null;
  if (totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + outputTokens === 0 && reportedCostUsd === null) {
    return [];
  }
  const app = typeof entry.app === "string" ? entry.app : typeof entry.tool === "string" ? entry.tool : undefined;
  return [
    {
      provider: "inbox",
      timestampMs,
      model,
      sessionId: typeof entry.session === "string" ? entry.session : (app ?? ""),
      ...(app ? { project: app } : typeof entry.project === "string" ? { project: entry.project } : {}),
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: typeof entry.id === "string" ? entry.id : createHash("sha1").update(line).digest("hex"),
    },
  ];
}

const format: LineFormat<void> = { kind: "lines", parseLine: (line) => parseInboxLine(line) };

/** The inbox folder is passed in because it lives in fleet's own data folder. */
export function makeInboxReader(inboxDir: string): SourceReader {
  return {
    tool: "inbox",
    fidelity: "call",
    format,
    homes: (ctx) => existingHomes({ ...ctx, customHomes: [] }, [{ dir: inboxDir }]),
    files: (home) => walkFiles(home.dir, (name) => name.endsWith(".jsonl")),
  };
}
