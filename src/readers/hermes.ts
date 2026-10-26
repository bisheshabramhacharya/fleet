import path from "node:path";
import { isFile } from "../core/fs.ts";
import { tokenCount } from "../core/totals.ts";
import type { UsageRecord } from "../core/types.ts";
import type { FileFormat, SourceHome, SourceReader } from "./types.ts";
import { withSqlite } from "./sqlite.ts";
import { existingHomes, homeFolders, projectFromCwd } from "./util.ts";

const text = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Hermes keeps running per-session, per-model totals in `session_model_usage`. Each row becomes
 * one record placed on its last-seen time, so daily charts are approximate.
 */
function readState(file: string, profile: string): UsageRecord[] {
  return withSqlite(file, (db) => {
    const tables = db.tables();
    if (!tables.has("session_model_usage")) return [];
    const projects = new Map<string, string>();
    if (tables.has("sessions")) {
      for (const row of db.all("SELECT id, cwd FROM sessions")) {
        const project = projectFromCwd(row.cwd);
        if (project) projects.set(text(row.id), project);
      }
    }
    const out: UsageRecord[] = [];
    for (const row of db.all("SELECT * FROM session_model_usage")) {
      const sessionId = text(row.session_id);
      const model = text(row.model) || "unknown";
      const lastSeen = num(row.last_seen) || num(row.first_seen);
      if (lastSeen <= 0) continue;
      const outputTokens = tokenCount(row.output_tokens);
      const totals = {
        // Hermes keeps cache reads separate from input.
        uncachedInputTokens: tokenCount(row.input_tokens),
        cachedInputTokens: tokenCount(row.cache_read_tokens),
        cacheCreationTokens: tokenCount(row.cache_write_tokens),
        outputTokens,
        reasoningTokens: Math.min(outputTokens, tokenCount(row.reasoning_tokens)),
      };
      if (totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens + outputTokens === 0) continue;
      const actual = num(row.actual_cost_usd);
      const included = row.cost_status === "included";
      out.push({
        provider: "hermes",
        timestampMs: Math.round(lastSeen * 1000),
        model,
        sessionId: `${profile}:${sessionId}`,
        project: projects.get(sessionId) ?? profile,
        totals,
        // Plan-included calls still get an API estimate; billed calls keep Hermes's figure.
        reportedCostUsd: actual > 0 && !included ? actual : null,
        speed: "standard",
        dedupeKey: `${profile}:${sessionId}:${model}:${text(row.billing_provider)}:${text(row.task)}`,
        fidelity: "session",
      });
    }
    return out;
  });
}

const format: FileFormat = {
  kind: "file",
  async parseFile({ path: file, home }) {
    return readState(file, home.label ?? "default");
  },
};

export const hermesReader: SourceReader = {
  tool: "hermes",
  fidelity: "session",
  knownFolders: [".hermes"],
  format,
  homes: async (ctx) => {
    const roots = new Set<string>();
    const env = ctx.env.HERMES_HOME?.trim();
    if (env) roots.add(env);
    for (const dir of await homeFolders(ctx, /^\.hermes(-[\w.-]+)?$/)) roots.add(dir);
    if (ctx.platform === "win32") {
      roots.add(path.join(ctx.env.LOCALAPPDATA ?? path.join(ctx.homeDir, "AppData", "Local"), "hermes"));
    }
    const candidates: SourceHome[] = [];
    for (const root of roots) {
      const rootName = path.basename(root).replace(/^\./, "");
      if (await isFile(path.join(root, "state.db"))) candidates.push({ dir: root, label: rootName === "hermes" ? "default" : rootName });
      for (const profileDir of await homeFolders({ ...ctx, homeDir: path.join(root, "profiles") }, /.+/)) {
        if (await isFile(path.join(profileDir, "state.db"))) candidates.push({ dir: profileDir, label: path.basename(profileDir) });
      }
    }
    return existingHomes({ ...ctx, customHomes: [] }, candidates);
  },
  files: async (home) => [path.join(home.dir, "state.db")],
};
