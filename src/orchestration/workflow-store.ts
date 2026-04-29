import * as fs from "fs";
import * as path from "path";
import Ajv from "ajv";
import type { Workflow } from "../../shared/types.js";
import { WORKFLOW_SCHEMA } from "../../shared/schema.js";
import type { OrchestrationPaths } from "./paths.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(WORKFLOW_SCHEMA);

export const DEFAULT_WORKFLOW: Workflow = {
  $schema: "./runtime/workflow.schema.json",
  version: 1,
  id: "default",
  name: "New workflow",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  settings: {
    dailyHandoffCap: 200,
    concurrencyLimit: 2,
    ledgerRetentionDays: 30
  },
  nodes: [],
  edges: []
};

export class WorkflowStore {
  private current: Workflow | null = null;
  private listeners: Array<(w: Workflow) => void> = [];

  constructor(private readonly p: OrchestrationPaths) {}

  onChange(l: (w: Workflow) => void): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  async load(): Promise<Workflow> {
    if (!fs.existsSync(this.p.workflowsJson)) {
      const w = { ...DEFAULT_WORKFLOW, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.current = w;
      return w;
    }
    const raw = await fs.promises.readFile(this.p.workflowsJson, "utf8");
    const parsed = JSON.parse(raw) as Workflow;
    this.current = parsed;
    return parsed;
  }

  get(): Workflow | null {
    return this.current;
  }

  validate(workflow: unknown): { ok: true } | { ok: false; errors: string[] } {
    const valid = validate(workflow);
    if (valid) return { ok: true };
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`
    );
    return { ok: false, errors };
  }

  async save(workflow: Workflow): Promise<void> {
    const result = this.validate(workflow);
    if (!result.ok) {
      throw new Error("Workflow failed schema validation: " + result.errors.join("; "));
    }
    workflow.updatedAt = new Date().toISOString();
    await fs.promises.mkdir(path.dirname(this.p.workflowsJson), { recursive: true });
    await fs.promises.writeFile(this.p.workflowsJson, JSON.stringify(workflow, null, 2), "utf8");
    this.current = workflow;
    for (const l of this.listeners) l(workflow);
  }

  async writeSchemaCopy(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.p.schemaJson), { recursive: true });
    await fs.promises.writeFile(this.p.schemaJson, JSON.stringify(WORKFLOW_SCHEMA, null, 2), "utf8");
  }
}
