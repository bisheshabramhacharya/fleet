import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type DeviceSettings, type LimitSnapshot, type ToolId, type UsageSummary } from "./lib/api.ts";
import { customWindow, formatDateTimeShort, formatDayShort, formatRelative, makeWindow, type UsageWindow } from "./lib/format.ts";
import { merge, type Filters, type ModelTotals } from "./lib/merge.ts";
import { cn, toolLabel } from "./lib/tools.ts";
import { DevicesPage } from "./components/DevicesPage.tsx";
import { LimitsView } from "./components/LimitsView.tsx";
import { ToolMark } from "./components/logos.tsx";
import { ModelDialog } from "./components/ModelDialog.tsx";
import { MoneyPage } from "./components/MoneyPage.tsx";
import { SettingsPage, type Theme } from "./components/SettingsPage.tsx";
import { Button, Chevron, Empty, Input, InlineButton, Menu, MenuCheckbox, MenuItem, MenuSeparator, Notice, RefreshIcon, Segmented } from "./components/ui.tsx";
import { UsageOverview } from "./components/UsagePage.tsx";

type Page = "usage" | "money" | "devices" | "settings";
type Metric = "cost" | "tokens" | "limits";
type Range = "1" | "7" | "30" | "90" | "custom";

interface Prefs {
  page: Page;
  metric: Metric;
  range: Range;
  customSince: string;
  customUntil: string;
  theme: Theme;
  devices: string[] | null;
  tools: ToolId[] | null;
  projects: string[] | null;
}

const PREFS_KEY = "fleet:prefs:v1";
const DEFAULT_PREFS: Prefs = { page: "usage", metric: "cost", range: "7", customSince: "", customUntil: "", theme: "dark", devices: null, tools: null, projects: null };

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

const RANGES: { value: Range; label: string; key: string }[] = [
  { value: "1", label: "Past 24h", key: "d" },
  { value: "7", label: "7 days", key: "w" },
  { value: "30", label: "30 days", key: "m" },
  { value: "90", label: "90 days", key: "q" },
  { value: "custom", label: "Custom", key: "r" },
];
const METRICS: { value: Metric; label: string; key: string }[] = [
  { value: "cost", label: "Cost", key: "c" },
  { value: "tokens", label: "Tokens", key: "t" },
  { value: "limits", label: "Limits", key: "l" },
];

function windowFor(prefs: Prefs): UsageWindow {
  if (prefs.range === "custom" && prefs.customSince && prefs.customUntil && prefs.customSince <= prefs.customUntil) {
    return customWindow(prefs.customSince, prefs.customUntil);
  }
  return makeWindow(prefs.range === "custom" ? 30 : Number(prefs.range));
}

function useTheme(theme: Theme) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

export function App() {
  const [prefs, setPrefs] = useState(loadPrefs);
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  useTheme(prefs.theme);

  const [usageWindow, setUsageWindow] = useState(() => windowFor(prefs));
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [limits, setLimits] = useState<LimitSnapshot[] | null>(null);
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelTotals | null>(null);

  useEffect(() => setUsageWindow(windowFor(prefs)), [prefs.range, prefs.customSince, prefs.customUntil]);

  const load = useCallback(async (w: UsageWindow) => {
    try {
      const [s, st] = await Promise.all([api.summary(w), api.settings().catch(() => null)]);
      setSummary(s);
      if (st) setSettings(st);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load(usageWindow);
    const timer = setInterval(() => void load(usageWindow), 60_000);
    return () => clearInterval(timer);
  }, [usageWindow, load]);

  useEffect(() => {
    if (prefs.metric === "limits" && prefs.page === "usage") void api.limits().then(setLimits, () => setLimits([]));
  }, [prefs.metric, prefs.page]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await api.scan().catch(() => undefined);
      const w = windowFor(prefs);
      setUsageWindow(w);
      await load(w);
      if (prefs.metric === "limits") setLimits(await api.limits());
    } finally {
      setRefreshing(false);
    }
  };
  const reload = () => void load(usageWindow);

  // Keyboard shortcuts: c/t/l for the metric, d/w/m/q/r for the period.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.closest('[role="dialog"]'))) return;
      const metric = METRICS.find((m) => m.key === event.key);
      const range = RANGES.find((r) => r.key === event.key);
      if (metric) update({ metric: metric.value, page: "usage" });
      else if (range) update({ range: range.value, page: "usage" });
      else if (event.key === "R" && event.shiftKey) void refresh();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const filters: Filters = useMemo(
    () => ({
      devices: prefs.devices ? new Set(prefs.devices) : null,
      tools: prefs.tools ? new Set(prefs.tools) : null,
      projects: prefs.projects ? new Set(prefs.projects) : null,
    }),
    [prefs.devices, prefs.tools, prefs.projects],
  );
  const merged = useMemo(() => (summary ? merge(summary, filters) : null), [summary, filters]);
  const allProjects = useMemo(() => [...new Set((summary?.buckets ?? []).map((b) => b.project ?? ""))].sort(), [summary]);
  const allTools = useMemo(() => [...new Set((summary?.buckets ?? []).map((b) => b.provider))], [summary]);
  const devices = summary?.devices ?? [];
  const staleDevices = devices.filter((d) => !d.online);

  const windowLabel =
    usageWindow.resolution === "hour" && usageWindow.sinceTime && usageWindow.untilTime
      ? `${formatDateTimeShort(usageWindow.sinceTime, usageWindow.timeZone)} to ${formatDateTimeShort(usageWindow.untilTime, usageWindow.timeZone)}`
      : `${formatDayShort(usageWindow.sinceDay)} to ${formatDayShort(usageWindow.untilDay)}`;

  const isMac = (window as { fleetDesktop?: { platform: string } }).fleetDesktop?.platform === "darwin";

  return (
    <div className="flex h-full min-h-0">
      <nav className={cn("app-drag flex w-48 shrink-0 flex-col gap-0.5 border-r px-2 pb-3", isMac ? "pt-11" : "pt-3")}>
        <div className="mb-3 flex items-center gap-2 px-2">
          <FleetLogo />
          <span className="text-sm font-semibold tracking-tight">fleet</span>
        </div>
        {(
          [
            ["usage", "Usage", "M2 13h3V7H2zm4.5 0h3V3h-3zM11 13h3V9h-3z"],
            ["money", "Money", "M8 1.5v13M11.5 4H6.2a2.2 2.2 0 0 0 0 4.4h3.6a2.2 2.2 0 0 1 0 4.4H4.5"],
            ["devices", "Devices", "M2.5 3.5h11v7h-11zM6 13.5h4M8 10.5v3"],
            ["settings", "Settings", "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3"],
          ] as const
        ).map(([id, label, d]) => (
          <button
            key={id}
            type="button"
            onClick={() => update({ page: id })}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors",
              prefs.page === id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
              <path d={d} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {label}
            {id === "devices" && staleDevices.length > 0 ? <span className="ml-auto size-1.5 rounded-full bg-warning" /> : null}
          </button>
        ))}
        <div className="mt-auto flex flex-col gap-1 px-2 text-2xs text-muted-foreground">
          {devices.map((d) => (
            <span key={d.id} className="flex items-center gap-1.5 truncate">
              <span className={cn("size-1.5 shrink-0 rounded-full", d.online ? "bg-success" : "bg-warning")} />
              <span className="truncate">{d.name}</span>
            </span>
          ))}
          {summary ? <span className="mt-1">Updated {formatRelative(summary.readAt)}</span> : null}
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="app-drag @container flex min-h-12 shrink-0 items-center gap-2 border-b ps-5 pe-2">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-sm">
            <h1 className="shrink-0 font-medium">{{ usage: "Usage", money: "Money", devices: "Devices", settings: "Settings" }[prefs.page]}</h1>
            {prefs.page === "usage" ? (
              <>
                <Sep />
                <DeviceFilter devices={devices} value={prefs.devices} onChange={(v) => update({ devices: v })} />
                <Sep />
                <ToolFilter tools={allTools} value={prefs.tools} onChange={(v) => update({ tools: v })} />
                <Sep />
                <ProjectFilter projects={allProjects} value={prefs.projects} onChange={(v) => update({ projects: v })} />
                {prefs.metric !== "limits" ? <span className="ml-3 hidden truncate text-xs text-muted-foreground xl:block">{windowLabel}</span> : null}
              </>
            ) : null}
          </div>
          {prefs.page === "usage" ? (
            <div className="flex shrink-0 items-center gap-2">
              {prefs.metric !== "limits" ? (
                <>
                  {prefs.range === "custom" ? (
                    <span className="flex items-center gap-1">
                      <Input type="date" className="h-7 w-36 text-xs" value={prefs.customSince} onChange={(e) => update({ customSince: e.target.value })} />
                      <span className="text-xs text-muted-foreground">to</span>
                      <Input type="date" className="h-7 w-36 text-xs" value={prefs.customUntil} onChange={(e) => update({ customUntil: e.target.value })} />
                    </span>
                  ) : null}
                  <Segmented label="Period" value={prefs.range} onChange={(range) => update({ range })} options={RANGES.map((r) => ({ value: r.value, label: r.label, title: `${r.label} (${r.key})` }))} />
                </>
              ) : null}
              <Segmented label="Metric" value={prefs.metric} onChange={(metric) => update({ metric })} options={METRICS.map((m) => ({ value: m.value, label: m.label, title: `${m.label} (${m.key})` }))} />
              <Button variant="ghost" size="icon-sm" aria-label="Scan and refresh" title="Scan now and refresh (Shift+R)" disabled={refreshing} onClick={() => void refresh()}>
                <RefreshIcon spinning={refreshing} />
              </Button>
            </div>
          ) : null}
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-5 py-6 sm:px-8">
            {error ? (
              <Notice tone="error">Could not load usage: {error}</Notice>
            ) : prefs.page === "usage" ? (
              prefs.metric === "limits" ? (
                <LimitsView limits={limits} devices={devices} />
              ) : summary && merged ? (
                <UsageOverview summary={summary} merged={merged} window={usageWindow} metric={prefs.metric} onSelectModel={setSelectedModel} />
              ) : (
                <Empty>Reading your usage…</Empty>
              )
            ) : prefs.page === "money" ? (
              <MoneyPage onChanged={reload} />
            ) : prefs.page === "devices" ? (
              <DevicesPage summary={summary} settings={settings} onChanged={reload} />
            ) : (
              <SettingsPage settings={settings} summary={summary} window={usageWindow} theme={prefs.theme} onTheme={(theme) => update({ theme })} onChanged={reload} />
            )}
          </div>
        </main>
      </div>

      {selectedModel && summary && merged ? (
        <ModelDialog model={selectedModel} merged={merged} window={usageWindow} metric={prefs.metric === "tokens" ? "tokens" : "cost"} summary={summary} onClose={() => setSelectedModel(null)} onSaved={reload} />
      ) : null}
    </div>
  );
}

function Sep() {
  return <span className="shrink-0 px-0.5 text-muted-foreground/60">/</span>;
}

function FleetLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <rect width="24" height="24" rx="6" fill="currentColor" className="text-foreground" />
      <path d="M6 16.5 9.5 9l3 5 2-3.2L18 16.5" fill="none" stroke="var(--background)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function toggleIn<T>(list: T[] | null, all: T[], item: T): T[] | null {
  const current = list ?? all;
  const next = current.includes(item) ? current.filter((x) => x !== item) : [...current, item];
  return next.length === all.length ? null : next;
}

function DeviceFilter({ devices, value, onChange }: { devices: { id: string; name: string }[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const ids = devices.map((d) => d.id);
  const label = value === null ? "All devices" : value.length === 1 ? (devices.find((d) => d.id === value[0])?.name ?? "1 device") : `${value.length} devices`;
  return (
    <Menu
      trigger={({ toggle }) => (
        <InlineButton onClick={toggle} className="max-w-48">
          <span className="truncate">{label}</span>
          <Chevron />
        </InlineButton>
      )}
    >
      {() => (
        <>
          <MenuItem onClick={() => onChange(null)}>All devices</MenuItem>
          <MenuSeparator />
          {devices.map((d) => (
            <MenuCheckbox key={d.id} checked={value === null || value.includes(d.id)} onChange={() => onChange(toggleIn(value, ids, d.id))}>
              {d.name}
            </MenuCheckbox>
          ))}
        </>
      )}
    </Menu>
  );
}

function ToolFilter({ tools, value, onChange }: { tools: ToolId[]; value: ToolId[] | null; onChange: (v: ToolId[] | null) => void }) {
  const label = value === null ? "All tools" : value.length === 1 ? toolLabel(value[0]!) : `${value.length} tools`;
  return (
    <Menu
      trigger={({ toggle }) => (
        <InlineButton onClick={toggle} className="max-w-48">
          <span className="truncate">{label}</span>
          <Chevron />
        </InlineButton>
      )}
    >
      {() => (
        <>
          <MenuItem onClick={() => onChange(null)}>All tools</MenuItem>
          <MenuSeparator />
          {tools.map((t) => (
            <MenuCheckbox key={t} checked={value === null || value.includes(t)} onChange={() => onChange(toggleIn(value, tools, t))}>
              <ToolMark tool={t} className="size-3.5" />
              {toolLabel(t)}
            </MenuCheckbox>
          ))}
        </>
      )}
    </Menu>
  );
}

function ProjectFilter({ projects, value, onChange }: { projects: string[]; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const [query, setQuery] = useState("");
  const label = value === null ? "All projects" : value.length === 1 ? value[0] || "(no project)" : `${value.length} projects`;
  const shown = projects.filter((p) => p.toLowerCase().includes(query.toLowerCase()));
  return (
    <Menu
      className="w-72"
      trigger={({ toggle }) => (
        <InlineButton onClick={toggle} className="max-w-48">
          <span className="truncate">{label}</span>
          <Chevron />
        </InlineButton>
      )}
    >
      {() => (
        <>
          <div className="p-1">
            <Input autoFocus placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 text-xs" />
          </div>
          <MenuItem onClick={() => onChange(null)}>All projects</MenuItem>
          <MenuSeparator />
          {shown.map((p) => (
            <MenuCheckbox key={p} checked={value === null || value.includes(p)} onChange={() => onChange(value !== null && value.length === 1 && value[0] === p ? null : [p])}>
              <span className="truncate">{p || "(no project)"}</span>
            </MenuCheckbox>
          ))}
        </>
      )}
    </Menu>
  );
}
