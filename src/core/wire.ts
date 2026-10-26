import { isToolId, type Fidelity, type UsageRecord, type UsageSpeed } from "./types.ts";

/**
 * Compact array form of a usage record for disk and the wire:
 * [time, provider, model, rateModel, session, project, uncached, cached, cacheWrite,
 *  output, reasoning, reportedCost, credits, speed, dedupeKey, fidelity]
 */
export type WireRecord = [
  number,
  string,
  string,
  string | null,
  string,
  string | null,
  number,
  number,
  number,
  number,
  number,
  number | null,
  number | null,
  0 | 1 | 2,
  string | null,
  0 | 1,
];

const SPEEDS: UsageSpeed[] = ["standard", "fast", "ultrafast"];

export function encodeRecord(r: UsageRecord): WireRecord {
  return [
    r.timestampMs,
    r.provider,
    r.model,
    r.rateModel ?? null,
    r.sessionId,
    r.project ?? null,
    r.totals.uncachedInputTokens,
    r.totals.cachedInputTokens,
    r.totals.cacheCreationTokens,
    r.totals.outputTokens,
    r.totals.reasoningTokens,
    r.reportedCostUsd,
    r.credits ?? null,
    r.speed === "fast" ? 1 : r.speed === "ultrafast" ? 2 : 0,
    r.dedupeKey,
    r.fidelity === "session" ? 1 : 0,
  ];
}

export function decodeRecord(w: unknown): UsageRecord | null {
  if (!Array.isArray(w) || w.length < 16) return null;
  const provider = w[1];
  if (!isToolId(provider) || typeof w[0] !== "number" || typeof w[2] !== "string") return null;
  const fidelity: Fidelity = w[15] === 1 ? "session" : "call";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    timestampMs: w[0],
    provider,
    model: w[2],
    ...(typeof w[3] === "string" ? { rateModel: w[3] } : {}),
    sessionId: typeof w[4] === "string" ? w[4] : "",
    ...(typeof w[5] === "string" ? { project: w[5] } : {}),
    totals: {
      uncachedInputTokens: num(w[6]),
      cachedInputTokens: num(w[7]),
      cacheCreationTokens: num(w[8]),
      outputTokens: num(w[9]),
      reasoningTokens: num(w[10]),
    },
    reportedCostUsd: typeof w[11] === "number" ? w[11] : null,
    ...(typeof w[12] === "number" ? { credits: w[12] } : {}),
    speed: SPEEDS[w[13] as number] ?? "standard",
    dedupeKey: typeof w[14] === "string" ? w[14] : null,
    ...(fidelity === "session" ? { fidelity } : {}),
  };
}
