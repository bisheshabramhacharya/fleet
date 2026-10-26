/**
 * OpenCode message history (SQLite plus the legacy JSON message store). Parsing ported from
 * T3 Code's provider-opencode usage.ts (MIT, T3 Tools Inc.).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "../core/fs.ts";
import { tokenCount, totalTokens } from "../core/totals.ts";
import type { UsageRecord } from "../core/types.ts";
import type { FileFormat, SourceReader } from "./types.ts";
import { withSqlite } from "./sqlite.ts";
import { existingHomes, obj, projectFromCwd, xdgDataHome } from "./util.ts";

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function parseOpenCodeMessage(
  source: string,
  fallback: { id?: string; sessionId?: string; timestampMs?: number; project?: string } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = obj(parsed);
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = obj(message.tokens);
  const cache = obj(usage.cache);
  const modelRef = obj(message.model);
  const model = text(modelRef.id) || text(modelRef.modelID) || text(message.modelID);
  const created = obj(message.time).created ?? fallback.timestampMs;
  if (!model || typeof created !== "number" || !Number.isFinite(created)) return null;
  const reasoningTokens = tokenCount(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(cache.read),
    cacheCreationTokens: tokenCount(cache.write),
    outputTokens: tokenCount(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  const project = fallback.project ?? projectFromCwd(obj(message.path).cwd);
  return {
    provider: "opencode",
    timestampMs: created,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    ...(project ? { project } : {}),
    totals,
    // OpenCode logs zero for unknown rates, including paid plans; let shared pricing estimate.
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

function readDatabase(file: string): UsageRecord[] {
  return withSqlite(file, (db) => {
    const tables = db.tables();
    const projects = new Map<string, string>();
    for (const table of ["session_v2", "session"]) {
      if (!tables.has(table) || !db.columns(table).has("directory")) continue;
      for (const row of db.all(`SELECT id, directory FROM ${table}`)) {
        const project = projectFromCwd(row.directory);
        if (project) projects.set(text(row.id), project);
      }
    }
    const out: UsageRecord[] = [];
    for (const table of ["message", "session_message"] as const) {
      if (!tables.has(table)) continue;
      const columns = db.columns(table);
      const created = columns.has("time_created") ? "time_created" : "NULL";
      const where = table === "session_message" ? "WHERE type = 'assistant'" : "";
      for (const row of db.all(`SELECT id, session_id, data, ${created} AS created FROM ${table} ${where} ORDER BY rowid`)) {
        const sessionId = text(row.session_id);
        const project = projects.get(sessionId);
        const record = parseOpenCodeMessage(text(row.data), {
          id: text(row.id),
          sessionId,
          ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
          ...(project ? { project } : {}),
        });
        if (record) out.push(record);
      }
    }
    return out;
  });
}

const format: FileFormat = {
  kind: "file",
  async parseFile({ path: file }) {
    if (file.endsWith(".db")) return readDatabase(file);
    const record = parseOpenCodeMessage(await readFile(file, "utf8"), { id: path.basename(file, ".json") });
    return record ? [record] : [];
  },
};

export const opencodeReader: SourceReader = {
  tool: "opencode",
  fidelity: "call",
  knownFolders: [".opencode"],
  format,
  homes: (ctx) => {
    const roots = ctx.env.OPENCODE_DATA_DIR?.split(",").map((v) => v.trim()).filter(Boolean);
    return existingHomes(ctx, (roots?.length ? roots : [path.join(xdgDataHome(ctx), "opencode")]).map((dir) => ({ dir })));
  },
  files: async (home) => {
    const dbs = await walkFiles(home.dir, (name) => /^opencode(?:-[\w-]+)?\.db$/.test(name), 0);
    const legacy = await walkFiles(path.join(home.dir, "storage", "message"), (name) => name.endsWith(".json"));
    return [...dbs.sort(), ...legacy];
  },
};
