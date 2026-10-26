import { mkdir, mkdtemp, rm, utimes, writeFile, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageSummary } from "../src/core/types.ts";
import { FleetNode } from "../src/node/fleet.ts";
import { startServer, type RunningServer } from "../src/hub/server.ts";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const DAY = "2026-10-20";
const at = (hh: string) => `${DAY}T${hh}:00:00.000Z`;

/** A tiny LiteLLM price table: $1/M input, $0.10/M cache read, $1.25/M cache write, $5/M output. */
const PRICES = {
  "claude-opus-5-5": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
  },
  "gpt-6.1-sol": { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6, cache_read_input_token_cost: 2e-7 },
};
// Only the price table is faked; pushes between devices use real HTTP.
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) =>
  String(input instanceof Request ? input.url : input).includes("litellm")
    ? new Response(JSON.stringify(PRICES), { status: 200 })
    : fetch(input, init)) as typeof fetch;

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

async function write(file: string, content: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

function claudeLine(id: string, hh: string, usage: Record<string, number>, cwd = "/work/alpha") {
  return {
    type: "assistant",
    timestamp: at(hh),
    sessionId: "claude-session-1",
    requestId: `req-${id}`,
    cwd,
    message: { id: `msg-${id}`, model: "claude-opus-5-5", usage },
  };
}

/** PC: Claude (with a repeated content-block line), Droid, Command Code, Hermes. */
async function buildPcHome(home: string) {
  const claude = path.join(home, ".claude", "projects", "alpha", "s1.jsonl");
  await write(
    claude,
    jsonl([
      claudeLine("a", "10", { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 }),
      // Same message, second content block: must count once.
      claudeLine("a", "10", { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 }),
      { type: "user", timestamp: at("10"), message: { role: "user", content: "never leaves the device" } },
    ]),
  );

  const droidDir = path.join(home, ".factory", "sessions", "-work-beta");
  await write(path.join(droidDir, "d1.jsonl"), jsonl([{ type: "session_start", id: "d1", cwd: "/work/beta" }]));
  await write(
    path.join(droidDir, "d1.settings.json"),
    JSON.stringify({
      model: "claude-opus-5-5",
      tokenUsage: { inputTokens: 500, outputTokens: 1000, cacheCreationTokens: 2000, cacheReadTokens: 100000, thinkingTokens: 300, factoryCredits: 4242 },
      inclusiveTokenUsage: { inputTokens: 999999, outputTokens: 999999 },
    }),
  );
  const droidTime = new Date(at("15"));
  await utimes(path.join(droidDir, "d1.settings.json"), droidTime, droidTime);

  await write(
    path.join(home, ".commandcode", "projects", "beta", "c1.jsonl"),
    jsonl([
      { type: "session", id: "c1", cwd: "/work/beta" },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-10-26T00:00:00.000Z",
        message: { role: "assistant", meta: { createdAt: Date.parse(at("11")) } },
        usage: { inputTokens: 3000, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.0123 },
        model: "deepseek/deepseek-v4.1-flash",
      },
    ]),
  );

  const hermesDir = path.join(home, ".hermes", "profiles", "thing2");
  await mkdir(hermesDir, { recursive: true });
  const db = new DatabaseSync(path.join(hermesDir, "state.db"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT);
    CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, task TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
      estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT, first_seen REAL, last_seen REAL);`);
  db.prepare("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "h1", "gpt-6.1-sol", "openai-codex", "", 4000, 500, 6000, 0, 50, 0, 0, "included", Date.parse(at("08")) / 1000, Date.parse(at("09")) / 1000,
  );
  db.close();
}

/** MacBook: Codex (cumulative counters), DeepSeek Harness (zstd), Pi. */
async function buildMacHome(home: string) {
  await write(
    path.join(home, ".codex", "sessions", "2026", "10", "20", "rollout-x.jsonl"),
    jsonl([
      { type: "session_meta", timestamp: at("12"), payload: { id: "codex-1", cwd: "/Users/me/gamma" } },
      { type: "turn_context", timestamp: at("12"), payload: { model: "gpt-6.1-sol" } },
      {
        type: "event_msg",
        timestamp: at("12"),
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 5300 },
            total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 5300 },
          },
        },
      },
      // A re-emitted counter with the same totals is not a new request.
      {
        type: "event_msg",
        timestamp: at("12"),
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 5300 },
            total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 5300 },
          },
        },
      },
    ]),
  );
  const dsh = jsonl([
    { type: "session", id: "dsh-1", cwd: "/Users/me/delta", createdAt: Date.parse(at("13")) },
    {
      type: "assistant/message",
      time: Date.parse(at("13")),
      data: { usage: { inputTokens: 700, outputTokens: 70, cacheReadTokens: 7000 }, message: { id: "x1", source: { model: "deepseek/deepseek-v4.1-flash" } } },
    },
  ]);
  await write(path.join(home, ".dsh", "sessions", "--Users-me-delta--", "dsh-1", "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(dsh)));
  await write(
    path.join(home, ".pi", "agent", "sessions", "p", "2026_pi1.jsonl"),
    jsonl([
      { type: "session", id: "pi-1", cwd: "/Users/me/gamma" },
      { type: "message", id: "e1", timestamp: at("14"), message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0 } } },
    ]),
  );
}

interface Fleet {
  root: string;
  hub: FleetNode;
  mac: FleetNode;
  server: RunningServer;
}

async function makeFleet(): Promise<Fleet> {
  const root = await mkdtemp(path.join(os.tmpdir(), "fleet-test-"));
  const pcHome = path.join(root, "pc-home");
  const macHome = path.join(root, "mac-home");
  await buildPcHome(pcHome);
  await buildMacHome(macHome);
  const common = { fetch: fakeFetch, readLimits: false, env: {} };
  const hub = await FleetNode.open({ ...common, dataDir: path.join(root, "pc-data"), homeDir: pcHome, platform: "win32" });
  await hub.config.update({ deviceName: "PC" });
  const server = await startServer({ node: hub, hosts: ["127.0.0.1"], port: 0 });
  const mac = await FleetNode.open({ ...common, dataDir: path.join(root, "mac-data"), homeDir: macHome, platform: "darwin" });
  await mac.config.update({ deviceName: "MacBook" });
  return { root, hub, mac, server };
}

async function summary(server: RunningServer, extra = ""): Promise<UsageSummary> {
  const res = await fetch(`${server.urls[0]}/api/summary?since=2026-10-01&until=2026-10-31&tz=UTC${extra}`);
  if (res.status !== 200) throw new Error(`summary HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as UsageSummary;
}

function byTool(s: UsageSummary) {
  const out: Record<string, { input: number; cached: number; write: number; output: number; cost: number; credits: number; records: number }> = {};
  for (const b of s.buckets) {
    const t = (out[b.provider] ??= { input: 0, cached: 0, write: 0, output: 0, cost: 0, credits: 0, records: 0 });
    t.input += b.totals.uncachedInputTokens;
    t.cached += b.totals.cachedInputTokens;
    t.write += b.totals.cacheCreationTokens;
    t.output += b.totals.outputTokens;
    t.cost += b.costUsd;
    t.credits += b.credits ?? 0;
    t.records += b.records;
  }
  return out;
}

async function pairMac(f: Fleet) {
  const res = await fetch(`${f.server.urls[0]}/api/pair`, {
    method: "POST",
    body: JSON.stringify({ code: f.hub.config.value.pairCode, deviceId: f.mac.config.value.deviceId }),
  });
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  await f.mac.config.update({ role: "collector", hubUrl: f.server.urls[0]!, hubToken: token });
}

describe("fleet hub on a two-device fixture fleet", () => {
  let f: Fleet;
  beforeEach(async () => {
    f = await makeFleet();
  });
  afterEach(async () => {
    await f.server.close();
    await f.hub.stop();
    await f.mac.stop();
    await rm(f.root, { recursive: true, force: true });
  });

  it("shows every tool from both devices, priced on the hub", async () => {
    await pairMac(f);
    await f.hub.cycle();
    await f.mac.cycle();
    expect(f.mac.syncStatus.lastError).toBeNull();

    const s = await summary(f.server);
    const names = Object.fromEntries(s.devices.map((d) => [d.id, d.name]));
    expect(Object.values(names).sort()).toEqual(["MacBook", "PC"]);

    const tools = byTool(s);
    // Claude: the repeated content-block line counts once; $1/M in, $0.10/M cache, $5/M out.
    expect(tools.claude).toMatchObject({ input: 1000, cached: 10000, output: 200, records: 1 });
    expect(tools.claude!.cost).toBeCloseTo(0.001 + 0.001 + 0.001, 9);
    // Droid: own usage only (not the child-inclusive totals), credits kept, per-session.
    expect(tools.droid).toMatchObject({ input: 500, cached: 100000, write: 2000, output: 1000, credits: 4242 });
    // Command Code: cache reads come out of input; its own cost wins.
    expect(tools.commandcode).toMatchObject({ input: 1000, cached: 2000, output: 100 });
    expect(tools.commandcode!.cost).toBeCloseTo(0.0123, 9);
    // Hermes: plan-included calls still get an API estimate.
    expect(tools.hermes).toMatchObject({ input: 4000, cached: 6000, output: 500 });
    expect(tools.hermes!.cost).toBeCloseTo(4000 * 2e-6 + 6000 * 2e-7 + 500 * 8e-6, 9);
    // Codex: input includes cached; the re-emitted counter is ignored.
    expect(tools.codex).toMatchObject({ input: 1000, cached: 4000, output: 300, records: 1 });
    // DeepSeek Harness (zstd) and Pi on the MacBook.
    expect(tools.dsh).toMatchObject({ input: 700, cached: 7000, output: 70 });
    expect(tools.pi).toMatchObject({ input: 10, cached: 30, output: 20 });
    // Unknown models are unpriced, not a silent $0.
    expect(s.buckets.find((b) => b.provider === "dsh")!.costSource).toBe("unpriced");

    const macId = f.mac.config.value.deviceId;
    expect(new Set(s.buckets.filter((b) => b.device === macId).map((b) => b.provider))).toEqual(new Set(["codex", "dsh", "pi"]));
    expect(s.buckets.find((b) => b.provider === "droid")!.fidelity).toBe("session");
    expect(s.buckets.find((b) => b.provider === "claude")!.project).toBe("alpha");
  });

  it("never stores prompt text", async () => {
    await f.hub.cycle();
    const s = await summary(f.server);
    expect(JSON.stringify(s)).not.toContain("never leaves the device");
  });

  it("catches up after the hub was unreachable, without double counting", async () => {
    await pairMac(f);
    const goodUrl = f.mac.config.value.hubUrl!;
    await f.mac.config.update({ hubUrl: "http://127.0.0.1:9" });
    await f.mac.cycle();
    expect(f.mac.syncStatus.lastError).not.toBeNull();

    await f.mac.config.update({ hubUrl: goodUrl });
    await f.mac.cycle();
    await f.mac.cycle();
    expect(f.mac.syncStatus.lastError).toBeNull();
    expect(byTool(await summary(f.server)).codex).toMatchObject({ input: 1000, records: 1 });

    // New usage on the Mac arrives with the next scan.
    const pi = path.join(f.root, "mac-home", ".pi", "agent", "sessions", "p", "2026_pi1.jsonl");
    await appendFile(pi, JSON.stringify({ type: "message", id: "e2", timestamp: at("16"), message: { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: { input: 5, output: 5 } } }) + "\n");
    await f.mac.cycle();
    expect(byTool(await summary(f.server)).pi).toMatchObject({ input: 15, output: 25, records: 2 });
  });

  it("resends everything when the hub lost a device's data", async () => {
    await pairMac(f);
    await f.mac.cycle();
    await f.hub.store.removeDevice(f.mac.config.value.deviceId, false);
    await f.mac.cycle();
    expect(byTool(await summary(f.server)).dsh).toMatchObject({ input: 700 });
  });

  it("filters by hour for the 24-hour view", async () => {
    await f.hub.cycle();
    const s = await summary(f.server, `&resolution=hour&sinceTime=${at("10")}&untilTime=${at("12")}`);
    expect(new Set(s.buckets.map((b) => b.provider))).toEqual(new Set(["claude", "commandcode"]));
    expect(s.buckets.every((b) => b.hourStart !== undefined)).toBe(true);
  });

  it("counts lines that the owner's own scripts write to the inbox", async () => {
    await write(
      path.join(f.hub.inboxDir, "listing-hub.jsonl"),
      jsonl([{ time: at("17"), app: "listing-hub", model: "gpt-6.1-sol", input: 100, output: 10, costUsd: 0.5 }]),
    );
    await f.hub.cycle();
    const s = await summary(f.server);
    expect(byTool(s).inbox).toMatchObject({ input: 100, output: 10, cost: 0.5 });
    expect(s.buckets.find((b) => b.provider === "inbox")!.project).toBe("listing-hub");
  });

  it("rejects pushes and views from strangers", async () => {
    const ingest = await fetch(`${f.server.urls[0]}/api/ingest`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(ingest.status).toBe(401);
    const pair = await fetch(`${f.server.urls[0]}/api/pair`, { method: "POST", body: JSON.stringify({ code: "WRONG1", deviceId: "x" }) });
    expect(pair.status).toBe(403);
  });
});
