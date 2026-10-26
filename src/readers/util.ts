import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { isDir, walkFiles } from "../core/fs.ts";
import type { ReaderContext, SourceHome } from "./types.ts";

/** Last folder name of a working directory, used as the project label. */
export function projectFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]/).pop();
  return name && name.length > 0 && !/^[A-Za-z]:$/.test(name) ? name : undefined;
}

/** Existing folders among `candidates`, deduplicated, plus the owner's custom homes. */
export async function existingHomes(ctx: ReaderContext, candidates: readonly SourceHome[]): Promise<SourceHome[]> {
  const out: SourceHome[] = [];
  const seen = new Set<string>();
  for (const home of [...candidates, ...ctx.customHomes.map((dir) => ({ dir }))]) {
    const key = path.resolve(home.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (await isDir(home.dir)) out.push(home);
  }
  return out;
}

export function jsonlFiles(dir: string, suffix = ".jsonl"): Promise<string[]> {
  return walkFiles(dir, (name) => name.endsWith(suffix));
}

/** Subfolders of the user's home whose names match `pattern`. */
export async function homeFolders(ctx: ReaderContext, pattern: RegExp): Promise<string[]> {
  try {
    return (await readdir(ctx.homeDir)).filter((name) => pattern.test(name)).map((name) => path.join(ctx.homeDir, name));
  } catch {
    return [];
  }
}

/** First line of a file without reading the rest. */
export async function readFirstLine(file: string, maxBytes = 64 * 1024): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function xdgDataHome(ctx: ReaderContext): string {
  const configured = ctx.env.XDG_DATA_HOME?.trim();
  return configured && path.isAbsolute(configured) ? configured : path.join(ctx.homeDir, ".local", "share");
}
