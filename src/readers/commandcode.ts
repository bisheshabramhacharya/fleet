import { readFile } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "../core/fs.ts";
import { parseTimestampMs, tokenCount } from "../core/totals.ts";
import type { UsageRecord } from "../core/types.ts";
import type { FileFormat, SourceReader } from "./types.ts";
import { existingHomes, obj, parseJson, projectFromCwd } from "./util.ts";

/**
 * Command Code session logs. Each assistant line carries its own usage and cost. The CLI
 * rewrites whole files, so they are parsed whole rather than resumed by offset.
 */
export function parseCommandCodeLog(source: string): UsageRecord[] {
  let sessionId = "";
  let project: string | undefined;
  const out: UsageRecord[] = [];
  for (const line of source.split("\n")) {
    if (!line.includes('"session"') && !line.includes('"usage"')) continue;
    const entry = parseJson(line);
    if (entry === null) continue;
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      project = projectFromCwd(entry.cwd);
      continue;
    }
    const usage = entry.usage;
    if (typeof usage !== "object" || usage === null) continue;
    const u = usage as Record<string, unknown>;
    const meta = obj(obj(entry.message).meta);
    const timestampMs = parseTimestampMs(meta.createdAt) ?? parseTimestampMs(entry.timestamp);
    if (timestampMs === null) continue;
    const input = tokenCount(u.inputTokens);
    const cacheRead = Math.min(input, tokenCount(u.cacheReadTokens));
    const cacheWrite = Math.min(input - cacheRead, tokenCount(u.cacheWriteTokens));
    const outputTokens = tokenCount(u.outputTokens);
    if (input + outputTokens === 0) continue;
    const cost = u.costUsd;
    const model = typeof entry.model === "string" && entry.model ? entry.model : "unknown";
    out.push({
      provider: "commandcode",
      timestampMs,
      model,
      sessionId,
      ...(project ? { project } : {}),
      totals: {
        // Command Code counts cache reads inside inputTokens.
        uncachedInputTokens: input - cacheRead - cacheWrite,
        cachedInputTokens: cacheRead,
        cacheCreationTokens: cacheWrite,
        outputTokens,
        reasoningTokens: 0,
      },
      reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
      speed: model.endsWith("-fast") ? "fast" : "standard",
      dedupeKey: typeof entry.id === "string" ? `${sessionId}:${entry.id}` : null,
    });
  }
  return out;
}

const format: FileFormat = {
  kind: "file",
  parseFile: async ({ path: file }) => parseCommandCodeLog(await readFile(file, "utf8")),
};

export const commandcodeReader: SourceReader = {
  tool: "commandcode",
  fidelity: "call",
  knownFolders: [".commandcode"],
  format,
  homes: (ctx) => existingHomes(ctx, [{ dir: path.join(ctx.homeDir, ".commandcode", "projects") }]),
  files: (home) =>
    walkFiles(home.dir, (name) => name.endsWith(".jsonl") && !name.endsWith(".checkpoints.jsonl")),
};
