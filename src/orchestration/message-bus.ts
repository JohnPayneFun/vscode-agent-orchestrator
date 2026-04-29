import * as fs from "fs";
import * as path from "path";
import { ulid } from "ulid";
import type { HandoffPayload } from "../../shared/types.js";
import { inboxDir, outboxDir, type OrchestrationPaths } from "./paths.js";

const OUTBOX_RETAIN = 50;

export class MessageBus {
  constructor(private readonly p: OrchestrationPaths) {}

  async drain(persona: string): Promise<HandoffPayload[]> {
    const dir = inboxDir(this.p, persona);
    if (!fs.existsSync(dir)) return [];
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    const drained: HandoffPayload[] = [];
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const raw = await fs.promises.readFile(full, "utf8");
        drained.push(JSON.parse(raw) as HandoffPayload);
        await fs.promises.unlink(full);
      } catch {
        // Skip unreadable / mid-write files; the next drain will pick them up
      }
    }
    return drained;
  }

  async peek(persona: string): Promise<HandoffPayload[]> {
    const dir = inboxDir(this.p, persona);
    if (!fs.existsSync(dir)) return [];
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    const out: HandoffPayload[] = [];
    for (const f of files) {
      try {
        const raw = await fs.promises.readFile(path.join(dir, f), "utf8");
        out.push(JSON.parse(raw) as HandoffPayload);
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  async deliver(payload: HandoffPayload): Promise<{ inboxPath: string; outboxPath: string }> {
    const ts = payload.createdAt.replace(/[:.]/g, "-");
    const filename = `${ts}_${payload.id}.json`;
    const inDir = inboxDir(this.p, payload.to);
    const outDir = outboxDir(this.p, payload.from);
    await fs.promises.mkdir(inDir, { recursive: true });
    await fs.promises.mkdir(outDir, { recursive: true });
    const inboxPath = path.join(inDir, filename);
    const outboxPath = path.join(outDir, filename);
    const json = JSON.stringify(payload, null, 2);
    // Write outbox first so producer-side history is durable even if delivery fails
    await fs.promises.writeFile(outboxPath, json, "utf8");
    await fs.promises.writeFile(inboxPath, json, "utf8");
    await this.trimOutbox(outDir);
    return { inboxPath, outboxPath };
  }

  buildPayload(args: {
    from: string;
    to: string;
    edgeId: string | null;
    trigger: HandoffPayload["trigger"];
    payload: Record<string, unknown>;
    parentId?: string;
    rootId?: string;
    depth?: number;
  }): HandoffPayload {
    const id = ulid();
    return {
      schemaVersion: 1,
      id,
      createdAt: new Date().toISOString(),
      from: args.from,
      to: args.to,
      edgeId: args.edgeId,
      trigger: args.trigger,
      payload: args.payload,
      trace: {
        rootId: args.rootId ?? id,
        depth: args.depth ?? 0,
        parents: args.parentId ? [args.parentId] : []
      }
    };
  }

  private async trimOutbox(dir: string): Promise<void> {
    try {
      const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
      const excess = files.length - OUTBOX_RETAIN;
      if (excess <= 0) return;
      for (const f of files.slice(0, excess)) {
        await fs.promises.unlink(path.join(dir, f)).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  }
}
