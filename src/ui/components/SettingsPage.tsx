import { useEffect, useState } from "react";
import { api, summaryQuery, type DeviceSettings, type FleetSettings, type UsageSummary } from "../lib/api.ts";
import { formatRelative, formatUsd, type UsageWindow } from "../lib/format.ts";
import { toolLabel, type ToolId } from "../lib/tools.ts";
import { ToolMark } from "./logos.tsx";
import { Button, Input, Notice, Section, Segmented, Switch } from "./ui.tsx";

export type Theme = "dark" | "light" | "system";

export function SettingsPage({
  settings,
  summary,
  window,
  theme,
  onTheme,
  onChanged,
}: {
  settings: DeviceSettings | null;
  summary: UsageSummary | null;
  window: UsageWindow;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onChanged: () => void;
}) {
  const [fleet, setFleet] = useState<FleetSettings | null>(null);
  const [name, setName] = useState(settings?.deviceName ?? "");
  const [homeDraft, setHomeDraft] = useState<{ tool: ToolId; dir: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.fleetSettings().then(setFleet, (e) => setError(String(e)));
  }, []);
  useEffect(() => setName(settings?.deviceName ?? ""), [settings?.deviceName]);
  if (!settings) return null;

  const save = async (patch: Partial<DeviceSettings>) => {
    try {
      await api.saveSettings(patch);
      setError(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const mySources = (summary?.sources ?? []).filter((s) => s.device === settings.deviceId);
  const toggleSource = (key: string, enabled: boolean) => {
    const off = new Set(settings.disabledSources);
    if (enabled) off.delete(key);
    else off.add(key);
    void save({ disabledSources: [...off] });
  };
  const remoteUrl = settings.role === "hub" && settings.tailscale[0] ? `http://${settings.tailscale[0]}:${settings.port}/?key=${settings.viewKey}` : null;

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {error ? <Notice tone="error">{error}</Notice> : null}

      <Section title="This device">
        <Row label="Name">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="w-56" />
            <Button size="sm" variant="outline" disabled={name.trim() === settings.deviceName} onClick={() => void save({ deviceName: name.trim() })}>
              Save
            </Button>
          </div>
        </Row>
        <Row label="Role" hint={settings.role === "hub" ? "Stores usage from every device and serves this dashboard." : "Sends its usage to the hub."}>
          <span className="text-sm capitalize">{settings.role}</span>
        </Row>
        <Row label="Open at login" hint="Runs quietly in the tray so usage is always collected.">
          <Switch label="Open at login" checked={settings.openAtLogin} onChange={(v) => void save({ openAtLogin: v })} />
        </Row>
        <Row label="Hide project names" hint="Scrambles folder names before they leave this device.">
          <Switch label="Hide project names" checked={settings.hideProjects} onChange={(v) => void save({ hideProjects: v })} />
        </Row>
        <Row label="Scan every" hint={settings.lastScan ? `Last scan took ${settings.lastScan.durationMs} ms.` : undefined}>
          <Segmented
            label="Scan interval"
            value={String(settings.scanIntervalSec)}
            onChange={(v) => void save({ scanIntervalSec: Number(v) })}
            options={[
              { value: "60", label: "1 min" },
              { value: "120", label: "2 min" },
              { value: "300", label: "5 min" },
              { value: "900", label: "15 min" },
            ]}
          />
        </Row>
        <Row label="Theme">
          <Segmented label="Theme" value={theme} onChange={onTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
        </Row>
      </Section>

      <Section title="Sources on this device">
        <p className="text-xs text-muted-foreground">Each folder fleet reads. Only token counts, model names, times and project folder names are kept, never chat text.</p>
        <div className="flex flex-col divide-y divide-border/60 rounded-xl border">
          {mySources.map((s) => {
            const key = `${s.provider}:${s.home}`;
            const enabled = !settings.disabledSources.includes(s.provider) && !settings.disabledSources.includes(key);
            return (
              <div key={key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <ToolMark tool={s.provider} className="size-4" />
                  <div className="min-w-0">
                    <div className="text-sm">
                      {toolLabel(s.provider)}
                      {s.homeLabel ? <span className="text-muted-foreground"> · {s.homeLabel}</span> : null}
                    </div>
                    <div className="truncate font-mono text-2xs text-muted-foreground" title={s.home}>
                      {s.home}
                    </div>
                  </div>
                </div>
                <Switch label={`Read ${toolLabel(s.provider)}`} checked={enabled} onChange={(v) => toggleSource(key, v)} />
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">Add a folder for a tool that saves its logs somewhere unusual</span>
          <div className="flex gap-2">
            <select
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm dark:bg-input/20"
              value={homeDraft?.tool ?? "claude"}
              onChange={(e) => setHomeDraft({ tool: e.target.value as ToolId, dir: homeDraft?.dir ?? "" })}
            >
              {(["claude", "codex", "droid", "commandcode", "pi", "omp", "opencode", "dsh", "grok"] as ToolId[]).map((t) => (
                <option key={t} value={t}>
                  {toolLabel(t)}
                </option>
              ))}
            </select>
            <Input placeholder="Full folder path" value={homeDraft?.dir ?? ""} onChange={(e) => setHomeDraft({ tool: homeDraft?.tool ?? "claude", dir: e.target.value })} />
            <Button
              size="sm"
              variant="outline"
              disabled={!homeDraft?.dir.trim()}
              onClick={() => {
                if (!homeDraft) return;
                const homes = { ...settings.customHomes };
                homes[homeDraft.tool] = [...(homes[homeDraft.tool] ?? []), homeDraft.dir.trim()];
                void save({ customHomes: homes });
                setHomeDraft(null);
              }}
            >
              Add
            </Button>
          </div>
          {Object.entries(settings.customHomes).flatMap(([tool, dirs]) =>
            (dirs ?? []).map((dir) => (
              <div key={`${tool}:${dir}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="font-mono text-muted-foreground">
                  {toolLabel(tool as ToolId)}: {dir}
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    const homes = { ...settings.customHomes, [tool]: (dirs ?? []).filter((d) => d !== dir) };
                    void save({ customHomes: homes });
                  }}
                >
                  Remove
                </Button>
              </div>
            )),
          )}
        </div>
      </Section>

      <Section title="Your own scripts">
        <p className="text-sm text-muted-foreground">
          Any script can report an AI call by adding one JSON line to a <span className="font-mono">.jsonl</span> file in this folder:
        </p>
        <code className="block break-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{settings.inboxDir}</code>
        <pre className="overflow-x-auto rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{`{"time":"2026-10-26T18:00:00Z","app":"listing-hub","model":"gpt-6.1-sol","input":1200,"output":300,"costUsd":0.004}`}</pre>
        <p className="text-xs text-muted-foreground">
          Or from a shell: <span className="font-mono">fleet log --app listing-hub --model gpt-6.1-sol --input 1200 --output 300</span>
        </p>
      </Section>

      {fleet ? (
        <Section title="Model prices">
          <p className="text-xs text-muted-foreground">
            Prices you set win over the public table and apply to all history. Prices: {summary?.pricing.status ?? "?"} · {summary?.pricing.knownModels.toLocaleString() ?? 0} models
            {summary?.pricing.fetchedAt ? ` · updated ${formatRelative(summary.pricing.fetchedAt)}` : ""}.{" "}
            <button type="button" className="cursor-pointer underline" onClick={() => void api.refreshRates().then(onChanged)}>
              Refresh now
            </button>
          </p>
          {Object.keys(fleet.priceOverrides).length === 0 ? (
            <p className="text-sm text-muted-foreground">No custom prices. Click a model in the Usage breakdown to set one.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="py-2 text-left font-normal">Model</th>
                  <th className="py-2 pl-4 font-normal">Input</th>
                  <th className="py-2 pl-4 font-normal">Output</th>
                  <th className="py-2 pl-4 font-normal">Cache read</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {Object.entries(fleet.priceOverrides).map(([model, p]) => (
                  <tr key={model} className="border-b border-border/50 text-right tabular-nums">
                    <td className="py-2 text-left font-mono text-xs">{model}</td>
                    <td className="py-2 pl-4">{formatUsd(p.inputCostPerMillionTokens)}</td>
                    <td className="py-2 pl-4">{formatUsd(p.outputCostPerMillionTokens)}</td>
                    <td className="py-2 pl-4">{formatUsd(p.cacheReadCostPerMillionTokens ?? p.inputCostPerMillionTokens)}</td>
                    <td className="py-2 pl-2">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={async () => {
                          const next = { ...fleet.priceOverrides };
                          delete next[model];
                          setFleet(await api.saveFleetSettings({ priceOverrides: next }));
                          onChanged();
                        }}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      ) : null}

      <Section title="Export">
        <div className="flex flex-wrap gap-2">
          <a className="inline-flex h-7 items-center rounded-lg border border-input px-2.5 text-sm hover:bg-accent" href={`/api/export.csv?${summaryQuery(window)}`}>
            Download CSV (current range)
          </a>
          <a className="inline-flex h-7 items-center rounded-lg border border-input px-2.5 text-sm hover:bg-accent" href={`/api/summary?${summaryQuery(window)}`} download="fleet-usage.json">
            Download JSON
          </a>
        </div>
      </Section>

      {remoteUrl ? (
        <Section title="Open from your phone or another computer">
          <p className="text-xs text-muted-foreground">Works on any device signed in to your Tailscale. Keep this link private: it unlocks the dashboard.</p>
          <code className="block break-all rounded-lg border bg-muted px-3 py-2 font-mono text-xs">{remoteUrl}</code>
        </Section>
      ) : null}

      <p className="text-xs text-muted-foreground">
        fleet v{settings.version} · data in {settings.inboxDir.replace(/[\\/]inbox$/, "")} · built on T3 Code's usage page (MIT).
      </p>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 py-2.5">
      <div className="flex flex-col">
        <span className="text-sm">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
