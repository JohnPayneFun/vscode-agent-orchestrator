import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { WorkflowNode, TriggerGhPr } from "../../../shared/types.js";
import type { OrchestrationPaths } from "../../orchestration/paths.js";
import type { Trigger, TriggerDeps } from "./types.js";
import type { MessageBus } from "../../orchestration/message-bus.js";

const exec = promisify(execFile);

interface PrSnapshot {
  number: number;
  headRefOid: string;
  state: string;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
}

interface TriggerState {
  perNode: Record<
    string,
    {
      lastPolledAt?: string;
      seen: Record<string, string>; // pr number -> last seen headRefOid
    }
  >;
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
    const cfg = vscode.workspace.getConfiguration("claudeOrchestrator");
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
          "open",
          "--json",
          "number,headRefOid,state,title,url,baseRefName,headRefName",
          "--limit",
          "50"
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
    const branchFilter = this.cfg.branchFilter ? new RegExp(this.cfg.branchFilter) : null;

    for (const pr of prs) {
      if (branchFilter && !branchFilter.test(pr.headRefName)) continue;
      const prevSha = perNode.seen[String(pr.number)];
      const isNew = prevSha === undefined;
      const isUpdate = !isNew && prevSha !== pr.headRefOid;
      const matched =
        (isNew && this.cfg.events.includes("opened")) ||
        (isUpdate && this.cfg.events.includes("synchronize"));
      if (!matched) continue;

      // Pre-deliver the PR snapshot to the node's inbox so the spawned session
      // sees it as the "incoming handoff" (uniform with downstream nodes).
      const payload = this.bus.buildPayload({
        from: "external",
        to: this.node.id,
        edgeId: null,
        trigger: { type: "ghPr", prNumber: pr.number, headSha: pr.headRefOid, repo: this.cfg.repo },
        payload: {
          prNumber: pr.number,
          prUrl: pr.url,
          title: pr.title,
          baseRef: pr.baseRefName,
          headRef: pr.headRefName,
          headSha: pr.headRefOid,
          eventKind: isNew ? "opened" : "synchronize"
        }
      });
      await this.bus.deliver(payload);
      this.deps.fire(this.node, {
        prNumber: pr.number,
        repo: this.cfg.repo,
        headSha: pr.headRefOid,
        eventKind: isNew ? "opened" : "synchronize"
      }).catch((err) => {
        this.deps.log(`gh-pr fire threw: ${err instanceof Error ? err.message : err}`, "error");
      });

      perNode.seen[String(pr.number)] = pr.headRefOid;
    }

    perNode.lastPolledAt = new Date().toISOString();
    state.perNode[this.node.id] = perNode;
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
