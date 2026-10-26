import { readFile } from "node:fs/promises";
import path from "node:path";
import { decompress } from "fzstd";
import { walkFiles } from "../core/fs.ts";
import { tokenCount } from "../core/totals.ts";
import type { UsageRecord } from "../core/types.ts";
import type { FileFormat, SourceReader } from "./types.ts";
import { existingHomes, obj, parseJson, projectFromCwd } from "./util.ts";

/** DeepSeek Harness sessions: zstd-compressed JSONL, one `assistant/message` per model call. */
export function parseDshLog(source: string): UsageRecord[] {
  let sessionId = "";
  let project: string | undefined;
  const out: UsageRecord[] = [];
  for (const line of source.split("\n")) {
    if (!line.includes('"session"') && !line.includes('"assistant/message"')) continue;
    const entry = parseJson(line);
    if (entry === null) continue;
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      project = projectFromCwd(entry.cwd);
      continue;
    }
    if (entry.type !== "assistant/message") continue;
    const data = obj(entry.data);
    const usage = obj(data.usage);
    const message = obj(data.message);
    const source = obj(message.source);
    const timestampMs = typeof entry.time === "number" ? entry.time : null;
    if (timestampMs === null) continue;
    const outputTokens = tokenCount(usage.outputTokens);
    const totals = {
      // DSH keeps cache reads apart from input (input + cache + output = total).
      uncachedInputTokens: tokenCount(usage.inputTokens),
      cachedInputTokens: tokenCount(usage.cacheReadTokens),
      cacheCreationTokens: tokenCount(usage.cacheWriteTokens),
      outputTokens,
      reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
    };
    if (totals.uncachedInputTokens + totals.cachedInputTokens + outputTokens === 0) continue;
    const model = typeof source.model === "string" && source.model ? source.model : "unknown";
    const id = typeof message.id === "string" ? message.id : null;
    out.push({
      provider: "dsh",
      timestampMs,
      model,
      sessionId,
      ...(project ? { project } : {}),
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: id ? `${sessionId}:${id}` : null,
    });
  }
  return out;
}

const format: FileFormat = {
  kind: "file",
  async parseFile({ path: file }) {
    const raw = await readFile(file);
    const bytes = file.endsWith(".zstd") || file.endsWith(".zst") ? decompress(new Uint8Array(raw)) : raw;
    return parseDshLog(Buffer.from(bytes).toString("utf8"));
  },
};

export const dshReader: SourceReader = {
  tool: "dsh",
  fidelity: "call",
  knownFolders: [".dsh"],
  format,
  homes: (ctx) => existingHomes(ctx, [{ dir: path.join(ctx.homeDir, ".dsh", "sessions") }]),
  files: (home) => walkFiles(home.dir, (name) => /^session\.v\d+\.jsonl(\.zstd?)?$/.test(name)),
};
