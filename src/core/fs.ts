import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Recursively lists files under `dir` that match `accept`. Missing folders give []. */
export async function walkFiles(dir: string, accept: (name: string, full: string) => boolean, maxDepth = 8): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, depth: number) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && entry.name !== "node_modules" && entry.name !== ".git") await walk(full, depth + 1);
      } else if (entry.isFile() && accept(entry.name, full)) {
        out.push(full);
      }
    }
  }
  await walk(dir, 0);
  return out;
}

export function expandHome(p: string, homeDir: string): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homeDir, p.slice(2));
  return p;
}

export interface LineReadResult {
  /** Offset just after the last complete line read. */
  readonly offset: number;
  readonly lines: number;
}

/**
 * Streams complete lines from `fromOffset` to the end of the file. A trailing
 * partial line is left for the next read, so the returned offset never splits one.
 */
export async function readLinesFrom(file: string, fromOffset: number, onLine: (line: string) => void): Promise<LineReadResult> {
  const handle = await open(file, "r");
  try {
    const chunkSize = 1 << 20;
    const buffer = Buffer.alloc(chunkSize);
    let position = fromOffset;
    let consumed = fromOffset;
    let carry: Buffer = Buffer.alloc(0);
    let lines = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : Buffer.from(buffer.subarray(0, bytesRead));
      let start = 0;
      for (;;) {
        const nl = data.indexOf(10, start);
        if (nl === -1) break;
        let end = nl;
        if (end > start && data[end - 1] === 13) end -= 1;
        if (end > start) {
          onLine(data.toString("utf8", start, end));
          lines += 1;
        }
        consumed += nl + 1 - start;
        start = nl + 1;
      }
      carry = data.subarray(start);
    }
    return { offset: consumed, lines };
  } finally {
    await handle.close();
  }
}
