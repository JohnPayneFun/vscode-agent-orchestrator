import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { WorkflowNode, TriggerGhPr } from "../../../shared/types.js";
import type { OrchestrationPaths } from "../../orchestration/paths.js";
import type { Trigger, TriggerDeps } from "./types.js";
import type { MessageBus } from "../../orchestration/message-bus.js";
import { detectGhPrEvents, type GhPrNodeTriggerState, type PrSnapshot } from "./gh-pr-events.js";

const exec = promisify(execFile);

interface TriggerState {
  perNode: Record<string, GhPrNodeTriggerState>;
}

export class GhPrTrigger implements Trigger {
  readonly nodeId: string;
  private interval: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly node: WorkflowNode,
    private readonly cfg: TriggerGhPr,
    private readonly p: OrchestrationPaths,
    private readonly bus: MessageBus,
    private readonly deps: TriggerDeps
  ) {
    this.nodeId = node.id;
  }

  start(): void {
    const cfg = vscode.workspace.getConfiguration("vscodeAgentOrchestrator");
    const seconds = Math.max(15, cfg.get<number>("ghPollSeconds", 60));
    void this.poll();
    this.interval = setInterval(() => void this.poll(), seconds * 1000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    let prs: PrSnapshot[];
    try {
      const { stdout } = await exec(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          this.cfg.repo,
          "--state",
          "all",
          "--json",
          "number,headRefOid,state,title,url,baseRefName,headRefName,closedAt,mergedAt",
          "--limit",
          "100"
        ],
        { timeout: 30000 }
      );
      prs = JSON.parse(stdout) as PrSnapshot[];
    } catch (err) {
      this.deps.log(
        `gh pr list failed for ${this.cfg.repo}: ${err instanceof Error ? err.message : err}. Is gh installed and authenticated?`,
        "warn"
      );
      return;
    }

    const state = await loadState(this.p);
    const perNode = state.perNode[this.node.id] ?? { seen: {} };
    let branchFilter: RegExp | null = null;
    if (this.cfg.branchFilter) {
      try {
        branchFilter = new RegExp(this.cfg.branchFilter);
      } catch (err) {
        this.deps.log(
          `Invalid branchFilter for ${this.cfg.repo} on node ${this.node.id}: ${err instanceof Error ? err.message : err}`,
          "warn"
        );
      }
    }
    const detected = detectGhPrEvents(prs, perNode, this.cfg.events, branchFilter);

    for (const event of detected.events) {
      const pr = event.pr;
      const payload = this.bus.buildPayload({
        from: "external",
        to: this.node.id,
        edgeId: null,
        trigger: { type: "ghPr", prNumber: pr.number, headSha: pr.headRefOid, repo: this.cfg.repo, eventKind: event.eventKind },
        payload: {
          prNumber: pr.number,
          prUrl: pr.url,
          title: pr.title,
          baseRef: pr.baseRefName,
          headRef: pr.headRefName,
          headSha: pr.headRefOid,
          state: pr.state,
          closedAt: pr.closedAt ?? null,
          mergedAt: pr.mergedAt ?? null,
          eventKind: event.eventKind
        }
      });
      await this.bus.deliver(payload);
      this.deps.fire(this.node, {
        prNumber: pr.number,
        repo: this.cfg.repo,
        headSha: pr.headRefOid,
        state: pr.state,
        eventKind: event.eventKind
      }).catch((err) => {
        this.deps.log(`gh-pr fire threw: ${err instanceof Error ? err.message : err}`, "error");
      });
    }

    detected.nextState.lastPolledAt = new Date().toISOString();
    state.perNode[this.node.id] = detected.nextState;
    await saveState(this.p, state);
  }
}

async function loadState(p: OrchestrationPaths): Promise<TriggerState> {
  if (!fs.existsSync(p.triggersStateJson)) return { perNode: {} };
  try {
    return JSON.parse(await fs.promises.readFile(p.triggersStateJson, "utf8")) as TriggerState;
  } catch {
    return { perNode: {} };
  }
}

async function saveState(p: OrchestrationPaths, state: TriggerState): Promise<void> {
  await fs.promises.mkdir(path.dirname(p.triggersStateJson), { recursive: true });
  await fs.promises.writeFile(p.triggersStateJson, JSON.stringify(state, null, 2), "utf8");
}
