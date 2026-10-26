import type { DeviceInfo, LimitSnapshot } from "../lib/api.ts";
import { formatRelative } from "../lib/format.ts";
import { toolLabel } from "../lib/tools.ts";
import { ToolMark } from "./logos.tsx";
import { Empty, Meter, Notice } from "./ui.tsx";

export function LimitsView({ limits, devices }: { limits: LimitSnapshot[] | null; devices: DeviceInfo[] }) {
  if (limits === null) return <Empty>Loading plan limits…</Empty>;
  const names = new Map(devices.map((d) => [d.id, d.name]));
  if (limits.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <Empty>No plan limits yet.</Empty>
        <Notice>
          Codex limits appear after any Codex request on a device. Claude limits appear on devices where Claude Code is logged in. Droid, Cursor and Grok plan meters are not available yet.
        </Notice>
      </div>
    );
  }
  return (
    <div className="grid gap-6 md:grid-cols-2">
      {limits.map((snap) => (
        <section key={`${snap.provider}:${snap.device}`} className="flex flex-col gap-4 rounded-xl border p-4">
          <header className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <ToolMark tool={snap.provider} className="size-4" />
              {toolLabel(snap.provider)}
              {snap.plan ? <span className="rounded-md bg-accent px-1.5 py-0.5 text-2xs font-normal uppercase text-muted-foreground">{snap.plan}</span> : null}
            </h2>
            <span className="text-xs text-muted-foreground">
              {names.get(snap.device) ?? "device"} · {formatRelative(snap.checkedAt)}
            </span>
          </header>
          {snap.error ? <p className="text-xs text-muted-foreground">{snap.error}</p> : null}
          {snap.windows.map((w) => (
            <div key={w.label} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{w.label}</span>
                <span className="tabular-nums">{w.usedPercent === null ? "-" : `${Math.round(w.usedPercent)}% used`}</span>
              </div>
              <Meter percent={w.usedPercent ?? 0} />
              {w.resetsAt ? <span className="text-xs text-muted-foreground">Resets {formatRelative(w.resetsAt)} · {new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</span> : null}
            </div>
          ))}
          {snap.provider === "codex" ? <p className="text-2xs text-muted-foreground">As of the last Codex request on this device.</p> : null}
        </section>
      ))}
    </div>
  );
}
