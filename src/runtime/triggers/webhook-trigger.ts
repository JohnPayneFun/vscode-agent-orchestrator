import * as http from "http";
import type { TriggerWebhook, WorkflowNode } from "../../../shared/types.js";
import type { MessageBus } from "../../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../../orchestration/paths.js";
import type { Trigger, TriggerDeps } from "./types.js";

const DEFAULT_WEBHOOK_PORT = 8787;
const DEFAULT_SECRET_HEADER = "x-agent-orchestrator-secret";
const MAX_BODY_BYTES = 1_000_000;

type RouteRegistration = {
  node: WorkflowNode;
  cfg: TriggerWebhook;
  p: OrchestrationPaths;
  bus: MessageBus;
  deps: TriggerDeps;
};

export interface WebhookPayload {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: unknown;
  receivedAt: string;
}

export class WebhookTrigger implements Trigger {
  readonly nodeId: string;
  private unregister: (() => void) | null = null;

  constructor(
    private readonly node: WorkflowNode,
    private readonly cfg: TriggerWebhook,
    private readonly p: OrchestrationPaths,
    private readonly bus: MessageBus,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
  }

  start(): void {
    try {
      this.unregister = WebhookServerRegistry.register({
        node: this.node,
        cfg: this.cfg,
        p: this.p,
        bus: this.bus,
        deps: this.deps
      });
      const port = this.cfg.port ?? DEFAULT_WEBHOOK_PORT;
      this.deps.log(`Webhook trigger for node ${this.node.id} listening on http://127.0.0.1:${port}${normalizeWebhookPath(this.cfg.path)}`);
    } catch (err) {
      this.deps.log(
        `Webhook trigger for node ${this.node.id} failed to start: ${err instanceof Error ? err.message : err}`,
        "error"
      );
    }
  }

  dispose(): void {
    this.unregister?.();
    this.unregister = null;
  }
}

class WebhookServerRegistry {
  private static readonly servers = new Map<number, WebhookServer>();

  static register(registration: RouteRegistration): () => void {
    const port = registration.cfg.port ?? DEFAULT_WEBHOOK_PORT;
    let server = this.servers.get(port);
    if (!server) {
      server = new WebhookServer(port);
      this.servers.set(port, server);
    }
    return server.register(registration, () => {
      if (server && server.routeCount === 0) {
        server.close();
        this.servers.delete(port);
      }
    });
  }
}

class WebhookServer {
  private readonly server: http.Server;
  private readonly routes = new Map<string, RouteRegistration>();

  constructor(private readonly port: number) {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.listen(port, "127.0.0.1");
  }

  get routeCount(): number {
    return this.routes.size;
  }

  register(registration: RouteRegistration, onEmpty: () => void): () => void {
    const routePath = normalizeWebhookPath(registration.cfg.path);
    const existing = this.routes.get(routePath);
    if (existing && existing.node.id !== registration.node.id) {
      throw new Error(`Webhook path ${routePath} is already registered on port ${this.port}.`);
    }
    this.routes.set(routePath, registration);
    return () => {
      const current = this.routes.get(routePath);
      if (current?.node.id === registration.node.id) this.routes.delete(routePath);
      onEmpty();
    };
  }

  close(): void {
    this.server.close();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
    const route = this.routes.get(normalizeWebhookPath(url.pathname));
    if (!route) {
      writeJson(response, 404, { ok: false, error: "No webhook route registered for this path." });
      return;
    }

    if ((request.method ?? "GET").toUpperCase() !== "POST") {
      writeJson(response, 405, { ok: false, error: "Webhook triggers accept POST requests only." });
      return;
    }

    const auth = validateSecret(route.cfg, request.headers);
    if (!auth.ok) {
      writeJson(response, auth.status, { ok: false, error: auth.error });
      return;
    }

    let body: unknown;
    try {
      body = await readRequestBody(request);
    } catch (err) {
      writeJson(response, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const payload = buildWebhookPayload({ request, url, body });
    try {
      const handoff = route.bus.buildPayload({
        from: "external",
        to: route.node.id,
        edgeId: null,
        trigger: { type: "webhook", path: route.cfg.path, port: route.cfg.port ?? DEFAULT_WEBHOOK_PORT },
        payload: payload as unknown as Record<string, unknown>
      });
      await route.bus.deliver(handoff);
      await route.deps.fire(route.node, { path: payload.path, method: payload.method });
      writeJson(response, 202, { ok: true, nodeId: route.node.id, handoffId: handoff.id });
    } catch (err) {
      route.deps.log(
        `Webhook trigger fire for node ${route.node.id} threw: ${err instanceof Error ? err.message : err}`,
        "error"
      );
      writeJson(response, 500, { ok: false, error: "Webhook trigger failed." });
    }
  }
}

export function normalizeWebhookPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/webhook";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function buildWebhookPayload(args: {
  request: Pick<http.IncomingMessage, "method" | "headers">;
  url: URL;
  body: unknown;
  receivedAt?: string;
}): WebhookPayload {
  return {
    method: (args.request.method ?? "POST").toUpperCase(),
    path: normalizeWebhookPath(args.url.pathname),
    query: queryToRecord(args.url.searchParams),
    headers: headersToRecord(args.request.headers),
    body: args.body,
    receivedAt: args.receivedAt ?? new Date().toISOString()
  };
}

async function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Webhook body is too large.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return null;
  const contentType = headerValue(request.headers["content-type"]);
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Webhook body is not valid JSON.");
    }
  }
  return raw;
}

function validateSecret(
  cfg: TriggerWebhook,
  headers: http.IncomingHttpHeaders
): { ok: true } | { ok: false; status: number; error: string } {
  if (!cfg.secretEnv) return { ok: true };
  const expected = process.env[cfg.secretEnv];
  if (!expected) {
    return { ok: false, status: 500, error: `Webhook secret environment variable ${cfg.secretEnv} is not set.` };
  }
  const headerName = (cfg.secretHeader || DEFAULT_SECRET_HEADER).toLocaleLowerCase();
  const actual = headerValue(headers[headerName]);
  if (actual !== expected) return { ok: false, status: 401, error: "Webhook secret did not match." };
  return { ok: true };
}

function queryToRecord(searchParams: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

function headersToRecord(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = headerValue(value);
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

function writeJson(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}