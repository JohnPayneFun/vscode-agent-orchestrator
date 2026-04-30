import { ulid } from "ulid";
import type { Workflow, WorkflowNode } from "../../shared/types.js";
import type { Ledger } from "../orchestration/ledger.js";
import type { MessageBus } from "../orchestration/message-bus.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";
import { runWorkflowNode, type RuntimeModelProvider, type RunWorkflowNodeResult } from "../runtime/node-runner.js";
import { runWorkspaceHook, type HeadlessHooksConfig, type WorkspaceHookResult } from "./hooks.js";

export type RunAttemptPhase =
  | "preparingWorkspace"
  | "runningBeforeHook"
  | "streamingTurn"
  | "runningAfterHook"
  | "succeeded"
  | "failed";

export type RunAttemptStatus = "running" | "succeeded" | "failed";

export interface HeadlessRuntimeConfig {
  hooks?: HeadlessHooksConfig;
}

export interface RunAttemptSnapshot {
  attemptId: string;
  nodeId: string;
  nodeLabel: string;
  status: RunAttemptStatus;
  phase: RunAttemptPhase;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  result?: RunWorkflowNodeResult;
  hooks: WorkspaceHookResult[];
}

export interface HeadlessRunAttemptDeps {
  paths: OrchestrationPaths;
  bus: MessageBus;
  ledger: Ledger;
  getWorkflow: () => Workflow | null;
  getAgentInstructions: (agentId: string) => Promise<string | null>;
  modelProvider: RuntimeModelProvider;
}

export async function runHeadlessNodeAttempt(args: {
  deps: HeadlessRunAttemptDeps;
  node: WorkflowNode;
  userText?: string;
  dryRun?: boolean;
  runtimeConfig?: HeadlessRuntimeConfig | null;
  onMarkdown?: (markdown: string) => void | Promise<void>;
}): Promise<RunAttemptSnapshot> {
  const attempt: RunAttemptSnapshot = {
    attemptId: ulid(),
    nodeId: args.node.id,
    nodeLabel: args.node.label,
    status: "running",
    phase: "preparingWorkspace",
    startedAt: new Date().toISOString(),
    hooks: []
  };
  const hooks = args.runtimeConfig?.hooks;
  const hookEnv = {
    AGENT_ORCHESTRATOR_ATTEMPT_ID: attempt.attemptId,
    AGENT_ORCHESTRATOR_NODE_ID: args.node.id,
    AGENT_ORCHESTRATOR_NODE_LABEL: args.node.label,
    AGENT_ORCHESTRATOR_WORKSPACE: args.deps.paths.workspaceRoot
  };

  await appendAttemptEvent(args.deps.ledger, "attempt.started", attempt);

  try {
    if (!args.node.enabled) {
      throw new Error(`Node ${args.node.label || args.node.id} is disabled.`);
    }

    setPhase(attempt, "runningBeforeHook");
    await appendAttemptEvent(args.deps.ledger, "attempt.phase", attempt);
    const beforeRun = await runWorkspaceHook({
      hooks,
      name: "beforeRun",
      cwd: args.deps.paths.workspaceRoot,
      env: { ...hookEnv, AGENT_ORCHESTRATOR_HOOK: "beforeRun" }
    });
    if (beforeRun) {
      attempt.hooks.push(beforeRun);
      await appendHookEvent(args.deps.ledger, attempt, beforeRun);
      if (!beforeRun.ok) throw new Error(`beforeRun hook failed: ${beforeRun.error ?? beforeRun.stderr}`);
    }

    setPhase(attempt, "streamingTurn");
    await appendAttemptEvent(args.deps.ledger, "attempt.phase", attempt);
    attempt.result = await runWorkflowNode({
      deps: args.deps,
      node: args.node,
      userText: args.userText,
      dryRun: args.dryRun,
      source: "headless-cli",
      spawner: "headless-cli",
      onMarkdown: args.onMarkdown
    });

    await runAfterHookBestEffort(args.deps.ledger, attempt, hooks, args.deps.paths.workspaceRoot, hookEnv);
    attempt.status = "succeeded";
    setPhase(attempt, "succeeded");
    attempt.finishedAt = new Date().toISOString();
    await appendAttemptEvent(args.deps.ledger, "attempt.succeeded", attempt);
    return attempt;
  } catch (err) {
    attempt.status = "failed";
    attempt.error = err instanceof Error ? err.message : String(err);
    await runAfterHookBestEffort(args.deps.ledger, attempt, hooks, args.deps.paths.workspaceRoot, hookEnv);
    setPhase(attempt, "failed");
    attempt.finishedAt = new Date().toISOString();
    await appendAttemptEvent(args.deps.ledger, "attempt.failed", attempt);
    return attempt;
  }
}

export function getHeadlessRuntimeConfig(workflow: Workflow | null): HeadlessRuntimeConfig {
  const raw = (workflow as (Workflow & { headless?: HeadlessRuntimeConfig }) | null)?.headless;
  return { hooks: raw?.hooks };
}

async function runAfterHookBestEffort(
  ledger: Ledger,
  attempt: RunAttemptSnapshot,
  hooks: HeadlessHooksConfig | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  setPhase(attempt, "runningAfterHook");
  await appendAttemptEvent(ledger, "attempt.phase", attempt);
  const afterRun = await runWorkspaceHook({
    hooks,
    name: "afterRun",
    cwd,
    env: { ...env, AGENT_ORCHESTRATOR_HOOK: "afterRun" }
  });
  if (!afterRun) return;
  attempt.hooks.push(afterRun);
  await appendHookEvent(ledger, attempt, afterRun);
}

function setPhase(attempt: RunAttemptSnapshot, phase: RunAttemptPhase): void {
  attempt.phase = phase;
}

async function appendAttemptEvent(
  ledger: Ledger,
  type: "attempt.started" | "attempt.phase" | "attempt.succeeded" | "attempt.failed",
  attempt: RunAttemptSnapshot
): Promise<void> {
  await ledger.append({
    type,
    eventId: attempt.attemptId,
    node: attempt.nodeId,
    detail: {
      attemptId: attempt.attemptId,
      phase: attempt.phase,
      status: attempt.status,
      error: attempt.error
    }
  });
}

async function appendHookEvent(ledger: Ledger, attempt: RunAttemptSnapshot, hook: WorkspaceHookResult): Promise<void> {
  await ledger.append({
    type: hook.ok ? "attempt.hookSucceeded" : "attempt.hookFailed",
    eventId: attempt.attemptId,
    node: attempt.nodeId,
    detail: {
      attemptId: attempt.attemptId,
      hook: hook.name,
      command: hook.command,
      cwd: hook.cwd,
      exitCode: hook.exitCode,
      signal: hook.signal,
      stdout: hook.stdout.slice(-4000),
      stderr: hook.stderr.slice(-4000),
      error: hook.error
    }
  });
}