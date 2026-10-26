/**
 * Pi and oh-my-pi session logs. Parsing ported from T3 Code's provider-pi usage.ts (MIT, T3 Tools Inc.).
 */
import path from "node:path";
import { parseTimestampMs, tokenCount, totalTokens } from "../core/totals.ts";
import type { ToolId, UsageRecord } from "../core/types.ts";
import type { FileContext, LineFormat, SourceReader } from "./types.ts";
import { existingHomes, jsonlFiles, obj, parseJson, projectFromCwd } from "./util.ts";

interface PiState {
  sessionId: string;
  project: string;
}

function sessionFromFile(file: string): string {
  const base = path.basename(file, ".jsonl");
  const underscore = base.lastIndexOf("_");
  return underscore === -1 ? base : base.slice(underscore + 1);
}

function makeParser(tool: ToolId) {
  return (line: string, state: PiState, file: FileContext): UsageRecord[] => {
    const entry = parseJson(line);
    if (entry === null) return [];
    if (entry.type === "session") {
      if (typeof entry.id === "string") state.sessionId = entry.id;
      state.project = projectFromCwd(entry.cwd) ?? state.project;
      return [];
    }
    if (typeof entry.id !== "string" || typeof entry.timestamp !== "string") return [];
    const timestampMs = parseTimestampMs(entry.timestamp);
    if (timestampMs === null) return [];
    let source: Record<string, unknown>;
    if (entry.type === "message") {
      source = obj(entry.message);
      if (source.role !== "assistant" && source.role !== "toolResult") return [];
    } else if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
      source = entry;
    } else {
      return [];
    }
    const usage = source.usage;
    if (typeof usage !== "object" || usage === null) return [];
    const u = usage as Record<string, unknown>;
    const hasModel = typeof source.provider === "string" && typeof source.model === "string";
    const rateModel = hasModel ? (typeof source.responseModel === "string" ? source.responseModel : (source.model as string)) : undefined;
    // Auxiliary tool/summary records lack model attribution; match Pi's own breakdown.
    const model = hasModel ? `${source.provider as string}/${rateModel}` : "Tools/summaries";
    const outputTokens = tokenCount(u.output);
    const totals = {
      // Pi's input and cache counters are already disjoint.
      uncachedInputTokens: tokenCount(u.input),
      cachedInputTokens: tokenCount(u.cacheRead),
      cacheCreationTokens: tokenCount(u.cacheWrite),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, tokenCount(u.reasoning ?? u.reasoningTokens)),
    };
    const cost = obj(u.cost).total;
    // Omitted Pi rates default to zero; use shared estimates without a positive transcript cost.
    const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
    if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
    const sessionId = state.sessionId || sessionFromFile(file.path);
    return [
      {
        provider: tool,
        timestampMs,
        model,
        ...(rateModel === undefined ? {} : { rateModel }),
        sessionId,
        ...(state.project ? { project: state.project } : {}),
        totals,
        reportedCostUsd,
        speed: "standard",
        // Forks keep IDs and timestamps; short random IDs need time and model to stay unique.
        dedupeKey: JSON.stringify([tool, entry.id, entry.timestamp, model]),
      },
    ];
  };
}

function piFormat(tool: ToolId): LineFormat<PiState> {
  return {
    kind: "lines",
    usageMarkers: ['"usage"', '"session"'],
    initialState: () => ({ sessionId: "", project: "" }),
    parseLine: makeParser(tool),
  };
}

export const piReader: SourceReader = {
  tool: "pi",
  fidelity: "call",
  knownFolders: [".pi"],
  format: piFormat("pi"),
  homes: (ctx) => {
    const sessionDir = ctx.env.PI_CODING_AGENT_SESSION_DIR?.trim();
    const agentDir = ctx.env.PI_CODING_AGENT_DIR?.trim();
    return existingHomes(ctx, [
      ...(sessionDir ? [{ dir: sessionDir }] : []),
      { dir: path.join(agentDir || path.join(ctx.homeDir, ".pi", "agent"), "sessions") },
    ]);
  },
  files: (home) => jsonlFiles(home.dir),
};

export const ompReader: SourceReader = {
  tool: "omp",
  fidelity: "call",
  knownFolders: [".omp"],
  format: piFormat("omp"),
  homes: (ctx) => existingHomes(ctx, [{ dir: path.join(ctx.homeDir, ".omp", "agent", "sessions") }]),
  files: (home) => jsonlFiles(home.dir),
};
