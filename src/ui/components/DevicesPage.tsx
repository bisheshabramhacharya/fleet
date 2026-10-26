import { useState } from "react";
import { api, type DeviceSettings, type UsageSummary } from "../lib/api.ts";
import { formatCount, formatRelative } from "../lib/format.ts";
import { platformLabel, toolLabel } from "../lib/tools.ts";
import { ToolMark } from "./logos.tsx";
import { Button, Dialog, Input, Notice, Section } from "./ui.tsx";

export function DevicesPage({ summary, settings, onChanged }: { summary: UsageSummary | null; settings: DeviceSettings | null; onChanged: () => void }) {
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const devices = summary?.devices ?? [];
  const thisId = settings?.deviceId;

  return (
    <div className="flex flex-col gap-8">
      {settings ? <Pairing settings={settings} onChanged={onChanged} /> : null}

      <Section title="Devices">
        {devices.length === 0 ? <p className="text-sm text-muted-foreground">No devices have reported yet.</p> : null}
        <div className="flex flex-col gap-3">
          {devices.map((d) => {
            const sources = (summary?.sources ?? []).filter((s) => s.device === d.id && s.status !== "missing");
            const unknown = (summary?.unknownFolders ?? []).filter((f) => f.device === d.id);
            const stale = !d.online;
            return (
              <div key={d.id} className="flex flex-col gap-3 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${stale ? "bg-warning" : "bg-success"}`} />
                    <span className="truncate text-sm font-medium">{d.name}</span>
                    {d.id === thisId ? <span className="rounded-md bg-accent px-1.5 py-0.5 text-2xs text-muted-foreground">this device</span> : null}
                    <span className="rounded-md bg-accent px-1.5 py-0.5 text-2xs uppercase text-muted-foreground">{d.role}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span>
                      {platformLabel(d.platform)} · v{d.version} · seen {formatRelative(d.lastSeenMs)}
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => setRenaming({ id: d.id, name: d.name })}>
                      Rename
                    </Button>
                    {d.id !== thisId ? (
                      <Button size="xs" variant="ghost" onClick={() => setRemoving({ id: d.id, name: d.name })}>
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
                {stale ? <Notice tone="warning">{d.name} hasn't reported for over a day. Is it off, asleep, or off Tailscale?</Notice> : null}
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {sources.map((s) => (
                    <span key={s.home} className="flex items-center gap-1.5 text-xs" title={s.home}>
                      <ToolMark tool={s.provider} className="size-3.5" />
                      <span className={s.enabled ? "text-foreground" : "text-muted-foreground line-through"}>
                        {toolLabel(s.provider)}
                        {s.homeLabel ? ` · ${s.homeLabel}` : ""}
                      </span>
                      <span className="text-muted-foreground">
                        {s.status === "ok" ? `${formatCount(s.distinctSessions)} sessions` : s.status}
                        {s.fidelity === "session" ? " · per session" : ""}
                      </span>
                    </span>
                  ))}
                </div>
                {unknown.length > 0 ? (
                  <p className="text-xs text-muted-foreground">Found but not read yet: {unknown.map((u) => u.guess).join(", ")}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      </Section>

      {renaming ? (
        <Dialog title="Rename device" onClose={() => setRenaming(null)}>
          <div className="flex flex-col gap-3">
            <Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={async () => {
                  await api.renameDevice(renaming.id, renaming.name);
                  setRenaming(null);
                  onChanged();
                }}
              >
                Save
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
      {removing ? (
        <Dialog title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">It stops being able to send usage. Pair it again to bring it back.</p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await api.removeDevice(removing.id, true);
                  setRemoving(null);
                  onChanged();
                }}
              >
                Remove, keep history
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  await api.removeDevice(removing.id, false);
                  setRemoving(null);
                  onChanged();
                }}
              >
                Remove and delete history
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function Pairing({ settings, onChanged }: { settings: DeviceSettings; onChanged: () => void }) {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (settings.role === "hub") {
    const address = settings.tailscale[0] ? `${settings.tailscale[0]}:${settings.port}` : null;
    return (
      <Section title="Add a device">
        <div className="grid gap-4 rounded-xl border p-4 md:grid-cols-[auto_1fr]">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Pair code</span>
            <span className="font-mono text-2xl tracking-[0.25em]">{settings.pairCode}</span>
            <Button size="xs" variant="ghost" className="self-start" onClick={() => void api.rotatePairCode().then(onChanged)}>
              New code
            </Button>
          </div>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
            <li>Install fleet on the other machine and open it.</li>
            <li>
              In its Devices page, enter this hub's address
              {address ? (
                <>
                  : <span className="font-mono text-foreground">{address}</span>
                </>
              ) : (
                " (this PC's Tailscale name or IP, port " + settings.port + ")"
              )}
            </li>
            <li>Enter the pair code. Each code works once.</li>
            <li>
              Headless Linux box: <span className="font-mono text-foreground">fleet pair {address ?? "hub:8742"} {settings.pairCode}</span>
            </li>
          </ol>
        </div>
        {settings.tailscale.length === 0 ? (
          <Notice tone="warning">No Tailscale address found on this machine, so other devices can't reach this hub yet. Turn Tailscale on and restart fleet.</Notice>
        ) : null}
      </Section>
    );
  }

  return (
    <Section title="Hub connection">
      <div className="flex flex-col gap-3 rounded-xl border p-4 text-sm">
        {settings.paired ? (
          <p>
            Reporting to <span className="font-mono">{settings.hubUrl}</span>.{" "}
            {settings.sync.lastError ? <span className="text-destructive">Not syncing: {settings.sync.lastError}</span> : settings.sync.lastPushAt ? `Last sync ${formatRelative(settings.sync.lastPushAt)}.` : "Waiting for the first sync."}
          </p>
        ) : (
          <p className="text-muted-foreground">This device isn't paired with a hub yet.</p>
        )}
        <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
          <Input placeholder="Hub address, e.g. 100.64.0.5:8742 or pc:8742" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Input placeholder="Pair code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <Button
            size="sm"
            disabled={busy || !url || !code}
            onClick={async () => {
              setBusy(true);
              try {
                await api.connect(url, code);
                setError(null);
                onChanged();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {settings.paired ? "Re-pair" : "Pair"}
          </Button>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button size="xs" variant="ghost" className="self-start" onClick={() => void api.becomeHub().then(onChanged)}>
          Make this device the hub instead
        </Button>
      </div>
    </Section>
  );
}
