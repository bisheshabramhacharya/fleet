/**
 * Shared contracts. Bucket and summary shapes follow T3 Code's usage contract
 * (MIT, T3 Tools Inc.) so its usage page ports with few changes; fleet adds
 * device, project, credits and fidelity.
 */

export const CONTRACT_VERSION = 1 as const;

export interface ToolInfo {
  readonly label: string;
  /** Dashboard series color. */
  readonly color: string;
  /** Short note shown in source lists. */
  readonly vendor: string;
}

export const TOOL_INFO = {
  claude: { label: "Claude Code", color: "#e8794a", vendor: "Anthropic" },
  codex: { label: "Codex", color: "#f5f5f5", vendor: "OpenAI" },
  droid: { label: "Droid", color: "#f2b84b", vendor: "Factory" },
  commandcode: { label: "Command Code", color: "#7c9cff", vendor: "Command Code" },
  pi: { label: "Pi", color: "#3fb68b", vendor: "Pi" },
  omp: { label: "oh-my-pi", color: "#2dd4bf", vendor: "Pi" },
  opencode: { label: "OpenCode", color: "#5b9bd5", vendor: "OpenCode" },
  dsh: { label: "DeepSeek Harness", color: "#4d6bfe", vendor: "DeepSeek" },
  hermes: { label: "Hermes", color: "#c084fc", vendor: "Hermes" },
  grok: { label: "Grok", color: "#a1a1aa", vendor: "xAI" },
  cursor: { label: "Cursor", color: "#d4d4d8", vendor: "Cursor" },
  antigravity: { label: "Antigravity", color: "#60a5fa", vendor: "Google" },
  muse: { label: "Muse", color: "#f472b6", vendor: "Muse" },
  cline: { label: "Cline", color: "#facc15", vendor: "Cline" },
  gemini: { label: "Gemini CLI", color: "#4285f4", vendor: "Google" },
  zcode: { label: "Z Code", color: "#22d3ee", vendor: "Zhipu" },
  router9: { label: "9router", color: "#fb7185", vendor: "Router" },
  inbox: { label: "My scripts", color: "#94a3b8", vendor: "Inbox" },
} as const satisfies Record<string, ToolInfo>;

export type ToolId = keyof typeof TOOL_INFO;
export const TOOL_IDS = Object.keys(TOOL_INFO) as ToolId[];

export function isToolId(value: unknown): value is ToolId {
  return typeof value === "string" && Object.hasOwn(TOOL_INFO, value);
}

/** Input totals = uncached + cache read + cache write. Reasoning is already inside output. */
export interface TokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type UsageSpeed = "standard" | "fast" | "ultrafast";

/** "call": every record has its own time. "session": one total per session, placed on its last active time. */
export type Fidelity = "call" | "session";

export interface UsageRecord {
  readonly provider: ToolId;
  readonly timestampMs: number;
  readonly model: string;
  /** Model name to price with when it differs from the display name. */
  readonly rateModel?: string;
  readonly sessionId: string;
  /** Project folder or name, when the tool records one. */
  readonly project?: string;
  readonly totals: TokenTotals;
  readonly reportedCostUsd: number | null;
  /** Vendor credits the tool logged (for example Droid's Factory credits). */
  readonly credits?: number;
  readonly speed: UsageSpeed;
  /** Records sharing a key are counted once per tool. */
  readonly dedupeKey: string | null;
  readonly fidelity?: Fidelity;
}

export type UsageCostSource = "providerReported" | "modelPriced" | "unpriced";
export type UsageResolution = "day" | "hour";

export interface UsageCategoryCost {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface UsageBucket {
  day: string;
  hourStart?: string;
  provider: ToolId;
  model: string;
  device: string;
  project?: string;
  totals: TokenTotals;
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd?: UsageCategoryCost;
  fastCostUsd?: number;
  ultrafastCostUsd?: number;
  speedPremiumUsd?: number;
  costSource: UsageCostSource;
  records: number;
  unpricedRecords: number;
  sessions: number;
  credits?: number;
  /** Present when any record in the bucket is per-session. */
  fidelity?: "session";
}

export type SourceStatusKind = "ok" | "missing" | "partial" | "failed";

export interface SourceStatus {
  device: string;
  provider: ToolId;
  /** Folder the tool saves logs in. */
  home: string;
  /** Label for tools with several homes, for example "codex-personal". */
  homeLabel?: string;
  status: SourceStatusKind;
  scannedFiles: number;
  skippedFiles: number;
  malformedRecords: number;
  distinctSessions: number;
  records: number;
  fidelity: Fidelity;
  enabled: boolean;
  message: string | null;
}

export interface UnknownFolder {
  device: string;
  path: string;
  guess: string;
}

export type DevicePlatform = "win32" | "darwin" | "linux" | string;

export interface DeviceInfo {
  id: string;
  name: string;
  platform: DevicePlatform;
  hostname: string;
  version: string;
  role: "hub" | "collector";
  lastSeenMs: number;
  lastScanMs: number | null;
  /** Hub's view: heard from within the stale window. */
  online: boolean;
}

export interface PricingInfo {
  status: "fresh" | "cached" | "unavailable";
  source: string;
  fetchedAt: string | null;
  knownModels: number;
}

export interface UsageSummaryInput {
  sinceDay: string;
  untilDay: string;
  timeZone: string;
  resolution?: UsageResolution;
  sinceTime?: string;
  untilTime?: string;
}

export interface UsageSummary {
  contractVersion: number;
  readAt: string;
  timeZone: string;
  sinceDay: string;
  untilDay: string;
  buckets: UsageBucket[];
  sources: SourceStatus[];
  devices: DeviceInfo[];
  unknownFolders: UnknownFolder[];
  pricing: PricingInfo;
  scanDurationMs: number;
  /** True when a collector could not reach the hub and is showing only its own data. */
  localOnly?: boolean;
}

export interface ModelPriceOverride {
  inputCostPerMillionTokens: number;
  outputCostPerMillionTokens: number;
  cacheReadCostPerMillionTokens?: number;
  cacheWriteCostPerMillionTokens?: number;
}

// ---- Money ----

export interface Subscription {
  id: string;
  name: string;
  monthlyUsd: number;
  /** Day of month it renews, 1-31. */
  renewalDay: number;
  /** Tools whose usage this plan covers. */
  tools: ToolId[];
  active: boolean;
}

export interface Budget {
  id: string;
  /** null means all tools. */
  tool: ToolId | null;
  monthlyUsd: number;
}

export type BillingProvider = "deepseek" | "openai" | "anthropic" | "factory" | "openrouter";

export interface BillingSnapshot {
  provider: BillingProvider;
  checkedAt: string;
  ok: boolean;
  error: string | null;
  /** Prepaid balance left, when the provider has one. */
  balanceUsd: number | null;
  /** Spend billed so far this calendar month. */
  monthSpendUsd: number | null;
  /** Spend billed in the selected window, by day. */
  daily: { day: string; usd: number }[];
  currency: string;
  note: string | null;
}

export interface LimitWindow {
  label: string;
  usedPercent: number | null;
  used: number | null;
  limit: number | null;
  unit: string | null;
  resetsAt: string | null;
}

export interface LimitSnapshot {
  provider: ToolId;
  device: string;
  account: string | null;
  plan: string | null;
  checkedAt: string;
  ok: boolean;
  error: string | null;
  windows: LimitWindow[];
}

export interface MoneySummary {
  subscriptions: Subscription[];
  budgets: Budget[];
  billing: BillingSnapshot[];
  billingConfigured: BillingProvider[];
}
