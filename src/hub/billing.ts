import type { BillingProvider, BillingSnapshot } from "../core/types.ts";

export const BILLING_PROVIDERS: { id: BillingProvider; label: string; keyHint: string; note: string }[] = [
  { id: "deepseek", label: "DeepSeek", keyHint: "sk-...", note: "Prepaid balance from api.deepseek.com." },
  { id: "openrouter", label: "OpenRouter", keyHint: "sk-or-...", note: "Credits bought and used." },
  { id: "openai", label: "OpenAI", keyHint: "Admin key (sk-admin-...)", note: "Daily costs from the organization costs API. Needs an admin key." },
  { id: "anthropic", label: "Anthropic", keyHint: "Admin key (sk-ant-admin...)", note: "Daily costs from the cost report. Needs an admin key." },
  { id: "factory", label: "Factory (Droid)", keyHint: "not available yet", note: "Factory has no public billing API yet. Droid credits come from its logs." },
];

type Fetch = typeof fetch;

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function base(provider: BillingProvider): BillingSnapshot {
  return {
    provider,
    checkedAt: new Date().toISOString(),
    ok: false,
    error: null,
    balanceUsd: null,
    monthSpendUsd: null,
    daily: [],
    currency: "USD",
    note: null,
  };
}

async function getJson(fetchImpl: Fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 200);
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  return response.json();
}

async function deepseek(key: string, fetchImpl: Fetch): Promise<BillingSnapshot> {
  const snap = base("deepseek");
  const doc = (await getJson(fetchImpl, "https://api.deepseek.com/user/balance", {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  })) as { balance_infos?: { currency?: string; total_balance?: string }[] };
  const infos = doc.balance_infos ?? [];
  const usd = infos.find((b) => b.currency === "USD") ?? infos[0];
  if (usd) {
    snap.balanceUsd = Number(usd.total_balance ?? 0);
    snap.currency = usd.currency ?? "USD";
  }
  snap.note = "DeepSeek reports balance only, not spend history.";
  snap.ok = true;
  return snap;
}

async function openrouter(key: string, fetchImpl: Fetch): Promise<BillingSnapshot> {
  const snap = base("openrouter");
  const doc = (await getJson(fetchImpl, "https://openrouter.ai/api/v1/credits", { Authorization: `Bearer ${key}` })) as {
    data?: { total_credits?: number; total_usage?: number };
  };
  const credits = doc.data?.total_credits ?? 0;
  const used = doc.data?.total_usage ?? 0;
  snap.balanceUsd = credits - used;
  snap.note = `Lifetime usage $${used.toFixed(2)} of $${credits.toFixed(2)} bought.`;
  snap.ok = true;
  return snap;
}

async function openai(key: string, fetchImpl: Fetch, now: Date): Promise<BillingSnapshot> {
  const snap = base("openai");
  const start = Math.floor((now.getTime() - 31 * 864e5) / 1000);
  const monthStart = monthStartUtc(now).toISOString().slice(0, 10);
  const daily = new Map<string, number>();
  let page: string | null = null;
  for (let i = 0; i < 5; i++) {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(start));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const doc = (await getJson(fetchImpl, url.toString(), { Authorization: `Bearer ${key}` })) as {
      data?: { start_time: number; results?: { amount?: { value?: number } }[] }[];
      has_more?: boolean;
      next_page?: string | null;
    };
    for (const bucket of doc.data ?? []) {
      const day = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
      const usd = (bucket.results ?? []).reduce((sum, r) => sum + (r.amount?.value ?? 0), 0);
      daily.set(day, (daily.get(day) ?? 0) + usd);
    }
    if (!doc.has_more || !doc.next_page) break;
    page = doc.next_page;
  }
  snap.daily = [...daily].map(([day, usd]) => ({ day, usd })).sort((a, b) => a.day.localeCompare(b.day));
  snap.monthSpendUsd = snap.daily.filter((d) => d.day >= monthStart).reduce((s, d) => s + d.usd, 0);
  snap.ok = true;
  return snap;
}

async function anthropic(key: string, fetchImpl: Fetch, now: Date): Promise<BillingSnapshot> {
  const snap = base("anthropic");
  const monthStart = monthStartUtc(now).toISOString().slice(0, 10);
  const daily = new Map<string, number>();
  let page: string | null = null;
  for (let i = 0; i < 5; i++) {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", new Date(now.getTime() - 31 * 864e5).toISOString().slice(0, 10) + "T00:00:00Z");
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const doc = (await getJson(fetchImpl, url.toString(), { "x-api-key": key, "anthropic-version": "2023-06-01" })) as {
      data?: { starting_at: string; results?: { amount?: string; currency?: string }[] }[];
      has_more?: boolean;
      next_page?: string | null;
    };
    for (const bucket of doc.data ?? []) {
      const day = bucket.starting_at.slice(0, 10);
      // Amounts are decimal strings in cents.
      const usd = (bucket.results ?? []).reduce((sum, r) => sum + Number(r.amount ?? 0) / 100, 0);
      daily.set(day, (daily.get(day) ?? 0) + usd);
    }
    if (!doc.has_more || !doc.next_page) break;
    page = doc.next_page;
  }
  snap.daily = [...daily].map(([day, usd]) => ({ day, usd })).sort((a, b) => a.day.localeCompare(b.day));
  snap.monthSpendUsd = snap.daily.filter((d) => d.day >= monthStart).reduce((s, d) => s + d.usd, 0);
  snap.ok = true;
  return snap;
}

/** Never throws: a failed check comes back as a snapshot with `ok: false` and the reason. */
export async function checkBilling(
  provider: BillingProvider,
  key: string,
  fetchImpl: Fetch = fetch,
  now = new Date(),
): Promise<BillingSnapshot> {
  try {
    switch (provider) {
      case "deepseek":
        return await deepseek(key, fetchImpl);
      case "openrouter":
        return await openrouter(key, fetchImpl);
      case "openai":
        return await openai(key, fetchImpl, now);
      case "anthropic":
        return await anthropic(key, fetchImpl, now);
      case "factory":
        return { ...base("factory"), error: "Factory has no public billing API yet." };
    }
  } catch (error) {
    return { ...base(provider), error: error instanceof Error ? error.message : String(error) };
  }
}
