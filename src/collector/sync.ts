import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../core/config.ts";
import type { IngestPayload, IngestResult } from "../hub/store.ts";
import type { Collector, PushFile } from "./collector.ts";

/** Push batches stay under this many encoded bytes so a first sync never sends one huge body. */
const MAX_BATCH_BYTES = 4 * 1024 * 1024;

export type Send = (payload: IngestPayload) => Promise<IngestResult>;

interface SyncState {
  target: string;
  rev: number;
}

/**
 * Sends files whose records changed since the hub last acknowledged. Files go out in revision
 * order, so after each batch every change up to that batch's top revision has been delivered.
 */
export class SyncCursor {
  readonly #file: string;
  #state: SyncState = { target: "", rev: 0 };

  constructor(file: string) {
    this.#file = file;
  }

  async load(): Promise<void> {
    try {
      this.#state = JSON.parse(await readFile(this.#file, "utf8")) as SyncState;
    } catch {
      // first sync
    }
  }

  async push(
    collector: Collector,
    target: string,
    makePayload: (files: PushFile[], baseRev: number, rev: number) => IngestPayload,
    send: Send,
  ): Promise<{ sent: number; rev: number }> {
    let baseRev = this.#state.target === target ? this.#state.rev : 0;
    let sent = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const files = collector.changedSince(baseRev).sort((a, b) => a.rev - b.rev);
      let resync = false;
      // Always send at least one payload so the hub gets fresh status even with no new records.
      const batches = batch(files);
      if (batches.length === 0) batches.push([]);
      for (const group of batches) {
        const rev = group.length > 0 ? group[group.length - 1]!.rev : baseRev;
        const result = await send(makePayload(group, baseRev, rev));
        if (result.resync) {
          resync = true;
          break;
        }
        if (!result.ok) throw new Error(`hub refused the push: ${JSON.stringify(result).slice(0, 200)}`);
        baseRev = result.rev;
        sent += group.length;
        await this.#save({ target, rev: baseRev });
      }
      if (!resync) return { sent, rev: baseRev };
      baseRev = 0;
    }
    throw new Error("hub kept asking for a resync");
  }

  async #save(state: SyncState) {
    this.#state = state;
    await writeJsonAtomic(this.#file, state);
  }
}

function batch(files: PushFile[]): PushFile[][] {
  const out: PushFile[][] = [];
  let current: PushFile[] = [];
  let size = 0;
  for (const file of files) {
    const bytes = file.records.length * 120 + file.path.length;
    if (current.length > 0 && size + bytes > MAX_BATCH_BYTES) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += bytes;
  }
  if (current.length > 0) out.push(current);
  return out;
}
