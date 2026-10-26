/**
 * Claude Code transcripts. Parsing ported from T3 Code's claudeUsage.ts (MIT, T3 Tools Inc.).
 */
import path from "node:path";
import { parseTimestampMs, tokenCount } from "../core/totals.ts";
import type { UsageRecord } from "../core/types.ts";
import type { LineFormat, SourceReader } from "./types.ts";
import { existingHomes, jsonlFiles, obj, parseJson, projectFromCwd } from "./util.ts";

// Claude Code uses this model for local placeholders that never reached the API.
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Claude writes one line per assistant content block, and each repeats the full usage of the
 * parent message. The dedupe key lets the aggregator keep only the first.
 */
export function parseClaudeLine(line: string): UsageRecord[] {
  const record = parseJson(line);
  if (record === null || record.type !== "assistant") return [];
  const message = obj(record.message);
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return [];
  const u = usage as Record<string, unknown>;
  const timestampMs = parseTimestampMs(record.timestamp);
  if (timestampMs === null) return [];
  const model = typeof message.model === "string" ? message.model : "";
  if (model.length === 0 || model === SYNTHETIC_MODEL) return [];
  const messageId = typeof message.id === "string" ? message.id : null;
  const requestId = typeof record.requestId === "string" ? record.requestId : null;
  const cost = record.costUSD;
  const project = projectFromCwd(record.cwd);
  return [
    {
      provider: "claude",
      timestampMs,
      model,
      sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
      ...(project ? { project } : {}),
      totals: {
        uncachedInputTokens: tokenCount(u.input_tokens),
        cachedInputTokens: tokenCount(u.cache_read_input_tokens),
        cacheCreationTokens: tokenCount(u.cache_creation_input_tokens),
        outputTokens: tokenCount(u.output_tokens),
        // Anthropic folds thinking into output and does not break it out.
        reasoningTokens: 0,
      },
      reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      speed: u.speed === "fast" ? "fast" : "standard",
      dedupeKey: messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`,
    },
  ];
}

const format: LineFormat<void> = {
  kind: "lines",
  usageMarkers: ['"usage"'],
  parseLine: (line) => parseClaudeLine(line),
};

export const claudeReader: SourceReader = {
  tool: "claude",
  fidelity: "call",
  knownFolders: [".claude"],
  format,
  homes: (ctx) => {
    const configured = ctx.env.CLAUDE_CONFIG_DIR?.trim();
    return existingHomes(ctx, [
      ...(configured ? [{ dir: path.join(configured, "projects") }] : []),
      { dir: path.join(ctx.homeDir, ".claude", "projects") },
      { dir: path.join(ctx.homeDir, ".config", "claude", "projects") },
    ]);
  },
  files: (home) => jsonlFiles(home.dir),
};
