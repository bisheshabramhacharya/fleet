/** Daily/hourly series chart. Ported from T3 Code's UsageProviderChart.tsx (MIT, T3 Tools Inc.). */
import { useLayoutEffect, useRef, useState } from "react";
import { formatDayShort, formatHourShort, formatTokens, formatUsd } from "../lib/format.ts";
import type { PeriodTotals, Totals } from "../lib/merge.ts";
import { cn, toolColor, toolLabel, type ToolId } from "../lib/tools.ts";
import { ToolMark } from "./logos.tsx";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;

export type ChartMetric = "tokens" | "cost";

interface Point {
  x: number;
  y: number;
}

export interface Series {
  key: string;
  label: string;
  color: string;
  tool?: ToolId;
  values: number[];
}

function monotoneTangents(points: readonly Point[]): number[] {
  const count = points.length;
  if (count < 2) return [0];
  const slopes: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const t: number[] = Array.from({ length: count }, () => 0);
  t[0] = slopes[0] ?? 0;
  t[count - 1] = slopes[count - 2] ?? 0;
  for (let i = 1; i < count - 1; i++) {
    const prev = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    t[i] = prev * next <= 0 ? 0 : (prev + next) / 2;
  }
  for (let i = 0; i < count - 1; i++) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / slope;
    const b = t[i + 1]! / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      t[i] = scale * a * slope;
      t[i + 1] = scale * b * slope;
    }
  }
  return t;
}

function curvePath(points: readonly Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M0,${points[0]!.y.toFixed(2)} L${VIEW_WIDTH},${points[0]!.y.toFixed(2)}`;
  const t = monotoneTangents(points);
  let path = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    const c1 = { x: from.x + dx / 3, y: from.y + (t[i]! * dx) / 3 };
    const c2 = { x: to.x - dx / 3, y: to.y - (t[i + 1]! * dx) / 3 };
    path += ` C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

function niceScale(peak: number, count: number): { max: number; ticks: number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };
  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) ticks.push(v);
  return { max, ticks };
}

const toY = (value: number, max: number) => (max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP));

/** One series per tool, built from merged period totals. */
export function toolSeries(periods: readonly string[], totals: readonly PeriodTotals[], tools: readonly ToolId[], metric: ChartMetric): Series[] {
  const byPeriod = new Map(totals.map((p) => [p.period, p]));
  const pick = (t: Totals | undefined) => (t === undefined ? 0 : metric === "tokens" ? t.totalTokens : t.costUsd);
  return tools.map((tool) => ({
    key: tool,
    label: toolLabel(tool),
    color: toolColor(tool),
    tool,
    values: periods.map((period) => pick(byPeriod.get(period)?.byProvider.get(tool))),
  }));
}

export function SeriesChart({
  periods,
  series,
  metric,
  resolution,
  timeZone,
  height = "h-56",
}: {
  periods: readonly string[];
  series: readonly Series[];
  metric: ChartMetric;
  resolution: "day" | "hour";
  timeZone: string;
  height?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const pos = useRef<Point | null>(null);

  const peak = series.reduce((max, s) => s.values.reduce((m, v) => Math.max(m, v), max), 0);
  const scale = niceScale(peak, TICK_COUNT);
  const stepX = periods.length < 2 ? 0 : VIEW_WIDTH / (periods.length - 1);
  const paths = series
    .map((s) => {
      const line = curvePath(s.values.map((v, i) => ({ x: i * stepX, y: toY(v, scale.max) })));
      return { ...s, line, area: line ? `${line} L${VIEW_WIDTH},${VIEW_HEIGHT} L0,${VIEW_HEIGHT} Z` : "", total: s.values.reduce((a, b) => a + b, 0) };
    })
    .sort((a, b) => b.total - a.total);
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const formatPeriod = (p: string) => (resolution === "hour" ? formatHourShort(p, timeZone) : formatDayShort(p));

  const place = () => {
    const plot = plotRef.current;
    const tip = tipRef.current;
    const p = pos.current;
    if (!plot || !tip || !p) return;
    const gap = 12;
    const left = p.x + gap + tip.offsetWidth <= plot.clientWidth ? p.x + gap : p.x - gap - tip.offsetWidth;
    const top = p.y + gap + tip.offsetHeight <= plot.clientHeight ? p.y + gap : p.y - gap - tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(0, left), Math.max(0, plot.clientWidth - tip.offsetWidth))}px`;
    tip.style.top = `${Math.min(Math.max(0, top), Math.max(0, plot.clientHeight - tip.offsetHeight))}px`;
  };
  useLayoutEffect(place);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className={cn("relative w-14 shrink-0", height)}>
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ top: `${(toY(tick, scale.max) / VIEW_HEIGHT) * 100}%` }}
            >
              {tick === 0 ? "0" : format(tick)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className={cn("relative flex-1", height)}
          onMouseMove={(event) => {
            const plot = plotRef.current;
            if (!plot || periods.length === 0) return;
            const b = plot.getBoundingClientRect();
            const x = Math.min(b.width, Math.max(0, event.clientX - b.left));
            const y = Math.min(b.height, Math.max(0, event.clientY - b.top));
            pos.current = { x, y };
            setHover(Math.min(periods.length - 1, Math.max(0, Math.round((x / b.width) * (periods.length - 1)))));
            place();
          }}
          onMouseLeave={() => {
            pos.current = null;
            setHover(null);
          }}
        >
          <svg className="h-full w-full" viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`${resolution === "hour" ? "Hourly" : "Daily"} ${metric}`}>
            {scale.ticks.map((tick) => (
              <line key={tick} x1={0} x2={VIEW_WIDTH} y1={toY(tick, scale.max)} y2={toY(tick, scale.max)} stroke="currentColor" strokeWidth={1} className="text-border" vectorEffect="non-scaling-stroke" />
            ))}
            {paths.map((p) => (
              <path key={`a-${p.key}`} d={p.area} fill={p.color} fillOpacity={0.12} />
            ))}
            {paths.map((p) => (
              <path key={`l-${p.key}`} d={p.line} fill="none" stroke={p.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            ))}
            {hover === null ? null : (
              <line x1={hover * stepX} x2={hover * stepX} y1={PLOT_TOP} y2={VIEW_HEIGHT} stroke="currentColor" strokeWidth={1} className="text-muted-foreground" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hover === null || periods[hover] === undefined ? null : (
            <div ref={tipRef} className="surface-glass pointer-events-none absolute z-10 min-w-40 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg">
              <div className="mb-1 text-muted-foreground">{formatPeriod(periods[hover]!)}</div>
              {paths
                .filter((p) => p.total > 0)
                .map((p) => (
                  <div key={p.key} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      {p.tool ? <ToolMark tool={p.tool} className="size-3" /> : <span className="size-2 rounded-full" style={{ background: p.color }} />}
                      {p.label}
                    </span>
                    <span className="text-foreground tabular-nums">{format(p.values[hover] ?? 0)}</span>
                  </div>
                ))}
              <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                <span className="text-muted-foreground">Total</span>
                <span className="text-foreground tabular-nums">{format(series.reduce((sum, s) => sum + (s.values[hover] ?? 0), 0))}</span>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-16 text-3xs uppercase text-muted-foreground">
        <span>{periods[0] ? formatPeriod(periods[0]) : ""}</span>
        <span>{periods[Math.floor(periods.length / 2)] ? formatPeriod(periods[Math.floor(periods.length / 2)]!) : ""}</span>
        <span>{periods[periods.length - 1] ? formatPeriod(periods[periods.length - 1]!) : ""}</span>
      </div>
    </div>
  );
}

export interface ShareSegment {
  label: string;
  value: number;
  color: string;
}

const ink = (percent: number) => `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;
export const TYPE_COLORS = { input: ink(60), cacheRead: ink(30), cacheWrite: ink(72), output: ink(100), other: ink(44) };

/** Ported from T3 Code's UsageShareBar.tsx (MIT, T3 Tools Inc.). */
export function ShareBar({ label, segments, format, aside }: { label: string; segments: readonly ShareSegment[]; format: (v: number) => string; aside?: React.ReactNode }) {
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{label}</h3>
        {aside}
      </div>
      <div className="flex h-2 gap-0.5" role="img" aria-label={`${label}: ${visible.map((s) => `${s.label} ${format(s.value)}`).join(", ")}`}>
        {visible.map((s) => (
          <div
            key={s.label}
            title={`${s.label} · ${format(s.value)} · ${((s.value / total) * 100).toFixed(1)}%`}
            className="h-full min-w-1 rounded-xs first:rounded-l-full last:rounded-r-full"
            style={{ flex: `${s.value} 1 0`, backgroundColor: s.color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {visible.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-xs" style={{ backgroundColor: s.color }} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="text-foreground tabular-nums">{format(s.value)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
