/**
 * Codex rollout transcripts. Parsing ported from T3 Code's codexUsage.ts (MIT, T3 Tools Inc.).
 * Fleet reads every Codex home on the device (~/.codex, ~/.codex-*, $CODEX_HOME) and both the
 * live and archived session folders.
 */
import path from "node:path";
import { parseTimestampMs, totalTokens } from "../core/totals.ts";
import type { TokenTotals, UsageRecord, UsageSpeed } from "../core/types.ts";
import type { LineFormat, SourceHome, SourceReader } from "./types.ts";
import { existingHomes, homeFolders, jsonlFiles, parseJson, projectFromCwd } from "./util.ts";

interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

const FIELDS: (keyof CodexTokenUsage)[] = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function readUsage(value: unknown): CodexTokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  const usage = {
    input_tokens: input,
    cached_input_tokens: raw.cached_input_tokens ?? 0,
    cache_write_input_tokens: raw.cache_write_input_tokens ?? 0,
    output_tokens: output,
    reasoning_output_tokens: raw.reasoning_output_tokens ?? 0,
    total_tokens: raw.total_tokens ?? input + output,
  } as Record<keyof CodexTokenUsage, unknown>;
  if (!FIELDS.every((key) => isCount(usage[key]))) return null;
  const u = usage as unknown as CodexTokenUsage;
  if (u.cached_input_tokens + u.cache_write_input_tokens > u.input_tokens) return null;
  if (u.reasoning_output_tokens > u.output_tokens) return null;
  if (u.total_tokens < u.input_tokens + u.output_tokens) return null;
  return u;
}

function advance(previous: CodexTokenUsage | null, last: CodexTokenUsage): CodexTokenUsage | null {
  return readUsage(Object.fromEntries(FIELDS.map((key) => [key, (previous?.[key] ?? 0) + last[key]])));
}

export interface CodexScanState {
  model: string;
  speed: UsageSpeed;
  sessionId: string;
  project: string;
  lastUsageSignature: string | null;
  lastCumulativeUsage: CodexTokenUsage | null;
  malformedRecords: number;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexState(): CodexScanState {
  return {
    model: "",
    speed: "standard",
    sessionId: "",
    project: "",
    lastUsageSignature: null,
    lastCumulativeUsage: null,
    malformedRecords: 0,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/** Forks copy and restamp parent history in a burst (0-40ms gaps); real child usage follows a model turn. */
const FORK_COPY_MAX_GAP_MS = 1000;

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload.forked_from_id === "string") return true;
  const source = payload.source as Record<string, unknown> | undefined;
  const subagent = source?.subagent as Record<string, unknown> | undefined;
  const spawn = subagent?.thread_spawn as Record<string, unknown> | undefined;
  return typeof spawn?.parent_thread_id === "string";
}

function codexSpeed(tier: unknown): UsageSpeed {
  if (tier === "priority" || tier === "fast") return "fast";
  if (tier === "ultrafast") return "ultrafast";
  return "standard";
}

/** Cumulative counters validate request deltas; older events fall back to consecutive-repeat dedupe. */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord[] {
  const record = parseJson(line);
  if (record === null) return [];
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return [];
  const p = payload as Record<string, unknown>;

  if (record.type === "session_meta") {
    // Only the first meta identifies the session; copied ancestor metas would misattribute.
    if (state.sawSessionMeta) return [];
    state.sawSessionMeta = true;
    const id = p.id ?? p.session_id;
    if (typeof id === "string") state.sessionId = id;
    state.project = projectFromCwd(p.cwd) ?? "";
    const metaMs = parseTimestampMs(record.timestamp);
    if (metaMs !== null && isForkedSessionMeta(p)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaMs;
    }
    return [];
  }
  if (record.type === "turn_context") {
    if (typeof p.model === "string") state.model = p.model;
    if (!state.project) state.project = projectFromCwd(p.cwd) ?? "";
    return [];
  }
  if (p.type === "thread_settings_applied") {
    const settings = p.thread_settings as Record<string, unknown> | undefined;
    if (settings) state.speed = codexSpeed(settings.service_tier);
    return [];
  }
  if (p.type !== "token_count") return [];

  const info = p.info as Record<string, unknown> | undefined;
  if (typeof info !== "object" || info === null) return [];
  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null || state.model.length === 0) return [];

  const last = readUsage(info.last_token_usage);
  const rawCumulative = info.total_token_usage;
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readUsage(rawCumulative) : null;

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      const signature = last === null ? null : JSON.stringify(last);
      if (cumulative !== null) state.lastCumulativeUsage = cumulative;
      else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
        state.lastCumulativeUsage = advance(state.lastCumulativeUsage, last);
      }
      state.lastUsageSignature = signature;
      return [];
    }
    state.suppressingForkCopies = false;
    state.lastUsageSignature = null;
  }

  const previous = state.lastCumulativeUsage;
  if (cumulative !== null) state.lastCumulativeUsage = cumulative;
  if (last === null || (hasCumulative && cumulative === null)) {
    state.malformedRecords += 1;
    return [];
  }
  // Zero-component counters report context size, not a request.
  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return [];
  }
  if (cumulative !== null && previous !== null && FIELDS.every((key) => cumulative[key] === previous[key])) return [];
  if (last.total_tokens !== last.input_tokens + last.output_tokens) {
    state.malformedRecords += 1;
    return [];
  }

  const signature = JSON.stringify(last);
  if (cumulative !== null) {
    const restarted = FIELDS.every((key) => cumulative[key] === last[key]);
    const reconciled =
      previous === null
        ? readUsage(Object.fromEntries(FIELDS.map((key) => [key, cumulative[key] - last[key]]))) !== null
        : FIELDS.every((key) => cumulative[key] - previous[key] === last[key]);
    if (!restarted && !reconciled) {
      state.malformedRecords += 1;
      return [];
    }
  } else {
    if (signature === state.lastUsageSignature) return [];
    const advanced = advance(previous, last);
    if (advanced === null) {
      state.malformedRecords += 1;
      return [];
    }
    state.lastCumulativeUsage = advanced;
  }
  state.lastUsageSignature = signature;

  const totals: TokenTotals = {
    // Codex reports input_tokens inclusive of the cached portion.
    uncachedInputTokens: last.input_tokens - last.cached_input_tokens - last.cache_write_input_tokens,
    cachedInputTokens: last.cached_input_tokens,
    cacheCreationTokens: last.cache_write_input_tokens,
    outputTokens: last.output_tokens,
    reasoningTokens: last.reasoning_output_tokens,
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "codex",
      timestampMs,
      model: state.model,
      sessionId: state.sessionId,
      ...(state.project ? { project: state.project } : {}),
      totals,
      reportedCostUsd: null,
      speed: state.speed,
      // An archived rollout can also still sit in sessions/; the key counts it once.
      dedupeKey: state.sessionId ? `${state.sessionId}:${timestampMs}:${signature}` : null,
    },
  ];
}

const format: LineFormat<CodexScanState> = {
  kind: "lines",
  usageMarkers: ['"token_count"', '"turn_context"', '"thread_settings_applied"', '"session_meta"'],
  initialState: initialCodexState,
  parseLine: (line, state) => parseCodexLine(line, state),
};

export const codexReader: SourceReader = {
  tool: "codex",
  fidelity: "call",
  knownFolders: [".codex"],
  format,
  homes: async (ctx) => {
    const roots = new Set<string>();
    const env = ctx.env.CODEX_HOME?.trim();
    if (env) roots.add(env);
    roots.add(path.join(ctx.homeDir, ".codex"));
    for (const dir of await homeFolders(ctx, /^\.codex-[\w.-]+$/)) roots.add(dir);
    const candidates: SourceHome[] = [];
    for (const root of roots) {
      const name = path.basename(root);
      const label = name === ".codex" ? undefined : name.replace(/^\./, "");
      for (const sub of ["sessions", "archived_sessions"]) {
        candidates.push({ dir: path.join(root, sub), ...(label ? { label } : {}) });
      }
    }
    return existingHomes(ctx, candidates);
  },
  files: (home) => jsonlFiles(home.dir),
};
