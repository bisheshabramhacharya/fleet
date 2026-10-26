import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { FleetConfig } from "../core/config.ts";
import { TOOL_IDS, type BillingProvider, type UsageSummary } from "../core/types.ts";
import { VERSION, type FleetNode } from "../node/fleet.ts";
import { BILLING_PROVIDERS } from "./billing.ts";
import { buildSummary, parseSummaryInput } from "./query.ts";
import type { IngestPayload } from "./store.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** Fleet-wide settings live on the hub; collectors forward these requests there. */
const HUB_PATHS = new Set(["/api/summary", "/api/limits", "/api/money", "/api/fleet-settings", "/api/billing", "/api/devices", "/api/export.csv"]);

/** Tailscale hands out 100.64.0.0/10 addresses; fleet listens only there and on loopback. */
export function tailscaleAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const [a, b] = addr.address.split(".").map(Number);
      if (a === 100 && b !== undefined && b >= 64 && b <= 127) out.push(addr.address);
    }
  }
  return out;
}

export interface ServerOptions {
  node: FleetNode;
  /** Built dashboard files; omit to serve the API only. */
  uiDir?: string;
  /** Listen addresses. Defaults to loopback plus Tailscale. */
  hosts?: string[];
  port?: number;
}

export interface RunningServer {
  urls: string[];
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

/** Device-level settings the dashboard may read and change. Secrets stay out. */
function publicSettings(node: FleetNode) {
  const c = node.config.value;
  return {
    deviceId: c.deviceId,
    deviceName: c.deviceName,
    role: c.role,
    port: c.port,
    hubUrl: c.hubUrl,
    paired: c.hubToken !== null,
    pairCode: c.role === "hub" ? c.pairCode : null,
    viewKey: c.role === "hub" ? c.viewKey : null,
    disabledSources: c.disabledSources,
    customHomes: c.customHomes,
    hideProjects: c.hideProjects,
    scanIntervalSec: c.scanIntervalSec,
    openAtLogin: c.openAtLogin,
    inboxDir: node.inboxDir,
    version: VERSION,
    platform: process.platform,
    tailscale: tailscaleAddresses(),
    sync: node.syncStatus,
    secretsAvailable: node.secrets.available,
    lastScan: node.collector.lastScan,
  };
}

function fleetSettings(node: FleetNode) {
  const c = node.config.value;
  return {
    subscriptions: c.subscriptions,
    budgets: c.budgets,
    priceOverrides: c.priceOverrides,
    modelAliases: c.modelAliases,
    billingProviders: BILLING_PROVIDERS,
  };
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function summaryToCsv(summary: UsageSummary): string {
  const names = new Map(summary.devices.map((d) => [d.id, d.name]));
  const header = [
    "day", "hour", "device", "tool", "model", "project", "uncached_input", "cache_read", "cache_write", "output",
    "reasoning", "cost_usd", "cost_source", "credits", "sessions", "records", "fidelity",
  ];
  const rows = summary.buckets.map((b) =>
    [
      b.day, b.hourStart ?? "", names.get(b.device) ?? b.device, b.provider, b.model, b.project ?? "",
      b.totals.uncachedInputTokens, b.totals.cachedInputTokens, b.totals.cacheCreationTokens, b.totals.outputTokens,
      b.totals.reasoningTokens, b.costUsd.toFixed(6), b.costSource, b.credits ?? "", b.sessions, b.records, b.fidelity ?? "call",
    ].map(csvCell).join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { node } = options;
  const port = options.port ?? node.config.value.port;

  /** Who is asking: this machine, a paired device, or a browser holding the view key. */
  function access(req: IncomingMessage, url: URL): { view: boolean; admin: boolean; device: string | null } {
    if (isLoopback(req)) return { view: true, admin: true, device: null };
    const token = bearer(req);
    const device = token ? node.deviceForToken(token) : null;
    if (device) return { view: true, admin: true, device };
    const key = url.searchParams.get("key") ?? cookie(req, "fleet_key");
    const viewer = node.role === "hub" && key !== null && key === node.config.value.viewKey;
    return { view: viewer, admin: viewer, device: null };
  }

  /** On a collector, fleet-wide reads go to the hub; the local copy answers when it is unreachable. */
  async function forward(req: IncomingMessage, url: URL, body: unknown): Promise<Response | null> {
    const { hubUrl, hubToken } = node.config.value;
    if (node.role !== "collector" || !hubUrl || !hubToken) return null;
    try {
      return await fetch(new URL(url.pathname + url.search, hubUrl), {
        method: req.method ?? "GET",
        headers: { authorization: `Bearer ${hubToken}`, "content-type": "application/json" },
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(req.method === "GET" ? 8_000 : 30_000),
      });
    } catch {
      return null;
    }
  }

  function localSummary(url: URL): UsageSummary {
    const c = node.config.value;
    let input;
    try {
      input = parseSummaryInput(url.searchParams);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
    return buildSummary(node.store, node.rates, input, {
      priceOverrides: c.priceOverrides,
      modelAliases: c.modelAliases,
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const route = url.pathname;

    // Open endpoints: health and pairing.
    if (route === "/api/health") return send(res, 200, { ok: true, app: "fleet", version: VERSION, role: node.role, deviceId: node.config.value.deviceId });
    if (route === "/api/pair" && method === "POST") {
      const body = (await readBody(req)) as { code?: string; deviceId?: string };
      const token = await node.pair(String(body.code ?? ""), String(body.deviceId ?? ""));
      if (!token) throw new HttpError(403, "That pair code is wrong or this machine is not a hub.");
      return send(res, 200, { token, hubDeviceId: node.config.value.deviceId });
    }
    if (route === "/api/ingest" && method === "POST") {
      const token = bearer(req);
      const device = token ? node.deviceForToken(token) : null;
      if (!device || node.role !== "hub") throw new HttpError(401, "Unknown device token.");
      const payload = (await readBody(req)) as IngestPayload;
      if (payload?.device?.id !== device) throw new HttpError(403, "Token belongs to another device.");
      return send(res, 200, node.store.ingest(payload));
    }

    const who = access(req, url);
    if (!who.view) throw new HttpError(401, "Open this page with the view key from the hub's settings.");
    const setCookie: Record<string, string> = url.searchParams.has("key")
      ? { "set-cookie": `fleet_key=${encodeURIComponent(url.searchParams.get("key")!)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` }
      : {};

    const hubRoute = [...HUB_PATHS].some((p) => route === p || route.startsWith(`${p}/`));
    if (hubRoute && node.role === "collector") {
      const body = method === "GET" ? undefined : await readBody(req);
      const forwarded = await forward(req, url, body);
      if (forwarded) {
        res.writeHead(forwarded.status, { "content-type": forwarded.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
        res.end(Buffer.from(await forwarded.arrayBuffer()));
        return;
      }
      if (route === "/api/summary") return send(res, 200, { ...localSummary(url), localOnly: true }, setCookie);
      if (route === "/api/limits") return send(res, 200, node.store.limits());
      if (method === "GET" && route === "/api/devices") return send(res, 200, node.store.devices());
      throw new HttpError(503, "The hub is unreachable, so fleet-wide settings can't change right now.");
    }

    if (route === "/api/summary" && method === "GET") {
      await node.rates.ensureFresh();
      return send(res, 200, localSummary(url), setCookie);
    }
    if (route === "/api/export.csv" && method === "GET") {
      const csv = summaryToCsv(localSummary(url));
      return send(res, 200, csv, { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="fleet-usage.csv"' });
    }
    if (route === "/api/limits" && method === "GET") return send(res, 200, node.limits());
    if (route === "/api/money" && method === "GET") return send(res, 200, node.money());
    if (route === "/api/devices" && method === "GET") return send(res, 200, node.store.devices());

    if (!who.admin) throw new HttpError(403, "Not allowed.");

    if (route === "/api/scan" && method === "POST") {
      const scan = await node.cycle();
      return send(res, 200, { ok: true, changedFiles: scan.changedFiles, durationMs: scan.durationMs, sync: node.syncStatus });
    }
    if (route === "/api/rates/refresh" && method === "POST") {
      await node.rates.ensureFresh(true);
      return send(res, 200, node.rates.info);
    }
    if (route === "/api/settings" && method === "GET") return send(res, 200, publicSettings(node));
    if (route === "/api/settings" && method === "PUT") {
      const body = (await readBody(req)) as Partial<FleetConfig>;
      const patch: Partial<FleetConfig> = {};
      if (typeof body.deviceName === "string" && body.deviceName.trim()) patch.deviceName = body.deviceName.trim().slice(0, 60);
      if (Array.isArray(body.disabledSources)) patch.disabledSources = body.disabledSources.filter((s) => typeof s === "string");
      if (typeof body.hideProjects === "boolean") patch.hideProjects = body.hideProjects;
      if (typeof body.openAtLogin === "boolean") patch.openAtLogin = body.openAtLogin;
      if (typeof body.scanIntervalSec === "number" && body.scanIntervalSec >= 30) patch.scanIntervalSec = Math.round(body.scanIntervalSec);
      if (body.customHomes && typeof body.customHomes === "object") {
        const homes: FleetConfig["customHomes"] = {};
        for (const [tool, dirs] of Object.entries(body.customHomes)) {
          if ((TOOL_IDS as string[]).includes(tool) && Array.isArray(dirs)) homes[tool as keyof typeof homes] = dirs.filter((d) => typeof d === "string" && d.trim());
        }
        patch.customHomes = homes;
      }
      await node.config.update(patch);
      return send(res, 200, publicSettings(node));
    }
    if (route === "/api/pair-code/rotate" && method === "POST") {
      const { newPairCode } = await import("../core/config.ts");
      await node.config.update({ pairCode: newPairCode() });
      return send(res, 200, { pairCode: node.config.value.pairCode });
    }
    if (route === "/api/connect" && method === "POST") {
      // Turn this install into a collector that reports to the hub at `url`.
      const body = (await readBody(req)) as { url?: string; code?: string };
      const hubUrl = normalizeHubUrl(String(body.url ?? ""));
      const response = await fetch(new URL("/api/pair", hubUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: body.code, deviceId: node.config.value.deviceId }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!response) throw new HttpError(502, `Could not reach a hub at ${hubUrl}. Is Tailscale on and the hub running?`);
      if (!response.ok) throw new HttpError(response.status, ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "Pairing failed.");
      const { token } = (await response.json()) as { token: string };
      await node.config.update({ role: "collector", hubUrl, hubToken: token });
      void node.cycle();
      return send(res, 200, publicSettings(node));
    }
    if (route === "/api/become-hub" && method === "POST") {
      await node.config.update({ role: "hub", hubUrl: null, hubToken: null });
      return send(res, 200, publicSettings(node));
    }
    if (route === "/api/fleet-settings" && method === "GET") return send(res, 200, fleetSettings(node));
    if (route === "/api/fleet-settings" && method === "PUT") {
      const body = (await readBody(req)) as Partial<FleetConfig>;
      const patch: Partial<FleetConfig> = {};
      if (Array.isArray(body.subscriptions)) patch.subscriptions = body.subscriptions;
      if (Array.isArray(body.budgets)) patch.budgets = body.budgets;
      if (body.priceOverrides && typeof body.priceOverrides === "object") patch.priceOverrides = body.priceOverrides;
      if (body.modelAliases && typeof body.modelAliases === "object") patch.modelAliases = body.modelAliases;
      await node.config.update(patch);
      return send(res, 200, fleetSettings(node));
    }
    if (route === "/api/billing/refresh" && method === "POST") {
      await node.refreshBilling(true);
      return send(res, 200, node.money());
    }
    const billing = route.match(/^\/api\/billing\/(\w+)$/);
    if (billing) {
      const provider = billing[1] as BillingProvider;
      if (!BILLING_PROVIDERS.some((p) => p.id === provider)) throw new HttpError(404, "Unknown billing provider.");
      if (method === "PUT") {
        if (!node.secrets.available) throw new HttpError(400, "Saving keys needs the desktop app, which stores them in the system keychain.");
        const body = (await readBody(req)) as { key?: string };
        return send(res, 200, await node.setBillingKey(provider, String(body.key ?? "")));
      }
      if (method === "DELETE") {
        await node.setBillingKey(provider, null);
        return send(res, 200, { ok: true });
      }
    }
    const device = route.match(/^\/api\/devices\/([\w-]+)$/);
    if (device) {
      const id = device[1]!;
      if (method === "PATCH") {
        const body = (await readBody(req)) as { name?: string };
        if (typeof body.name === "string" && body.name.trim()) node.store.renameDevice(id, body.name.trim().slice(0, 60));
        if (id === node.config.value.deviceId && body.name) await node.config.update({ deviceName: body.name.trim().slice(0, 60) });
        await node.store.flush();
        return send(res, 200, node.store.devices());
      }
      if (method === "DELETE") {
        const keepHistory = url.searchParams.get("keepHistory") === "1";
        const tokens = Object.fromEntries(Object.entries(node.config.value.deviceTokens).filter(([, d]) => d !== id));
        await node.config.update({ deviceTokens: tokens });
        await node.store.removeDevice(id, keepHistory);
        return send(res, 200, node.store.devices());
      }
    }
    throw new HttpError(404, "Not found");
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!options.uiDir) return send(res, 404, "No dashboard bundled.");
    const who = access(req, url);
    if (!who.view) {
      return send(res, 401, "fleet: open this address with ?key=<view key> from the hub's Settings page.");
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    let file = path.resolve(options.uiDir, rel);
    if (!file.startsWith(path.resolve(options.uiDir))) return send(res, 403, "Forbidden");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) file = path.join(options.uiDir, "index.html");
    const headers: Record<string, string> = { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" };
    if (url.searchParams.has("key")) {
      headers["set-cookie"] = `fleet_key=${encodeURIComponent(url.searchParams.get("key")!)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
    }
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fleet.local");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent) send(res, status, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  };

  const hosts = options.hosts ?? ["127.0.0.1", ...tailscaleAddresses()];
  const servers: http.Server[] = [];
  let boundPort = port;
  for (const host of hosts) {
    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(boundPort, host, () => {
        const address = server.address();
        if (address && typeof address === "object") boundPort = address.port;
        resolve();
      });
    }).catch((error) => {
      if (host === hosts[0]) throw error;
      node.options.log?.(`could not listen on ${host}: ${String(error)}`);
    });
    if (server.listening) servers.push(server);
  }
  return {
    port: boundPort,
    urls: servers.map((s) => {
      const a = s.address() as { address: string; port: number };
      return `http://${a.address}:${a.port}`;
    }),
    close: () => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined),
  };
}

export function normalizeHubUrl(input: string): string {
  let value = input.trim();
  if (!value) throw new HttpError(400, "Enter the hub address.");
  if (!/^https?:\/\//.test(value)) value = `http://${value}`;
  const url = new URL(value);
  if (!url.port) url.port = "8742";
  return url.origin;
}
