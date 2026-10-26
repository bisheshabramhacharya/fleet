import { useEffect, useState } from "react";
import { api, type Budget, type FleetSettings, type MoneySummary, type Subscription, type ToolId, type UsageSummary } from "../lib/api.ts";
import { formatRelative, formatUsd } from "../lib/format.ts";
import { merge, NO_FILTERS } from "../lib/merge.ts";
import { TOOL_IDS, toolLabel } from "../lib/tools.ts";
import { ToolMark } from "./logos.tsx";
import { Button, Dialog, Empty, Input, Meter, Notice, Section } from "./ui.tsx";

const LOW_BALANCE_USD = 5;

function monthWindow() {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { sinceDay: `${today.slice(0, 8)}01`, untilDay: today, timeZone: tz, resolution: "day" as const };
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function MoneyPage({ onChanged }: { onChanged: () => void }) {
  const [month, setMonth] = useState<UsageSummary | null>(null);
  const [money, setMoney] = useState<MoneySummary | null>(null);
  const [fleet, setFleet] = useState<FleetSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [budgetEdit, setBudgetEdit] = useState<Budget | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);

  const load = async () => {
    try {
      const [m, s, f] = await Promise.all([api.summary(monthWindow()), api.money(), api.fleetSettings()]);
      setMonth(m);
      setMoney(s);
      setFleet(f);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!month || !money || !fleet) return <Empty>Loading…</Empty>;

  const merged = merge(month, NO_FILTERS);
  const byTool = new Map(merged.providers.map((p) => [p.provider, p]));
  const toolCost = (tool: ToolId) => byTool.get(tool)?.costUsd ?? 0;
  const activeSubs = money.subscriptions.filter((s) => s.active);
  const subsTotal = activeSubs.reduce((sum, s) => sum + s.monthlyUsd, 0);
  const billedTotal = money.billing.reduce((sum, b) => sum + (b.monthSpendUsd ?? 0), 0);
  const lowBalances = money.billing.filter((b) => b.ok && b.balanceUsd !== null && b.balanceUsd < LOW_BALANCE_USD);
  const budgetStatus = money.budgets.map((b) => {
    const spent = b.tool === null ? merged.costUsd : toolCost(b.tool);
    return { budget: b, spent, ratio: b.monthlyUsd > 0 ? spent / b.monthlyUsd : 0 };
  });
  const nearBudgets = budgetStatus.filter((s) => s.ratio >= 0.8);

  const saveFleet = async (patch: Partial<FleetSettings>) => {
    setFleet(await api.saveFleetSettings(patch));
    setMoney(await api.money());
    onChanged();
  };

  return (
    <div className="flex flex-col gap-8">
      {lowBalances.map((b) => (
        <Notice key={b.provider} tone="warning">
          {b.provider} balance is low: {formatUsd(b.balanceUsd ?? 0)} left. Top up before your tools stop.
        </Notice>
      ))}
      {nearBudgets.map((s) => (
        <Notice key={s.budget.id} tone={s.ratio >= 1 ? "error" : "warning"}>
          {s.budget.tool === null ? "Overall" : toolLabel(s.budget.tool)} budget is at {Math.round(s.ratio * 100)}% ({formatUsd(s.spent)} of {formatUsd(s.budget.monthlyUsd)}) this month.
        </Notice>
      ))}

      <section className="grid gap-6 sm:grid-cols-3">
        <Big label="What I paid this month" value={formatUsd(subsTotal + billedTotal)} hint={`${formatUsd(subsTotal)} subscriptions + ${formatUsd(billedTotal)} billed API`} />
        <Big label="API value this month" value={formatUsd(merged.costUsd)} hint="What the same tokens would cost at API prices" />
        <Big
          label="Value ratio"
          value={subsTotal + billedTotal > 0 ? `${(merged.costUsd / (subsTotal + billedTotal)).toFixed(1)}×` : "-"}
          hint="API value divided by what you paid"
        />
      </section>

      <Section
        title="Subscriptions"
        aside={
          <Button size="xs" variant="outline" onClick={() => setEditing({ id: newId(), name: "", monthlyUsd: 20, renewalDay: 1, tools: [], active: true })}>
            Add subscription
          </Button>
        }
      >
        {money.subscriptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add the plans you pay for (Claude Max, ChatGPT Pro, Factory, Command Code…) to see whether each one pays off.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-right text-xs text-muted-foreground">
                <th className="py-2 text-left font-normal">Plan</th>
                <th className="py-2 text-left font-normal">Covers</th>
                <th className="py-2 pl-4 font-normal">Price</th>
                <th className="py-2 pl-4 font-normal">API value</th>
                <th className="py-2 pl-4 font-normal">Ratio</th>
                <th className="py-2 pl-4 font-normal" />
              </tr>
            </thead>
            <tbody>
              {money.subscriptions.map((s) => {
                const value = s.tools.reduce((sum, t) => sum + toolCost(t), 0);
                const ratio = s.monthlyUsd > 0 ? value / s.monthlyUsd : 0;
                return (
                  <tr key={s.id} className="border-b border-border/50 text-right tabular-nums">
                    <td className="py-2.5 text-left">
                      {s.name}
                      {!s.active ? <span className="ml-2 text-xs text-muted-foreground">paused</span> : null}
                      <div className="text-2xs text-muted-foreground">renews on day {s.renewalDay}</div>
                    </td>
                    <td className="py-2.5 text-left">
                      <span className="flex flex-wrap gap-1.5">
                        {s.tools.map((t) => (
                          <span key={t} className="flex items-center gap-1 text-xs text-muted-foreground">
                            <ToolMark tool={t} className="size-3" />
                            {toolLabel(t)}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="py-2.5 pl-4">{formatUsd(s.monthlyUsd)}</td>
                    <td className="py-2.5 pl-4">{formatUsd(value)}</td>
                    <td className={ratio >= 1 ? "py-2.5 pl-4 text-success" : "py-2.5 pl-4 text-warning-foreground"}>{ratio.toFixed(1)}×</td>
                    <td className="py-2.5 pl-4">
                      <Button size="xs" variant="ghost" onClick={() => setEditing(s)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title="Billed spend"
        aside={
          <Button size="xs" variant="ghost" onClick={() => void api.refreshBilling().then(setMoney)}>
            Check now
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">Real charges from provider accounts. Kept apart from the API estimate and never added to it.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {fleet.billingProviders.map((p) => {
            const snap = money.billing.find((b) => b.provider === p.id);
            const configured = money.billingConfigured.includes(p.id);
            return (
              <div key={p.id} className="flex flex-col gap-2 rounded-xl border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  {p.id === "factory" ? null : configured ? (
                    <span className="flex gap-1">
                      <Button size="xs" variant="ghost" onClick={() => setKeyFor(p.id)}>
                        Change key
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => void api.removeBillingKey(p.id).then(load)}>
                        Remove
                      </Button>
                    </span>
                  ) : (
                    <Button size="xs" variant="outline" onClick={() => setKeyFor(p.id)}>
                      Connect
                    </Button>
                  )}
                </div>
                {snap?.ok ? (
                  <div className="flex gap-6 text-sm tabular-nums">
                    {snap.balanceUsd !== null ? <span>Balance {formatUsd(snap.balanceUsd)}</span> : null}
                    {snap.monthSpendUsd !== null ? <span>This month {formatUsd(snap.monthSpendUsd)}</span> : null}
                  </div>
                ) : null}
                {snap?.error ? <p className="text-xs text-destructive">{snap.error}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {snap?.note ?? p.note}
                  {snap ? ` Checked ${formatRelative(snap.checkedAt)}.` : ""}
                </p>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Monthly budgets"
        aside={
          <Button size="xs" variant="outline" onClick={() => setBudgetEdit({ id: newId(), tool: null, monthlyUsd: 100 })}>
            Add budget
          </Button>
        }
      >
        <p className="text-xs text-muted-foreground">Measured against this month's API estimate.</p>
        {budgetStatus.length === 0 ? <p className="text-sm text-muted-foreground">No budgets yet.</p> : null}
        {budgetStatus.map(({ budget, spent, ratio }) => (
          <div key={budget.id} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex items-center gap-2">
                {budget.tool ? <ToolMark tool={budget.tool} className="size-3.5" /> : null}
                {budget.tool === null ? "All tools" : toolLabel(budget.tool)}
              </span>
              <span className="flex items-center gap-2 tabular-nums">
                {formatUsd(spent)} of {formatUsd(budget.monthlyUsd)}
                <Button size="xs" variant="ghost" onClick={() => setBudgetEdit(budget)}>
                  Edit
                </Button>
              </span>
            </div>
            <Meter percent={ratio * 100} />
          </div>
        ))}
      </Section>

      {editing ? (
        <SubscriptionDialog
          value={editing}
          onClose={() => setEditing(null)}
          onSave={async (s, remove) => {
            const rest = money.subscriptions.filter((x) => x.id !== s.id);
            await saveFleet({ subscriptions: remove ? rest : [...rest, s] });
            setEditing(null);
          }}
        />
      ) : null}
      {budgetEdit ? (
        <BudgetDialog
          value={budgetEdit}
          onClose={() => setBudgetEdit(null)}
          onSave={async (b, remove) => {
            const rest = money.budgets.filter((x) => x.id !== b.id);
            await saveFleet({ budgets: remove ? rest : [...rest, b] });
            setBudgetEdit(null);
          }}
        />
      ) : null}
      {keyFor ? <KeyDialog provider={fleet.billingProviders.find((p) => p.id === keyFor)!} onClose={() => setKeyFor(null)} onSaved={() => void load()} /> : null}
    </div>
  );
}

function Big({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-3xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

function ToolPicker({ value, onChange, multiple }: { value: ToolId[]; onChange: (v: ToolId[]) => void; multiple: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {TOOL_IDS.map((t) => {
        const on = value.includes(t);
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(multiple ? (on ? value.filter((x) => x !== t) : [...value, t]) : on ? [] : [t])}
            className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${on ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:bg-accent"}`}
          >
            <ToolMark tool={t} className="size-3" />
            {toolLabel(t)}
          </button>
        );
      })}
    </div>
  );
}

function SubscriptionDialog({ value, onClose, onSave }: { value: Subscription; onClose: () => void; onSave: (s: Subscription, remove: boolean) => Promise<void> }) {
  const [s, setS] = useState(value);
  return (
    <Dialog title={value.name ? `Edit ${value.name}` : "Add subscription"} onClose={onClose}>
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Name
          <Input value={s.name} placeholder="Claude Max" onChange={(e) => setS({ ...s, name: e.target.value })} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Monthly price (USD)
            <Input inputMode="decimal" value={String(s.monthlyUsd)} onChange={(e) => setS({ ...s, monthlyUsd: Number(e.target.value) || 0 })} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Renews on day
            <Input inputMode="numeric" value={String(s.renewalDay)} onChange={(e) => setS({ ...s, renewalDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })} />
          </label>
        </div>
        <span className="text-xs text-muted-foreground">Tools this plan covers</span>
        <ToolPicker multiple value={s.tools} onChange={(tools) => setS({ ...s, tools })} />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={s.active} onChange={(e) => setS({ ...s, active: e.target.checked })} />
          Active
        </label>
        <div className="flex justify-between gap-2 pt-2">
          {value.name ? (
            <Button variant="ghost" size="sm" onClick={() => void onSave(s, true)}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" disabled={!s.name.trim()} onClick={() => void onSave({ ...s, name: s.name.trim() }, false)}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function BudgetDialog({ value, onClose, onSave }: { value: Budget; onClose: () => void; onSave: (b: Budget, remove: boolean) => Promise<void> }) {
  const [b, setB] = useState(value);
  return (
    <Dialog title="Monthly budget" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Monthly limit (USD)
          <Input inputMode="decimal" value={String(b.monthlyUsd)} onChange={(e) => setB({ ...b, monthlyUsd: Number(e.target.value) || 0 })} />
        </label>
        <span className="text-xs text-muted-foreground">One tool, or none selected for all tools</span>
        <ToolPicker multiple={false} value={b.tool ? [b.tool] : []} onChange={(v) => setB({ ...b, tool: v[0] ?? null })} />
        <div className="flex justify-between pt-2">
          <Button variant="ghost" size="sm" onClick={() => void onSave(b, true)}>
            Delete
          </Button>
          <Button size="sm" onClick={() => void onSave(b, false)}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function KeyDialog({ provider, onClose, onSaved }: { provider: { id: string; label: string; keyHint: string; note: string }; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={`Connect ${provider.label}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">{provider.note} The key is encrypted with your system keychain and never leaves this hub.</p>
        <Input type="password" autoFocus placeholder={provider.keyHint} value={key} onChange={(e) => setKey(e.target.value)} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={busy || !key.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await api.setBillingKey(provider.id, key.trim());
                onSaved();
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save and check
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

