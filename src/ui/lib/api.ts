import type {
  Budget,
  DeviceInfo,
  LimitSnapshot,
  ModelPriceOverride,
  MoneySummary,
  Subscription,
  ToolId,
  UsageSummary,
} from "../../core/types.ts";
import type { UsageWindow } from "./format.ts";

export type { Budget, DeviceInfo, LimitSnapshot, ModelPriceOverride, MoneySummary, Subscription, ToolId, UsageSummary };

export interface DeviceSettings {
  deviceId: string;
  deviceName: string;
  role: "hub" | "collector";
  port: number;
  hubUrl: string | null;
  paired: boolean;
  pairCode: string | null;
  viewKey: string | null;
  disabledSources: string[];
  customHomes: Partial<Record<ToolId, string[]>>;
  hideProjects: boolean;
  scanIntervalSec: number;
  openAtLogin: boolean;
  inboxDir: string;
  version: string;
  platform: string;
  tailscale: string[];
  sync: { lastPushAt: string | null; lastError: string | null; pushedFiles: number };
  secretsAvailable: boolean;
  lastScan: { durationMs: number; changedFiles: number } | null;
}

export interface BillingProviderInfo {
  id: "deepseek" | "openai" | "anthropic" | "factory" | "openrouter";
  label: string;
  keyHint: string;
  note: string;
}

export interface FleetSettings {
  subscriptions: Subscription[];
  budgets: Budget[];
  priceOverrides: Record<string, ModelPriceOverride>;
  modelAliases: Record<string, string>;
  billingProviders: BillingProviderInfo[];
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // plain text error
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export function summaryQuery(window: UsageWindow): string {
  const params = new URLSearchParams({ since: window.sinceDay, until: window.untilDay, tz: window.timeZone, resolution: window.resolution });
  if (window.sinceTime) params.set("sinceTime", window.sinceTime);
  if (window.untilTime) params.set("untilTime", window.untilTime);
  return params.toString();
}

export const api = {
  summary: (window: UsageWindow) => request<UsageSummary>("GET", `/api/summary?${summaryQuery(window)}`),
  limits: () => request<LimitSnapshot[]>("GET", "/api/limits"),
  money: () => request<MoneySummary>("GET", "/api/money"),
  devices: () => request<DeviceInfo[]>("GET", "/api/devices"),
  scan: () => request<{ ok: boolean }>("POST", "/api/scan"),
  settings: () => request<DeviceSettings>("GET", "/api/settings"),
  saveSettings: (patch: Partial<DeviceSettings>) => request<DeviceSettings>("PUT", "/api/settings", patch),
  fleetSettings: () => request<FleetSettings>("GET", "/api/fleet-settings"),
  saveFleetSettings: (patch: Partial<FleetSettings>) => request<FleetSettings>("PUT", "/api/fleet-settings", patch),
  setBillingKey: (provider: string, key: string) => request<unknown>("PUT", `/api/billing/${provider}`, { key }),
  removeBillingKey: (provider: string) => request<unknown>("DELETE", `/api/billing/${provider}`),
  refreshBilling: () => request<MoneySummary>("POST", "/api/billing/refresh"),
  renameDevice: (id: string, name: string) => request<DeviceInfo[]>("PATCH", `/api/devices/${id}`, { name }),
  removeDevice: (id: string, keepHistory: boolean) => request<DeviceInfo[]>("DELETE", `/api/devices/${id}?keepHistory=${keepHistory ? 1 : 0}`),
  rotatePairCode: () => request<{ pairCode: string }>("POST", "/api/pair-code/rotate"),
  connect: (url: string, code: string) => request<DeviceSettings>("POST", "/api/connect", { url, code }),
  becomeHub: () => request<DeviceSettings>("POST", "/api/become-hub"),
  refreshRates: () => request<unknown>("POST", "/api/rates/refresh"),
};
