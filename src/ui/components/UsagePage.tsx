/** The usage overview. Layout follows T3 Code's UsagePage.tsx (MIT, T3 Tools Inc.). */
import { useState } from "react";
import type { UsageSummary } from "../lib/api.ts";
import { enumerateDays, enumerateHourStarts, formatCount, formatDayShort, formatHourShort, formatPercent, formatTokens, formatUsd, type UsageWindow } from "../lib/format.ts";
import { groupRows, isCostUnknown, type GroupBy, type Merged, type ModelTotals } from "../lib/merge.ts";
import { cn, toolColor, toolLabel } from "../lib/tools.ts";
import { SeriesChart, ShareBar, toolSeries, TYPE_COLORS, type ChartMetric } from "./Chart.tsx";
import { ToolMark } from "./logos.tsx";
import { Info, Notice, Segmented } from "./ui.tsx";

export function UsageOverview({
  summary,
  merged,
  window,
  metric,
  onSelectModel,
}: {
  summary: UsageSummary;
  merged: Merged;
  window: UsageWindow;
  metric: ChartMetric;
  onSelectModel: (model: ModelTotals) => void;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("model");
  const hourly = window.resolution === "hour";
  const periods = hourly && window.sinceTime && window.untilTime ? enumerateHourStarts(window.sinceTime, window.untilTime) : enumerateDays(window.sinceDay, window.untilDay);
  const tools = merged.providers.filter((p) => p.totalTokens > 0 || p.costUsd > 0).map((p) => p.provider);
  const deviceNames = new Map(summary.devices.map((d) => [d.id, d.name]));
  const rows = groupRows(merged, groupBy, deviceNames, toolLabel);
  const peak = rows.reduce((m, r) => Math.max(m, metric === "tokens" ? r.totalTokens : r.costUsd), 0);
  const problems = summary.sources.filter((s) => s.enabled && (s.status === "failed" || s.status === "partial") && s.message);
  const perSessionTools = merged.providers.filter((p) => p.perSession).map((p) => toolLabel(p.provider));

  return (
    <div className="flex flex-col gap-6">
      {summary.localOnly ? (
        <Notice tone="warning">The hub can't be reached, so this shows only this device's usage.</Notice>
      ) : null}
      {problems.map((s) => (
        <p key={`${s.device}:${s.home}`} className="text-sm text-muted-foreground">
          {toolLabel(s.provider)} ({deviceNames.get(s.device) ?? "device"}): {s.message}
        </p>
      ))}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <span className="text-4xl font-semibold text-foreground tabular-nums">{metric === "cost" ? formatUsd(merged.costUsd) : formatTokens(merged.totalTokens)}</span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span>
                {formatCount(merged.sessions)} sessions{metric === "cost" ? " · API estimate" : ""}
              </span>
              {metric === "cost" && merged.unpricedShare > 0 ? (
                <Info>API estimate excludes {formatPercent(merged.unpricedShare)} of tokens from unpriced models. Set a price for them in Settings → Model prices.</Info>
              ) : null}
            </span>
          </div>

          {merged.providers.length === 0 ? <p className="text-sm text-muted-foreground">No usage in this window yet.</p> : null}
          {merged.providers.map((p) => {
            const share = metric === "cost" ? p.costShare : p.tokenShare;
            return (
              <div key={p.provider} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                    <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: toolColor(p.provider) }} />
                    <ToolMark tool={p.provider} className="size-4" />
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate">{toolLabel(p.provider)}</span>
                      <span className="shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums">
                        {formatCount(p.sessions)} {p.sessions === 1 ? "session" : "sessions"}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                    {metric === "cost" ? (isCostUnknown(p) ? "Unpriced" : formatUsd(p.costUsd)) : formatTokens(p.totalTokens)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {metric === "cost" ? `${formatPercent(share)} of cost · ${formatTokens(p.totalTokens)} tokens` : `${formatPercent(share)} of tokens · ${formatUsd(p.costUsd)}`}
                  {p.credits > 0 ? ` · ${formatTokens(p.credits)} credits` : ""}
                </span>
              </div>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            {hourly ? "Hourly" : "Daily"} {metric === "tokens" ? "processed tokens" : "cost"}
            {perSessionTools.length > 0 ? (
              <Info>
                {perSessionTools.join(", ")} only save one total per session, so their usage sits on the session's last active {hourly ? "hour" : "day"}. Their daily shape is approximate.
              </Info>
            ) : null}
          </h2>
          <SeriesChart periods={periods} series={toolSeries(periods, merged.periods, tools, metric)} metric={metric} resolution={hourly ? "hour" : "day"} timeZone={window.timeZone} />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">Totals</h2>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-6">
          <Metric label="Processed tokens" value={formatTokens(merged.totalTokens)} />
          <Metric label="Cached input" value={formatTokens(merged.cachedInputTokens)} />
          <Metric label="Uncached input" value={formatTokens(merged.uncachedInputTokens)} />
          <Metric label="Output" value={formatTokens(merged.outputTokens)} hint={merged.reasoningTokens > 0 ? `${formatTokens(merged.reasoningTokens)} reasoning` : undefined} />
          <Metric label="Cache writes" value={formatTokens(merged.cacheCreationTokens)} />
          <Metric label="Cache savings" value={formatUsd(merged.cacheSavingsUsd)} />
        </div>
      </section>

      {merged.totalTokens > 0 ? (
        <section className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
          {metric === "tokens" ? (
            <ShareBar
              label="Tokens by type"
              format={formatTokens}
              segments={[
                { label: "Input", value: merged.uncachedInputTokens, color: TYPE_COLORS.input },
                { label: "Cache read", value: merged.cachedInputTokens, color: TYPE_COLORS.cacheRead },
                { label: "Cache write", value: merged.cacheCreationTokens, color: TYPE_COLORS.cacheWrite },
                { label: "Output", value: merged.outputTokens, color: TYPE_COLORS.output },
              ]}
            />
          ) : (
            <ShareBar
              label="Cost by type"
              format={formatUsd}
              segments={[
                { label: "Input", value: merged.categoryCost.input, color: TYPE_COLORS.input },
                { label: "Cache read", value: merged.categoryCost.cacheRead, color: TYPE_COLORS.cacheRead },
                { label: "Cache write", value: merged.categoryCost.cacheWrite, color: TYPE_COLORS.cacheWrite },
                { label: "Output", value: merged.categoryCost.output, color: TYPE_COLORS.output },
                { label: "Other", value: merged.categoryCost.unsplit >= 0.005 ? merged.categoryCost.unsplit : 0, color: TYPE_COLORS.other },
              ]}
            />
          )}
          <ShareBar
            label={metric === "tokens" ? "Tokens by tool" : "Cost by tool"}
            format={metric === "tokens" ? formatTokens : formatUsd}
            segments={merged.providers.map((p) => ({ label: toolLabel(p.provider), value: metric === "tokens" ? p.totalTokens : p.costUsd, color: toolColor(p.provider) }))}
          />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
          <Segmented
            label="Breakdown"
            value={groupBy}
            onChange={setGroupBy}
            options={[
              { value: "model", label: "Model" },
              { value: "day", label: hourly ? "Hour" : "Day" },
              { value: "device", label: "Device" },
              { value: "project", label: "Project" },
              { value: "tool", label: "Tool" },
            ]}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-right text-xs text-muted-foreground">
                <th className="py-2 pr-3 text-left font-normal">#</th>
                <th className="w-full py-2 text-left font-normal">{{ model: "Model", day: hourly ? "Hour" : "Day", device: "Device", project: "Project", tool: "Tool" }[groupBy]}</th>
                <th className="py-2 pl-6 font-normal">Cost</th>
                <th className="hidden py-2 pl-6 font-normal sm:table-cell">Share</th>
                <th className="py-2 pl-6 font-normal">Tokens</th>
                <th className="hidden py-2 pl-6 font-normal md:table-cell">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-muted-foreground">
                    No activity in this window.
                  </td>
                </tr>
              ) : (
                rows.map((row, index) => {
                  const value = metric === "tokens" ? row.totalTokens : row.costUsd;
                  const share = metric === "tokens" ? row.tokenShare : row.costShare;
                  const model = groupBy === "model" ? merged.models.find((m) => `${m.provider}:${m.model}` === row.key) : undefined;
                  const label =
                    groupBy === "day" ? (hourly ? formatHourShort(row.key, window.timeZone) : formatDayShort(row.key)) : row.label;
                  return (
                    <tr key={row.key} className="relative whitespace-nowrap border-b border-border/50 text-right text-muted-foreground tabular-nums transition-colors hover:bg-muted/50">
                      <td className="py-2.5 pr-3 text-left text-xs">{index + 1}</td>
                      <td className="whitespace-normal py-2.5 text-left">
                        <button
                          type="button"
                          disabled={!model}
                          onClick={() => model && onSelectModel(model)}
                          className={cn("flex items-center gap-2 text-left text-foreground outline-none", model && "cursor-pointer after:absolute after:inset-0")}
                        >
                          {row.provider ? <ToolMark tool={row.provider} className="size-3.5" /> : null}
                          <span className="break-all">{label}</span>
                          {row.perSession ? <span className="text-2xs text-muted-foreground">per session</span> : null}
                        </button>
                        {value > 0 && peak > 0 ? (
                          <div aria-hidden className="mt-1.5 h-0.5 max-w-48">
                            <div className="h-full rounded-full" style={{ width: `max(0.5rem, ${(value / peak) * 100}%)`, backgroundColor: row.provider ? toolColor(row.provider) : "var(--foreground)" }} />
                          </div>
                        ) : null}
                      </td>
                      <td className="py-2.5 pl-6 text-foreground">{isCostUnknown(row) ? <span className="text-muted-foreground">Unpriced</span> : formatUsd(row.costUsd)}</td>
                      <td className="hidden py-2.5 pl-6 sm:table-cell">{formatPercent(share)}</td>
                      <td className="py-2.5 pl-6">{formatTokens(row.totalTokens)}</td>
                      <td className="hidden py-2.5 pl-6 md:table-cell">{formatCount(row.sessions)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
      {hint ? <span className="text-2xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
