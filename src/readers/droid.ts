import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "../core/fs.ts";
import { tokenCount } from "../core/totals.ts";
import type { UsageRecord } from "../core/types.ts";
import type { FileFormat, SourceReader } from "./types.ts";
import { existingHomes, obj, parseJson, projectFromCwd, readFirstLine } from "./util.ts";

const SETTINGS_SUFFIX = ".settings.json";

/**
 * Droid (Factory) saves one running total per session in `<id>.settings.json`. `tokenUsage` is
 * the session's own use; sub-agents have their own session files, so `inclusiveTokenUsage`
 * would count them twice. The record sits on the file's last write time.
 */
export async function parseDroidSettings(file: string): Promise<UsageRecord[]> {
  const settings = parseJson(await readFile(file, "utf8"));
  if (settings === null) return [];
  const usage = obj(settings.tokenUsage);
  const outputTokens = tokenCount(usage.outputTokens);
  const totals = {
    // Droid keeps cache reads and writes apart from input.
    uncachedInputTokens: tokenCount(usage.inputTokens),
    cachedInputTokens: tokenCount(usage.cacheReadTokens),
    cacheCreationTokens: tokenCount(usage.cacheCreationTokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.thinkingTokens)),
  };
  if (totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + outputTokens === 0) return [];
  const sessionId = path.basename(file, SETTINGS_SUFFIX);
  const start = parseJson((await readFirstLine(file.slice(0, -SETTINGS_SUFFIX.length) + ".jsonl")) ?? "");
  const project = projectFromCwd(start?.cwd);
  const credits = usage.factoryCredits;
  return [
    {
      provider: "droid",
      timestampMs: Math.round((await stat(file)).mtimeMs),
      model: typeof settings.model === "string" && settings.model ? settings.model : "unknown",
      sessionId,
      ...(project ? { project } : {}),
      totals,
      reportedCostUsd: null,
      ...(typeof credits === "number" && credits > 0 ? { credits } : {}),
      speed: "standard",
      dedupeKey: sessionId,
      fidelity: "session",
    },
  ];
}

const format: FileFormat = { kind: "file", parseFile: ({ path: file }) => parseDroidSettings(file) };

export const droidReader: SourceReader = {
  tool: "droid",
  fidelity: "session",
  knownFolders: [".factory"],
  format,
  homes: (ctx) => existingHomes(ctx, [{ dir: path.join(ctx.homeDir, ".factory", "sessions") }]),
  files: (home) => walkFiles(home.dir, (name) => name.endsWith(SETTINGS_SUFFIX)),
};
