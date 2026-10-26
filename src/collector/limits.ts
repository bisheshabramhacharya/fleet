import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { walkFiles } from "../core/fs.ts";
import type { LimitSnapshot, LimitWindow } from "../core/types.ts";
import { codexReader } from "../readers/codex.ts";
import type { ReaderContext } from "../readers/types.ts";

const clamp = (n: number) => Math.max(0, Math.min(100, n));

function labelForMinutes(mins: number): string {
  if (mins >= 30 * 24 * 60) return "Monthly";
  if (mins >= 7 * 24 * 60) return "Weekly";
  if (mins >= 60) return `${Math.round(mins / 60)}-hour session`;
  return `${mins}-minute window`;
}

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Codex writes its plan meters into every token_count event; the newest rollout has the latest. */
export async function readCodexLimits(ctx: ReaderContext, device: string): Promise<LimitSnapshot | null> {
  const homes = await codexReader.homes(ctx);
  let newest: { file: string; mtime: number } | null = null;
  for (const home of homes) {
    for (const file of await walkFiles(home.dir, (name) => name.endsWith(".jsonl"))) {
      const mtime = (await stat(file)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
  }
  if (!newest) return null;
  const lines = (await readTail(newest.file, 512 * 1024)).split("\n").reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    let parsed: { timestamp?: string; payload?: { rate_limits?: Record<string, unknown> } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = parsed.payload?.rate_limits;
    if (!limits || (limits.limit_id && limits.limit_id !== "codex")) continue;
    const windows: LimitWindow[] = [];
    for (const key of ["primary", "secondary"]) {
      const w = limits[key] as { used_percent?: number; window_minutes?: number; resets_at?: number } | undefined;
      if (!w || typeof w.used_percent !== "number") continue;
      const mins = w.window_minutes ?? (key === "primary" ? 300 : 10080);
      windows.push({
        label: labelForMinutes(mins),
        usedPercent: clamp(w.used_percent),
        used: null,
        limit: null,
        unit: null,
        resetsAt: typeof w.resets_at === "number" ? new Date(w.resets_at * 1000).toISOString() : null,
      });
    }
    if (windows.length === 0) continue;
    return {
      provider: "codex",
      device,
      account: null,
      plan: typeof limits.plan_type === "string" ? limits.plan_type : null,
      // These meters are as of the last Codex request, not live.
      checkedAt: parsed.timestamp ?? new Date(newest.mtime).toISOString(),
      ok: true,
      error: null,
      windows,
    };
  }
  return null;
}

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5-hour session",
  seven_day: "Weekly",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};

/**
 * Asks Anthropic for the Claude plan meters with the login Claude Code saved on this device.
 * Read-only: an expired login is reported, never refreshed.
 */
export async function readClaudeLimits(ctx: ReaderContext, device: string, fetchImpl: typeof fetch = fetch): Promise<LimitSnapshot | null> {
  const configDir = ctx.env.CLAUDE_CONFIG_DIR?.trim() || path.join(ctx.homeDir, ".claude");
  let creds: { claudeAiOauth?: { accessToken?: string; expiresAt?: number; subscriptionType?: string } };
  try {
    creds = JSON.parse(await readFile(path.join(configDir, ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  const base: LimitSnapshot = {
    provider: "claude",
    device,
    account: null,
    plan: oauth.subscriptionType ?? null,
    checkedAt: new Date().toISOString(),
    ok: false,
    error: null,
    windows: [],
  };
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) {
    return { ...base, error: "Claude login expired. Open Claude Code once to refresh it." };
  }
  try {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ...base, error: `Anthropic answered HTTP ${response.status}.` };
    const doc = (await response.json()) as Record<string, { utilization?: number | null; resets_at?: string | null } | null>;
    const windows: LimitWindow[] = [];
    for (const [key, label] of Object.entries(CLAUDE_WINDOWS)) {
      const w = doc[key];
      if (!w || typeof w.utilization !== "number") continue;
      windows.push({ label, usedPercent: clamp(w.utilization), used: null, limit: null, unit: null, resetsAt: w.resets_at ?? null });
    }
    return { ...base, ok: windows.length > 0, error: windows.length > 0 ? null : "No plan meters in the answer.", windows };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readLimits(ctx: ReaderContext, device: string): Promise<LimitSnapshot[]> {
  const results = await Promise.allSettled([readCodexLimits(ctx, device), readClaudeLimits(ctx, device)]);
  return results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}
