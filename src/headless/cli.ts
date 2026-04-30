#!/usr/bin/env node
import * as path from "path";
import { getAgent } from "../orchestration/agents.js";
import { Ledger } from "../orchestration/ledger.js";
import { MessageBus } from "../orchestration/message-bus.js";
import { ensureDirs, paths } from "../orchestration/paths.js";
import { formatNodeReference, resolveWorkflowNode } from "../orchestration/node-resolver.js";
import { WorkflowStore } from "../orchestration/workflow-store.js";
import { createStaticModelProvider, createUnavailableModelProvider } from "./model-providers.js";
import { getHeadlessRuntimeConfig, runHeadlessNodeAttempt } from "./run-attempt.js";

interface CliOptions {
  workspace: string;
  dryRun: boolean;
  json: boolean;
  mockResponse?: string;
}

interface ParsedArgs {
  command: string | null;
  positionals: string[];
  options: CliOptions;
  help: boolean;
}

export async function evaluateCliArgs(argv: string[], io: {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
} = {}): Promise<number> {
  const out = io.stdout ?? ((text) => process.stdout.write(text));
  const err = io.stderr ?? ((text) => process.stderr.write(text));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
    return 1;
  }
  if (parsed.help || !parsed.command) {
    out(usage());
    return 0;
  }

  try {
    switch (parsed.command) {
      case "list":
        return await listNodes(parsed.options, out);
      case "run":
        return await runNode(parsed, out, err);
      default:
        err(`Unknown command: ${parsed.command}\n\n${usage()}`);
        return 1;
    }
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function listNodes(options: CliOptions, out: (text: string) => void): Promise<number> {
  const { workflow } = await loadRuntime(options.workspace);
  if (workflow.nodes.length === 0) {
    out("No nodes defined.\n");
    return 0;
  }
  for (const node of workflow.nodes) {
    out(`${formatNodeReference(node)}\t${node.id}\t${node.trigger.type}${node.enabled ? "" : "\tdisabled"}\n`);
  }
  return 0;
}

async function runNode(
  parsed: ParsedArgs,
  out: (text: string) => void,
  err: (text: string) => void
): Promise<number> {
  const [nodeReference, ...promptParts] = parsed.positionals;
  if (!nodeReference) {
    err("Missing node reference.\n\n" + usage());
    return 1;
  }

  const { root, p, store, workflow } = await loadRuntime(parsed.options.workspace);
  const resolution = resolveWorkflowNode(workflow, nodeReference);
  if (resolution.reason === "ambiguous") {
    err(`More than one node matches ${nodeReference}. Use the node id.\n`);
    return 1;
  }
  if (!resolution.node) {
    err(`No node named ${nodeReference}. Run \`agent-orchestrator list\` to see available nodes.\n`);
    return 1;
  }

  const mockResponse = parsed.options.mockResponse ?? process.env.AGENT_ORCHESTRATOR_MOCK_RESPONSE;
  const modelProvider = mockResponse === undefined
    ? createUnavailableModelProvider()
    : createStaticModelProvider(mockResponse);
  const ledger = new Ledger(p.ledgerJsonl);
  const bus = new MessageBus(p);
  const markdown: string[] = [];
  const attempt = await runHeadlessNodeAttempt({
    deps: {
      paths: p,
      bus,
      ledger,
      getWorkflow: () => store.get(),
      getAgentInstructions: async (agentId) => (await getAgent(root, agentId))?.instructions ?? null,
      modelProvider
    },
    node: resolution.node,
    userText: promptParts.join(" "),
    dryRun: parsed.options.dryRun,
    runtimeConfig: getHeadlessRuntimeConfig(workflow),
    onMarkdown: (chunk) => {
      markdown.push(chunk);
      if (!parsed.options.json) out(chunk);
    }
  });

  if (parsed.options.json) {
    out(JSON.stringify(attempt, null, 2) + "\n");
  } else if (attempt.status === "failed") {
    err(`\nHeadless attempt failed: ${attempt.error ?? "unknown error"}\n`);
  } else if (markdown.length === 0) {
    out(`Headless attempt ${attempt.attemptId} completed.\n`);
  }

  return attempt.status === "succeeded" ? 0 : 1;
}

async function loadRuntime(workspace: string) {
  const root = path.resolve(workspace);
  const p = paths(root);
  await ensureDirs(p);
  const store = new WorkflowStore(p);
  const workflow = await store.load();
  await store.writeSchemaCopy();
  return { root, p, store, workflow };
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: CliOptions = { workspace: process.cwd(), dryRun: false, json: false };
  const positionals: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--workspace" || arg === "-w") {
      options.workspace = requireValue(argv, ++index, arg);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--mock-response") {
      options.mockResponse = requireValue(argv, ++index, arg);
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals.shift() ?? null;
  return { command, positionals, options, help };
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function usage(): string {
  return `Agent Orchestrator headless preview\n\nUsage:\n  agent-orchestrator list [--workspace <path>]\n  agent-orchestrator run <node-label-or-id> [message...] [--workspace <path>] [--dry-run] [--mock-response <text>] [--json]\n\nNotes:\n  --dry-run records the attempt and prompt length without calling a model.\n  --mock-response feeds a static response through the real runner for local smoke tests.\n`;
}

if (require.main === module) {
  void evaluateCliArgs(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}