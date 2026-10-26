import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BillingProvider, Budget, ModelPriceOverride, Subscription, ToolId } from "./types.ts";

export const DEFAULT_PORT = 8742;

export interface FleetConfig {
  deviceId: string;
  deviceName: string;
  role: "hub" | "collector";
  port: number;
  /** Collector role: where to send usage. */
  hubUrl: string | null;
  hubToken: string | null;
  /** Hub role: short code a new device enters to pair. */
  pairCode: string;
  /** Hub role: device token -> device id. */
  deviceTokens: Record<string, string>;
  /** Hub role: key for viewing the dashboard from a browser on another device. */
  viewKey: string;
  /** "tool" or "tool:homeDir" entries that are switched off. */
  disabledSources: string[];
  customHomes: Partial<Record<ToolId, string[]>>;
  /** Scramble project names before they leave this device. */
  hideProjects: boolean;
  scanIntervalSec: number;
  openAtLogin: boolean;
  subscriptions: Subscription[];
  budgets: Budget[];
  priceOverrides: Record<string, ModelPriceOverride>;
  modelAliases: Record<string, string>;
  /** Encrypted with the OS keychain; never plain text. */
  billingKeys: Partial<Record<BillingProvider, string>>;
}

export function newPairCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function defaultDeviceName(): string {
  const host = os.hostname().replace(/\.local$/, "");
  if (process.platform === "win32") return host.length > 0 ? host : "Windows PC";
  return host.length > 0 ? host : process.platform;
}

export function defaultConfig(): FleetConfig {
  return {
    deviceId: randomUUID(),
    deviceName: defaultDeviceName(),
    role: "hub",
    port: DEFAULT_PORT,
    hubUrl: null,
    hubToken: null,
    pairCode: newPairCode(),
    deviceTokens: {},
    viewKey: newToken(),
    disabledSources: ["router9"],
    customHomes: {},
    hideProjects: false,
    scanIntervalSec: 120,
    openAtLogin: true,
    subscriptions: [],
    budgets: [],
    priceOverrides: {},
    modelAliases: {},
    billingKeys: {},
  };
}

export class ConfigStore {
  #config: FleetConfig;
  readonly file: string;

  private constructor(file: string, config: FleetConfig) {
    this.file = file;
    this.#config = config;
  }

  static async open(dataDir: string): Promise<ConfigStore> {
    const file = path.join(dataDir, "config.json");
    let stored: Partial<FleetConfig> = {};
    let fresh = false;
    try {
      stored = JSON.parse(await readFile(file, "utf8")) as Partial<FleetConfig>;
    } catch {
      fresh = true;
    }
    const store = new ConfigStore(file, { ...defaultConfig(), ...stored });
    if (fresh) await store.save();
    return store;
  }

  get value(): Readonly<FleetConfig> {
    return this.#config;
  }

  async update(patch: Partial<FleetConfig>): Promise<FleetConfig> {
    this.#config = { ...this.#config, ...patch };
    await this.save();
    return this.#config;
  }

  async save(): Promise<void> {
    await writeJsonAtomic(this.file, this.#config);
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}

export function defaultDataDir(): string {
  const home = os.homedir();
  if (process.env.FLEET_DATA_DIR) return process.env.FLEET_DATA_DIR;
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "fleet");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "fleet");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "fleet");
}
