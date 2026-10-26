import { useState } from "react";
import { api, type FleetSettings, type UsageSummary } from "../lib/api.ts";
import { enumerateDays, enumerateHourStarts, formatPercent, formatTokens, formatUsd, type UsageWindow } from "../lib/format.ts";
import type { Merged, ModelTotals } from "../lib/merge.ts";
import { toolColor, toolLabel } from "../lib/tools.ts";
import { SeriesChart, type ChartMetric } from "./Chart.tsx";
import { ToolMark } from "./logos.tsx";
import { Button, Dialog, Input, Notice } from "./ui.tsx";

/** One model's daily trend, token mix and the price used, plus a price override form. */
export function ModelDialog({
  model,
  merged,
  window,
  metric,
  summary,
  onClose,
  onSaved,
}: {
  model: ModelTotals;
  merged: Merged;
  window: UsageWindow;
  metric: ChartMetric;
  summary: UsageSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const hourly = window.resolution === "hour";
  const periods = hourly && window.sinceTime && window.untilTime ? enumerateHourStarts(window.sinceTime, window.untilTime) : enumerateDays(window.sinceDay, window.untilDay);
  const values = new Map<string, number>();
  for (const b of merged.buckets) {
    if (b.provider !== model.provider || b.model !== model.model) continue;
    const key = b.hourStart ?? b.day;
    const v = metric === "tokens" ? b.totals.uncachedInputTokens + b.totals.cachedInputTokens + b.totals.cacheCreationTokens + b.totals.outputTokens : b.costUsd;
    values.set(key, (values.get(key) ?? 0) + v);
  }
  const input = model.uncachedInputTokens + model.cachedInputTokens + model.cacheCreationTokens;
  const hitRate = input > 0 ? model.cachedInputTokens / input : null;
  const perMillion = model.totalTokens - model.unpricedTokens > 0 ? (model.costUsd / (model.totalTokens - model.unpricedTokens)) * 1e6 : null;
  const [price, setPrice] = useState({ input: "", output: "", cacheRead: "", cacheWrite: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const n = (v: string) => (v.trim() === "" ? undefined : Number(v));
    const inputPrice = n(price.input);
    const outputPrice = n(price.output);
    if (inputPrice === undefined || outputPrice === undefined || Number.isNaN(inputPrice) || Number.isNaN(outputPrice)) {
      setError("Enter at least the input and output price per million tokens.");
      return;
    }
    setSaving(true);
    try {
      const current: FleetSettings = await api.fleetSettings();
      const cacheRead = n(price.cacheRead);
      const cacheWrite = n(price.cacheWrite);
      await api.saveFleetSettings({
        priceOverrides: {
          ...current.priceOverrides,
          [model.model]: {
            inputCostPerMillionTokens: inputPrice,
            outputCostPerMillionTokens: outputPrice,
            ...(cacheRead !== undefined ? { cacheReadCostPerMillionTokens: cacheRead } : {}),
            ...(cacheWrite !== undefined ? { cacheWriteCostPerMillionTokens: cacheWrite } : {}),
          },
        },
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      wide
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <ToolMark tool={model.provider} className="size-4" />
          {model.model}
          <span className="text-muted-foreground">· {toolLabel(model.provider)}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Cost" value={model.unpricedRecords === model.records ? "Unpriced" : formatUsd(model.costUsd)} />
          <Stat label="Tokens" value={formatTokens(model.totalTokens)} />
          <Stat label="Cache hit rate" value={hitRate === null ? "-" : formatPercent(hitRate)} />
          <Stat label="Effective $/M tokens" value={perMillion === null ? "-" : formatUsd(perMillion)} />
        </div>
        <SeriesChart
          height="h-40"
          periods={periods}
          metric={metric}
          resolution={hourly ? "hour" : "day"}
          timeZone={window.timeZone}
          series={[{ key: model.model, label: model.model, color: toolColor(model.provider), tool: model.provider, values: periods.map((p) => values.get(p) ?? 0) }]}
        />
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Stat label="Uncached input" value={formatTokens(model.uncachedInputTokens)} />
          <Stat label="Cache read" value={formatTokens(model.cachedInputTokens)} />
          <Stat label="Cache write" value={formatTokens(model.cacheCreationTokens)} />
          <Stat label="Output" value={formatTokens(model.outputTokens)} />
        </div>
        <p className="text-xs text-muted-foreground">
          {model.costSource === "providerReported"
            ? `Cost comes from what ${toolLabel(model.provider)} logged for each call.`
            : model.costSource === "unpriced"
              ? "The public price table doesn't know this model. Set a price below to include it."
              : `Priced from the LiteLLM price table (${summary.pricing.knownModels.toLocaleString()} models, ${summary.pricing.status}).`}
        </p>
        <div className="flex flex-col gap-2 rounded-xl border p-4">
          <h3 className="text-sm font-medium">Set a price for {model.model}</h3>
          <p className="text-xs text-muted-foreground">US dollars per million tokens. Applies to all history, on every device.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
              <label key={k} className="flex flex-col gap-1 text-xs text-muted-foreground">
                {{ input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" }[k]}
                <Input inputMode="decimal" placeholder={k.startsWith("cache") ? "same as input" : "0.00"} value={price[k]} onChange={(e) => setPrice({ ...price, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex justify-end">
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              Save price
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium tabular-nums">{value}</span>
    </div>
  );
}
