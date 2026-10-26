import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../core/config.ts";
import { readLinesFrom } from "../core/fs.ts";
import type { SourceStatus, ToolId, UnknownFolder, UsageRecord } from "../core/types.ts";
import { encodeRecord, type WireRecord } from "../core/wire.ts";
import type { ReaderContext, SourceHome, SourceReader } from "../readers/types.ts";

export interface FileEntry {
  provider: ToolId;
  home: string;
  size: number;
  mtimeMs: number;
  /** Line formats: byte offset after the last complete line. */
  offset: number;
  state: unknown;
  records: WireRecord[];
  malformed: number;
  /** Bumped every time this file's records change. */
  rev: number;
  missing?: boolean;
}

interface CacheDocument {
  version: 1;
  rev: number;
  files: Record<string, FileEntry>;
}

export interface ScanResult {
  durationMs: number;
  changedFiles: number;
  sources: SourceStatus[];
  unknownFolders: UnknownFolder[];
}

export interface PushFile {
  path: string;
  provider: ToolId;
  home: string;
  records: WireRecord[];
  rev: number;
}

/** AI tool folders people commonly have; anything here that no reader covers gets flagged. */
const CANDIDATE_FOLDERS = [
  ".aider", ".amp", ".augment", ".claude", ".cline", ".codeium", ".codex", ".commandcode", ".continue", ".copilot",
  ".crush", ".cursor", ".devin", ".dsh", ".factory", ".gemini", ".goose", ".grok", ".hermes", ".junie", ".kilocode",
  ".kiro", ".omp", ".openhands", ".opencode", ".pi", ".plandex", ".qwen", ".roo", ".trae", ".windsurf", ".zcode", ".9router",
];

export interface CollectorOptions {
  readers: readonly SourceReader[];
  ctx: ReaderContext;
  deviceId: string;
  cacheFile: string;
  isDisabled: (tool: ToolId, homeDir: string) => boolean;
  hideProjects: () => boolean;
  log?: (message: string) => void;
}

export class Collector {
  readonly #opts: CollectorOptions;
  #doc: CacheDocument = { version: 1, rev: 0, files: {} };
  #lastScan: ScanResult | null = null;
  #scanning: Promise<ScanResult> | null = null;

  constructor(opts: CollectorOptions) {
    this.#opts = opts;
  }

  async load(): Promise<void> {
    try {
      const doc = JSON.parse(await readFile(this.#opts.cacheFile, "utf8")) as CacheDocument;
      if (doc.version === 1 && typeof doc.rev === "number") this.#doc = doc;
    } catch {
      // first run
    }
  }

  get rev(): number {
    return this.#doc.rev;
  }

  get lastScan(): ScanResult | null {
    return this.#lastScan;
  }

  /** Concurrent callers share one scan. */
  scan(): Promise<ScanResult> {
    this.#scanning ??= this.#scan().finally(() => {
      this.#scanning = null;
    });
    return this.#scanning;
  }

  /** Files whose records changed after `sinceRev`. */
  changedSince(sinceRev: number): PushFile[] {
    const out: PushFile[] = [];
    for (const [file, entry] of Object.entries(this.#doc.files)) {
      if (entry.rev > sinceRev) out.push({ path: file, provider: entry.provider, home: entry.home, records: entry.records, rev: entry.rev });
    }
    return out;
  }

  async #scan(): Promise<ScanResult> {
    const started = Date.now();
    const { readers, ctx } = this.#opts;
    const sources: SourceStatus[] = [];
    const coveredFolders = new Set<string>();
    let changedFiles = 0;
    const seenPaths = new Set<string>();

    for (const reader of readers) {
      for (const folder of reader.knownFolders ?? []) coveredFolders.add(folder);
      let homes: readonly SourceHome[] = [];
      try {
        homes = await reader.homes(ctx);
      } catch (error) {
        this.#opts.log?.(`homes failed for ${reader.tool}: ${String(error)}`);
      }
      for (const home of homes) {
        coveredFolders.add(path.basename(home.dir));
        const enabled = !this.#opts.isDisabled(reader.tool, home.dir);
        const status: SourceStatus = {
          device: this.#opts.deviceId,
          provider: reader.tool,
          home: home.dir,
          ...(home.label ? { homeLabel: home.label } : {}),
          status: "ok",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          records: 0,
          fidelity: reader.fidelity,
          enabled,
          message: null,
        };
        sources.push(status);
        if (!enabled) continue;
        let files: readonly string[] = [];
        try {
          files = await reader.files(home, ctx);
        } catch (error) {
          status.status = "failed";
          status.message = `Could not list files: ${String(error)}`;
          continue;
        }
        const sessions = new Set<string>();
        for (const file of files) {
          seenPaths.add(file);
          try {
            if (await this.#readFile(reader, home, file)) changedFiles += 1;
            status.scannedFiles += 1;
          } catch (error) {
            status.skippedFiles += 1;
            status.status = "partial";
            status.message = `${path.basename(file)}: ${String(error).slice(0, 200)}`;
          }
          const entry = this.#doc.files[file];
          if (entry) {
            status.records += entry.records.length;
            status.malformedRecords += entry.malformed;
            for (const record of entry.records) if (record[4]) sessions.add(record[4]);
          }
        }
        status.distinctSessions = sessions.size;
        if (files.length === 0) {
          status.status = "missing";
          status.message = "No log files yet.";
        }
      }
    }

    // Deleted transcripts keep their saved usage.
    for (const [file, entry] of Object.entries(this.#doc.files)) {
      if (!seenPaths.has(file) && !entry.missing) entry.missing = true;
    }

    const unknownFolders = await this.#unknownFolders(coveredFolders);
    if (changedFiles > 0) await writeJsonAtomic(this.#opts.cacheFile, this.#doc);
    const result: ScanResult = { durationMs: Date.now() - started, changedFiles, sources, unknownFolders };
    this.#lastScan = result;
    return result;
  }

  async #readFile(reader: SourceReader, home: SourceHome, file: string): Promise<boolean> {
    const info = await fingerprint(file);
    const cached = this.#doc.files[file];
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.provider === reader.tool && !cached.missing) {
      return false;
    }
    const fileCtx = { path: file, home, ctx: this.#opts.ctx };
    let records: UsageRecord[] = [];
    let offset = 0;
    let state: unknown = undefined;
    let malformed = 0;
    const format = reader.format;
    if (format.kind === "lines") {
      const resume = cached && cached.provider === reader.tool && info.size > cached.size && cached.offset > 0;
      let base: WireRecord[] = [];
      if (resume) {
        base = cached.records;
        offset = cached.offset;
        state = cached.state === undefined ? format.initialState?.() : structuredClone(cached.state);
        malformed = cached.malformed;
      } else {
        state = format.initialState?.();
      }
      const markers = format.usageMarkers;
      const fresh: UsageRecord[] = [];
      const read = await readLinesFrom(file, offset, (line) => {
        if (markers && !markers.some((m) => line.includes(m))) return;
        try {
          for (const record of format.parseLine(line, state, fileCtx)) fresh.push(record);
        } catch {
          malformed += 1;
        }
      });
      offset = read.offset;
      const encoded = this.#encodeAll(fresh);
      this.#store(file, reader.tool, home.dir, info, offset, state, base.concat(encoded), malformed);
      return true;
    }
    records = [...(await format.parseFile(fileCtx))];
    this.#store(file, reader.tool, home.dir, info, 0, undefined, this.#encodeAll(records), malformed);
    return true;
  }

  #encodeAll(records: readonly UsageRecord[]): WireRecord[] {
    const hide = this.#opts.hideProjects();
    return records.map((r) => encodeRecord(hide && r.project ? { ...r, project: scrambleProject(r.project) } : r));
  }

  #store(file: string, provider: ToolId, home: string, info: { size: number; mtimeMs: number }, offset: number, state: unknown, records: WireRecord[], malformed: number) {
    this.#doc.rev += 1;
    this.#doc.files[file] = {
      provider,
      home,
      size: info.size,
      mtimeMs: info.mtimeMs,
      offset,
      state: state === undefined ? undefined : state,
      records,
      malformed,
      rev: this.#doc.rev,
    };
  }

  async #unknownFolders(covered: Set<string>): Promise<UnknownFolder[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.#opts.ctx.homeDir);
    } catch {
      return [];
    }
    const out: UnknownFolder[] = [];
    for (const name of names) {
      const candidate = CANDIDATE_FOLDERS.includes(name) || /^\.codex-/.test(name);
      // Extra Codex homes (~/.codex-*) belong to the Codex reader even before they hold sessions.
      const owner = /^\.codex-/.test(name) ? ".codex" : name;
      if (!candidate || covered.has(name) || covered.has(owner)) continue;
      out.push({ device: this.#opts.deviceId, path: path.join(this.#opts.ctx.homeDir, name), guess: name.replace(/^\./, "") });
    }
    return out;
  }
}

/** SQLite writers often touch only the -wal file until a checkpoint, so it counts as a change too. */
async function fingerprint(file: string): Promise<{ size: number; mtimeMs: number }> {
  const info = await stat(file);
  if (!file.endsWith(".db")) return { size: info.size, mtimeMs: info.mtimeMs };
  try {
    const wal = await stat(`${file}-wal`);
    return { size: info.size + wal.size, mtimeMs: Math.max(info.mtimeMs, wal.mtimeMs) };
  } catch {
    return { size: info.size, mtimeMs: info.mtimeMs };
  }
}

export function scrambleProject(name: string): string {
  return `project-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}
