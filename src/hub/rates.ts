import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../core/config.ts";
import { parseRateTable, type RateTable } from "../core/pricing.ts";
import type { PricingInfo } from "../core/types.ts";

export const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_FLOOR_MS = 60 * 1000;

/** LiteLLM's public price table, refreshed daily and cached on disk for offline use. */
export class Rates {
  readonly #file: string;
  readonly #fetch: typeof fetch;
  #table: RateTable = new Map();
  #info: PricingInfo = { status: "unavailable", source: LITELLM_RATES_URL, fetchedAt: null, knownModels: 0 };
  #fetchedAtMs = 0;
  #lastFailMs = 0;
  #inflight: Promise<void> | null = null;

  constructor(dataDir: string, fetchImpl: typeof fetch = fetch) {
    this.#file = path.join(dataDir, "litellm-prices.json");
    this.#fetch = fetchImpl;
  }

  get table(): RateTable {
    return this.#table;
  }

  get info(): PricingInfo {
    return this.#info;
  }

  async load(): Promise<void> {
    try {
      const [text, info] = await Promise.all([readFile(this.#file, "utf8"), stat(this.#file)]);
      this.#use(JSON.parse(text), info.mtimeMs, "cached");
    } catch {
      // nothing cached yet
    }
  }

  /** Refreshes when stale. Never throws; a failed fetch keeps the cached table. */
  ensureFresh(force = false): Promise<void> {
    const now = Date.now();
    const maxAge = force ? RETRY_FLOOR_MS : TTL_MS;
    if (now - this.#fetchedAtMs < maxAge) return Promise.resolve();
    if (now - this.#lastFailMs < RETRY_FLOOR_MS) return Promise.resolve();
    this.#inflight ??= this.#refresh().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #refresh(): Promise<void> {
    try {
      const response = await this.#fetch(LITELLM_RATES_URL, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document = (await response.json()) as unknown;
      this.#use(document, Date.now(), "fresh");
      await writeJsonAtomic(this.#file, document);
    } catch {
      this.#lastFailMs = Date.now();
    }
  }

  #use(document: unknown, fetchedAtMs: number, status: PricingInfo["status"]) {
    const table = parseRateTable(document);
    if (table.size === 0) return;
    this.#table = table;
    this.#fetchedAtMs = fetchedAtMs;
    this.#info = { status, source: LITELLM_RATES_URL, fetchedAt: new Date(fetchedAtMs).toISOString(), knownModels: table.size };
  }
}
