/**
 * Headless fleet for machines without a screen (Linux boxes, servers):
 *
 *   fleet run                 collect (and serve the dashboard if this is the hub)
 *   fleet pair <hub> <code>   report to the hub at <hub>, e.g. fleet pair pc:8742 ABC123
 *   fleet scan                scan once and print this device's last 7 days
 *   fleet status              show role, hub and sync state
 *   fleet log --model M --input N --output N [--cost USD] [--app NAME]
 *                             record one AI call from your own script
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "./core/config.ts";
import { UsageAggregator } from "./core/aggregate.ts";
import { TOOL_INFO } from "./core/types.ts";
import { normalizeHubUrl, startServer } from "./hub/server.ts";
import { FleetNode, VERSION } from "./node/fleet.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const dataDir = flag(args, "data") ?? defaultDataDir();
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`fleet ${VERSION}\n\nUsage:\n  fleet run\n  fleet pair <hub-address> <code>\n  fleet scan\n  fleet status\n  fleet log --model M --input N --output N [--cost USD] [--app NAME]\n\nData folder: ${dataDir}`);
    return;
  }
  if (command === "log") {
    const model = flag(args, "model");
    if (!model) throw new Error("--model is required");
    const line = {
      time: new Date().toISOString(),
      model,
      input: Number(flag(args, "input") ?? 0),
      output: Number(flag(args, "output") ?? 0),
      cacheRead: Number(flag(args, "cache-read") ?? 0),
      ...(flag(args, "cost") ? { costUsd: Number(flag(args, "cost")) } : {}),
      ...(flag(args, "app") ? { app: flag(args, "app") } : {}),
    };
    const inbox = path.join(dataDir, "inbox");
    await mkdir(inbox, { recursive: true });
    await appendFile(path.join(inbox, "cli.jsonl"), `${JSON.stringify(line)}\n`);
    console.log("logged");
    return;
  }

  const node = await FleetNode.open({ dataDir, log: (m) => console.error(`[fleet] ${m}`) });
  if (command === "pair") {
    const [hub, code] = args;
    if (!hub || !code) throw new Error("usage: fleet pair <hub-address> <code>");
    const hubUrl = normalizeHubUrl(hub);
    const res = await fetch(new URL("/api/pair", hubUrl), {
      method: "POST",
      body: JSON.stringify({ code, deviceId: node.config.value.deviceId }),
    });
    const body = (await res.json()) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new Error(body.error ?? `pairing failed (HTTP ${res.status})`);
    await node.config.update({ role: "collector", hubUrl, hubToken: body.token });
    await node.cycle();
    console.log(`Paired with ${hubUrl}. ${node.syncStatus.lastError ?? "First sync done."}`);
    await node.stop();
    return;
  }
  if (command === "status") {
    const c = node.config.value;
    console.log(JSON.stringify({ version: VERSION, device: c.deviceName, role: c.role, hub: c.hubUrl, dataDir }, null, 2));
    return;
  }
  if (command === "scan") {
    const scan = await node.cycle();
    await node.rates.ensureFresh();
    for (const s of scan.sources) console.log(`${s.provider.padEnd(12)} ${s.status.padEnd(8)} ${String(s.records).padStart(7)} records  ${s.homeLabel ?? ""} ${s.home}`);
    const today = new Date();
    const since = new Date(today.getTime() - 6 * 864e5).toISOString().slice(0, 10);
    const agg = new UsageAggregator({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, sinceDay: since, untilDay: today.toISOString().slice(0, 10), rates: node.rates.table });
    for (const { record, device } of node.store.records()) agg.add(record, device);
    const totals = new Map<string, { cost: number; tokens: number }>();
    for (const b of agg.finish().buckets) {
      const t = totals.get(b.provider) ?? { cost: 0, tokens: 0 };
      t.cost += b.costUsd;
      t.tokens += b.totals.uncachedInputTokens + b.totals.cachedInputTokens + b.totals.cacheCreationTokens + b.totals.outputTokens;
      totals.set(b.provider, t);
    }
    console.log("\nLast 7 days (API estimate):");
    for (const [tool, t] of [...totals].sort((a, b) => b[1].cost - a[1].cost)) {
      console.log(`  ${TOOL_INFO[tool as keyof typeof TOOL_INFO]?.label.padEnd(18) ?? tool}  $${t.cost.toFixed(2).padStart(9)}  ${(t.tokens / 1e6).toFixed(1)}M tokens`);
    }
    await node.stop();
    return;
  }
  if (command === "run") {
    const uiDir = path.join(__dirname, "ui");
    const server = await startServer({ node, uiDir });
    node.start();
    console.log(`fleet ${VERSION} running as ${node.role} on ${server.urls.join(", ")}`);
    const stop = async () => {
      await node.stop();
      await server.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    return;
  }
  throw new Error(`unknown command "${command}". Try: fleet help`);
}

main().catch((error) => {
  console.error(`fleet: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
