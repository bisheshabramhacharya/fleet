import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../core/config.ts";
import type { DeviceInfo, LimitSnapshot, SourceStatus, ToolId, UnknownFolder, UsageRecord } from "../core/types.ts";
import { decodeRecord, type WireRecord } from "../core/wire.ts";

export interface IngestFile {
  path: string;
  provider: ToolId;
  home: string;
  records: WireRecord[];
}

export interface IngestPayload {
  device: Omit<DeviceInfo, "lastSeenMs" | "online">;
  /** Revision the collector believes the hub already has. 0 means "replace everything". */
  baseRev: number;
  rev: number;
  files: IngestFile[];
  sources: SourceStatus[];
  unknownFolders: UnknownFolder[];
  limits: LimitSnapshot[];
}

export interface IngestResult {
  ok: boolean;
  /** The hub lost track of this device; resend everything with baseRev 0. */
  resync?: boolean;
  rev: number;
}

interface StoredFile {
  provider: ToolId;
  home: string;
  records: WireRecord[];
}

interface DeviceDocument {
  info: DeviceInfo;
  rev: number;
  sources: SourceStatus[];
  unknownFolders: UnknownFolder[];
  limits: LimitSnapshot[];
  files: Record<string, StoredFile>;
}

export const STALE_DEVICE_MS = 24 * 60 * 60 * 1000;

export class HubStore {
  readonly #dir: string;
  readonly #devices = new Map<string, DeviceDocument>();
  readonly #decoded = new Map<string, UsageRecord[]>();
  readonly #dirty = new Set<string>();
  readonly #recordsDirty = new Set<string>();
  #flushTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async load(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    for (const name of await readdir(this.#dir)) {
      if (!name.endsWith(".json") || name.endsWith(".records.json")) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(this.#dir, name), "utf8")) as Omit<DeviceDocument, "files">;
        if (!meta?.info?.id) continue;
        let files: Record<string, StoredFile> = {};
        try {
          files = JSON.parse(await readFile(path.join(this.#dir, `${safeName(meta.info.id)}.records.json`), "utf8"));
        } catch {
          // Records missing: the device's next push carries baseRev mismatch and resends.
          meta.rev = -1;
        }
        this.#devices.set(meta.info.id, { ...meta, limits: meta.limits ?? [], unknownFolders: meta.unknownFolders ?? [], sources: meta.sources ?? [], files });
      } catch {
        // A damaged device file is rebuilt on the next full push.
      }
    }
  }

  /** Revision this store holds for a device, or 0 when it has none. */
  deviceRev(id: string): number {
    return Math.max(0, this.#devices.get(id)?.rev ?? 0);
  }

  ingest(payload: IngestPayload, nowMs = Date.now()): IngestResult {
    const id = payload.device.id;
    let doc = this.#devices.get(id);
    if (payload.baseRev !== 0 && (doc === undefined || doc.rev !== payload.baseRev)) {
      return { ok: false, resync: true, rev: doc?.rev ?? 0 };
    }
    if (doc === undefined || payload.baseRev === 0) {
      doc = {
        info: { ...payload.device, lastSeenMs: nowMs, online: true },
        rev: 0,
        sources: [],
        unknownFolders: [],
        limits: [],
        files: {},
      };
      this.#devices.set(id, doc);
      for (const key of [...this.#decoded.keys()]) if (key.startsWith(`${id}\u0000`)) this.#decoded.delete(key);
    }
    for (const file of payload.files) {
      doc.files[file.path] = { provider: file.provider, home: file.home, records: file.records };
      this.#decoded.delete(`${id}\u0000${file.path}`);
    }
    doc.info = { ...payload.device, lastSeenMs: nowMs, online: true };
    doc.rev = payload.rev;
    doc.sources = payload.sources;
    doc.unknownFolders = payload.unknownFolders;
    if (payload.limits.length > 0) doc.limits = payload.limits;
    this.#markDirty(id);
    return { ok: true, rev: doc.rev };
  }

  devices(nowMs = Date.now()): DeviceInfo[] {
    return [...this.#devices.values()]
      .map((d) => ({ ...d.info, online: nowMs - d.info.lastSeenMs < STALE_DEVICE_MS }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  sources(): SourceStatus[] {
    return [...this.#devices.values()].flatMap((d) => d.sources);
  }

  unknownFolders(): UnknownFolder[] {
    return [...this.#devices.values()].flatMap((d) => d.unknownFolders);
  }

  limits(): LimitSnapshot[] {
    return [...this.#devices.values()].flatMap((d) => d.limits);
  }

  async removeDevice(id: string, keepHistory: boolean): Promise<void> {
    if (keepHistory) return;
    this.#devices.delete(id);
    for (const key of [...this.#decoded.keys()]) if (key.startsWith(`${id}\u0000`)) this.#decoded.delete(key);
    const { rm } = await import("node:fs/promises");
    await rm(path.join(this.#dir, `${safeName(id)}.json`), { force: true });
    await rm(path.join(this.#dir, `${safeName(id)}.records.json`), { force: true });
  }

  renameDevice(id: string, name: string): void {
    const doc = this.#devices.get(id);
    if (!doc) return;
    doc.info = { ...doc.info, name };
    this.#markDirty(id);
  }

  *records(): Generator<{ record: UsageRecord; device: string }> {
    for (const [id, doc] of this.#devices) {
      for (const [file, stored] of Object.entries(doc.files)) {
        const key = `${id}\u0000${file}`;
        let decoded = this.#decoded.get(key);
        if (decoded === undefined) {
          decoded = [];
          for (const wire of stored.records) {
            const record = decodeRecord(wire);
            if (record) decoded.push(record);
          }
          this.#decoded.set(key, decoded);
        }
        for (const record of decoded) yield { record, device: id };
      }
    }
  }

  #markDirty(id: string) {
    this.#dirty.add(id);
    this.#flushTimer ??= setTimeout(() => void this.flush(), 1500);
  }

  async flush(): Promise<void> {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    const ids = [...this.#dirty];
    const withRecords = new Set(this.#recordsDirty);
    this.#dirty.clear();
    this.#recordsDirty.clear();
    await Promise.all(
      ids.map(async (id) => {
        const doc = this.#devices.get(id);
        if (!doc) return;
        const { files, ...meta } = doc;
        // Records first: a crash between the writes leaves an older rev, which forces a resend.
        if (withRecords.has(id)) await writeJsonAtomic(path.join(this.#dir, `${safeName(id)}.records.json`), files);
        await writeJsonAtomic(path.join(this.#dir, `${safeName(id)}.json`), meta);
      }),
    );
  }
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}
