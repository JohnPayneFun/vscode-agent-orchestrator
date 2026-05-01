import * as vscode from "vscode";
import type { TriggerLeafConfig, Workflow, WorkflowNode } from "../../shared/types.js";
import type { Dispatcher, DispatchContext } from "./dispatcher.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";
import type { MessageBus } from "../orchestration/message-bus.js";
import type { Trigger, TriggerDeps } from "./triggers/types.js";
import { TimerTrigger } from "./triggers/timer-trigger.js";
import { IntervalTrigger } from "./triggers/interval-trigger.js";
import { HandoffTrigger } from "./triggers/handoff-trigger.js";
import { GhPrTrigger } from "./triggers/gh-pr-trigger.js";
import { FileChangeTrigger } from "./triggers/file-change-trigger.js";
import { StartupTrigger } from "./triggers/startup-trigger.js";
import { DiagnosticsTrigger } from "./triggers/diagnostics-trigger.js";
import { WebhookTrigger } from "./triggers/webhook-trigger.js";

export class TriggerRegistry {
  private active = new Map<string, Trigger>();

  constructor(
    private readonly dispatcher: Dispatcher,
    private readonly p: OrchestrationPaths,
    private readonly bus: MessageBus,
    private readonly output: vscode.OutputChannel
  ) {}

  reconcile(workflow: Workflow | null): void {
    const desired = new Set<string>();
    if (workflow) {
      for (const node of workflow.nodes) {
        if (!node.enabled) continue;
        for (const spec of this.triggerSpecs(node)) {
          if (spec.trigger.type === "manual") continue;
          desired.add(spec.key);
          if (this.active.has(spec.key)) continue;
          const trigger = this.create(node, spec.trigger);
          if (trigger) {
            trigger.start();
            this.active.set(spec.key, trigger);
            this.output.appendLine(`[trigger] started ${spec.trigger.type} for ${node.id}`);
          }
        }
      }
    }
    for (const [key, trigger] of this.active) {
      if (!desired.has(key)) {
        trigger.dispose();
        this.active.delete(key);
        this.output.appendLine(`[trigger] stopped ${key}`);
      }
    }
  }

  disposeAll(): void {
    for (const t of this.active.values()) t.dispose();
    this.active.clear();
  }

  private triggerSpecs(node: WorkflowNode): Array<{ key: string; trigger: TriggerLeafConfig }> {
    if (node.trigger.type !== "any") {
      return [{ key: `${node.id}:${node.trigger.type}:${JSON.stringify(node.trigger)}`, trigger: node.trigger }];
    }
    return node.trigger.triggers.map((trigger, index) => ({
      key: `${node.id}:any:${index}:${trigger.type}:${JSON.stringify(trigger)}`,
      trigger
    }));
  }

  private create(node: WorkflowNode, triggerConfig: TriggerLeafConfig): Trigger | null {
    const deps: TriggerDeps = {
      fire: async (n: WorkflowNode, detail) => {
        const ctx: DispatchContext = { reason: triggerConfig.type, triggerDetail: detail };
        await this.dispatcher.fireNode(n, ctx);
      },
      log: (msg: string, level = "info") => {
        this.output.appendLine(`[${level}] ${msg}`);
      }
    };
    switch (triggerConfig.type) {
      case "timer":
        return new TimerTrigger(node, triggerConfig, deps);
      case "interval":
        return new IntervalTrigger(node, triggerConfig, deps);
      case "handoff":
        return new HandoffTrigger(node, this.p, deps);
      case "ghPr":
        return new GhPrTrigger(node, triggerConfig, this.p, this.bus, deps);
      case "fileChange":
        return new FileChangeTrigger(node, triggerConfig, this.p, this.bus, deps);
      case "startup":
        return new StartupTrigger(node, triggerConfig, deps);
      case "diagnostics":
        return new DiagnosticsTrigger(node, triggerConfig, this.p, this.bus, deps);
      case "webhook":
        return new WebhookTrigger(node, triggerConfig, this.p, this.bus, deps);
      case "manual":
      default:
        return null;
    }
  }
}
