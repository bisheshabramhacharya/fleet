import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Collector, type ScanResult } from "../collector/collector.ts";
import { readLimits } from "../collector/limits.ts";
import { SyncCursor } from "../collector/sync.ts";
import { ConfigStore, newPairCode, newToken, writeJsonAtomic, type FleetConfig } from "../core/config.ts";
import type { BillingProvider, BillingSnapshot, DeviceInfo, LimitSnapshot, MoneySummary, ToolId } from "../core/types.ts";
import { encodeRecord } from "../core/wire.ts";
import { checkBilling } from "../hub/billing.ts";
import { Rates } from "../hub/rates.ts";
import { HubStore, type IngestPayload, type IngestResult } from "../hub/store.ts";
import { allReaders } from "../readers/index.ts";
import type { ReaderContext } from "../readers/types.ts";

declare const __FLEET_VERSION__: string | undefined;
export const VERSION = typeof __FLEET_VERSION__ === "string" ? __FLEET_VERSION__ : "0.0.0-dev";

/** Encrypts billing keys at rest. Electron passes the OS keychain; headless mode has none. */
export interface SecretBox {
  readonly available: boolean;
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

export const NO_SECRETS: SecretBox = {
  available: false,
  encrypt: () => {
    throw new Error("Key storage needs the desktop app (system keychain).");
  },
  decrypt: () => {
    throw new Error("Key storage needs the desktop app (system keychain).");
  },
};

export interface FleetNodeOptions {
  dataDir: string;
  secrets?: SecretBox;
  /** Overrides for tests: the folder treated as the user's home, environment, platform. */
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  /** Hub transport for collectors; defaults to HTTP. */
  sendToHub?: (url: string, token: string, payload: IngestPayload) => Promise<IngestResult>;
  log?: (message: string) => void;
  /** Read plan limits from local logins (off in tests). */
  readLimits?: boolean;
}

export interface SyncStatus {
  lastPushAt: string | null;
  lastError: string | null;
  pushedFiles: number;
}

const LIMITS_EVERY_MS = 10 * 60 * 1000;
const BILLING_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * One fleet install. Every node scans its own logs into a local store. The hub also stores
 * what other devices push; a collector pushes its records to the hub.
 */
export class FleetNode {
  readonly options: FleetNodeOptions;
  readonly config: ConfigStore;
  readonly store: HubStore;
  readonly rates: Rates;
  readonly collector: Collector;
  readonly secrets: SecretBox;
  readonly #cursor: SyncCursor;
  readonly #fetch: typeof fetch;
  #limits: LimitSnapshot[] = [];
  #limitsAt = 0;
  #billing = new Map<BillingProvider, BillingSnapshot>();
  #billingAt = 0;
  #timer: NodeJS.Timeout | null = null;
  #sync: SyncStatus = { lastPushAt: null, lastError: null, pushedFiles: 0 };
  #cycle: Promise<ScanResult> | null = null;

  private constructor(options: FleetNodeOptions, config: ConfigStore) {
    this.options = options;
    this.config = config;
    this.secrets = options.secrets ?? NO_SECRETS;
    this.#fetch = options.fetch ?? fetch;
    this.store = new HubStore(path.join(options.dataDir, "hub"));
    this.rates = new Rates(options.dataDir, this.#fetch);
    this.#cursor = new SyncCursor(path.join(options.dataDir, "sync.json"));
    const ctx = this.readerContext();
    this.collector = new Collector({
      readers: allReaders(this.inboxDir),
      ctx,
      deviceId: config.value.deviceId,
      cacheFile: path.join(options.dataDir, "scan-cache.json"),
      isDisabled: (tool, home) => this.isDisabled(tool, home),
      hideProjects: () => this.config.value.hideProjects,
      ...(options.log ? { log: options.log } : {}),
    });
  }

  static async open(options: FleetNodeOptions): Promise<FleetNode> {
    const config = await ConfigStore.open(options.dataDir);
    const node = new FleetNode(options, config);
    await Promise.all([node.store.load(), node.rates.load(), node.collector.load(), node.#cursor.load()]);
    try {
      const billing = JSON.parse(await readFile(path.join(options.dataDir, "billing.json"), "utf8")) as BillingSnapshot[];
      for (const snap of billing) node.#billing.set(snap.provider, snap);
    } catch {
      // no billing checks yet
    }
    return node;
  }

  get inboxDir(): string {
    return path.join(this.options.dataDir, "inbox");
  }

  get role(): FleetConfig["role"] {
    return this.config.value.role;
  }

  get syncStatus(): SyncStatus {
    return this.#sync;
  }

  readerContext(): ReaderContext {
    const customHomes = Object.values(this.config?.value.customHomes ?? {}).flat();
    return {
      homeDir: this.options.homeDir ?? os.homedir(),
      env: this.options.env ?? process.env,
      platform: this.options.platform ?? process.platform,
      customHomes,
    };
  }

  isDisabled(tool: ToolId, home: string): boolean {
    const off = this.config.value.disabledSources;
    return off.includes(tool) || off.includes(`${tool}:${home}`);
  }

  deviceInfo(): Omit<DeviceInfo, "lastSeenMs" | "online"> {
    const c = this.config.value;
    return {
      id: c.deviceId,
      name: c.deviceName,
      platform: this.options.platform ?? process.platform,
      hostname: os.hostname(),
      version: VERSION,
      role: c.role,
      lastScanMs: this.collector.lastScan ? Date.now() : null,
    };
  }

  /** Scan, refresh limits, store locally, and push to the hub when this node is a collector. */
  cycle(): Promise<ScanResult> {
    this.#cycle ??= this.#runCycle().finally(() => {
      this.#cycle = null;
    });
    return this.#cycle;
  }

  async #runCycle(): Promise<ScanResult> {
    const scan = await this.collector.scan();
    if (this.options.readLimits !== false && Date.now() - this.#limitsAt > LIMITS_EVERY_MS) {
      this.#limitsAt = Date.now();
      this.#limits = await readLimits(this.readerContext(), this.config.value.deviceId).catch(() => this.#limits);
    }
    // The local store mirrors this device, so the local view works offline.
    const id = this.config.value.deviceId;
    let baseRev = this.store.deviceRev(id);
    if (baseRev > this.collector.rev) baseRev = 0;
    this.store.ingest({
      device: this.deviceInfo(),
      baseRev,
      rev: this.collector.rev,
      files: this.collector.changedSince(baseRev),
      sources: scan.sources,
      unknownFolders: scan.unknownFolders,
      limits: this.#limits,
    });
    await this.store.flush();
    if (this.role === "collector") await this.#push(scan);
    if (this.role === "hub") void this.refreshBilling(false);
    return scan;
  }

  async #push(scan: ScanResult): Promise<void> {
    const { hubUrl, hubToken } = this.config.value;
    if (!hubUrl || !hubToken) {
      this.#sync = { ...this.#sync, lastError: "Not paired with a hub yet." };
      return;
    }
    const send = this.options.sendToHub ?? ((url, token, payload) => httpIngest(this.#fetch, url, token, payload));
    try {
      const result = await this.#cursor.push(
        this.collector,
        hubUrl,
        (files, baseRev, rev) => ({
          device: this.deviceInfo(),
          baseRev,
          rev,
          files,
          sources: scan.sources,
          unknownFolders: scan.unknownFolders,
          limits: this.#limits,
        }),
        (payload) => send(hubUrl, hubToken, payload),
      );
      this.#sync = { lastPushAt: new Date().toISOString(), lastError: null, pushedFiles: this.#sync.pushedFiles + result.sent };
    } catch (error) {
      this.#sync = { ...this.#sync, lastError: error instanceof Error ? error.message : String(error) };
    }
  }

  start(): void {
    void this.rates.ensureFresh();
    void this.cycle().catch((e) => this.options.log?.(`scan failed: ${String(e)}`));
    const every = Math.max(30, this.config.value.scanIntervalSec) * 1000;
    this.#timer = setInterval(() => {
      void this.rates.ensureFresh();
      void this.cycle().catch((e) => this.options.log?.(`scan failed: ${String(e)}`));
    }, every);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#cycle?.catch(() => undefined);
    await this.store.flush();
  }

  // ---- Hub: pairing ----

  /** Trades the hub's current pair code for a device token. The code rotates after each use. */
  async pair(code: string, deviceId: string): Promise<string | null> {
    const c = this.config.value;
    if (c.role !== "hub" || code.trim().toUpperCase() !== c.pairCode) return null;
    const token = newToken();
    await this.config.update({ deviceTokens: { ...c.deviceTokens, [token]: deviceId }, pairCode: newPairCode() });
    return token;
  }

  deviceForToken(token: string): string | null {
    return this.config.value.deviceTokens[token] ?? null;
  }

  // ---- Hub: limits and money ----

  limits(): LimitSnapshot[] {
    return this.store.limits();
  }

  async setBillingKey(provider: BillingProvider, key: string | null): Promise<BillingSnapshot | null> {
    const keys = { ...this.config.value.billingKeys };
    if (key === null || key.trim() === "") {
      delete keys[provider];
      this.#billing.delete(provider);
      await this.config.update({ billingKeys: keys });
      await this.#saveBilling();
      return null;
    }
    keys[provider] = this.secrets.encrypt(key.trim());
    await this.config.update({ billingKeys: keys });
    const snap = await checkBilling(provider, key.trim(), this.#fetch);
    this.#billing.set(provider, snap);
    await this.#saveBilling();
    return snap;
  }

  async refreshBilling(force: boolean): Promise<void> {
    if (!force && Date.now() - this.#billingAt < BILLING_EVERY_MS) return;
    this.#billingAt = Date.now();
    if (!this.secrets.available) return;
    const entries = Object.entries(this.config.value.billingKeys) as [BillingProvider, string][];
    await Promise.all(
      entries.map(async ([provider, sealed]) => {
        let key: string;
        try {
          key = this.secrets.decrypt(sealed);
        } catch {
          return;
        }
        this.#billing.set(provider, await checkBilling(provider, key, this.#fetch));
      }),
    );
    await this.#saveBilling();
  }

  async #saveBilling() {
    await writeJsonAtomic(path.join(this.options.dataDir, "billing.json"), [...this.#billing.values()]);
  }

  money(): MoneySummary {
    const c = this.config.value;
    return {
      subscriptions: c.subscriptions,
      budgets: c.budgets,
      billing: [...this.#billing.values()],
      billingConfigured: Object.keys(c.billingKeys) as BillingProvider[],
    };
  }

  /** Writes one inbox line; used by `fleet log` and tests. */
  static inboxLine(entry: Record<string, unknown>): string {
    return `${JSON.stringify(entry)}\n`;
  }
}

async function httpIngest(fetchImpl: typeof fetch, url: string, token: string, payload: IngestPayload): Promise<IngestResult> {
  const response = await fetchImpl(new URL("/api/ingest", url), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 401) throw new Error("The hub no longer accepts this device. Pair it again.");
  if (!response.ok) throw new Error(`Hub answered HTTP ${response.status}`);
  return (await response.json()) as IngestResult;
}

export { encodeRecord };
