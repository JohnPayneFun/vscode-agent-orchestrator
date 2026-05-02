# vscode-agent-orchestrator

A graph-based orchestrator for multi-agent workflows in VS Code. Define personas as nodes (Sec, PM, Lead Dev, ...), attach triggers (GitHub PR, timer, message-received), connect them with drag-drop edges, and let VS Code's Language Model + tool APIs drive each step. Triggered and graph-editor runs execute independently in the extension host by default; manual `@orchestrator` chat runs still stream in native VS Code Chat.

Model-agnostic by design. Anything VS Code's chat picker can talk to (Copilot's GPT-4o, Claude via your Copilot subscription, Gemini, local models registered as language model providers, ...) just works — there's nothing Claude-specific in the runtime.

## LLM bootstrap runbook

If a user drops this repository link into a VS Code chat session and asks you to set it up, treat this section as the operating guide. The extension is not published to the Marketplace yet; install it by cloning, building, packaging, and installing the local VSIX.

### 1. Install the extension for the user

Run these commands from a terminal. On Windows PowerShell:

```powershell
git clone https://github.com/JohnPayneFun/vscode-agent-orchestrator.git
Set-Location vscode-agent-orchestrator
npm install
npm run install:local
```

On macOS/Linux shells:

```sh
git clone https://github.com/JohnPayneFun/vscode-agent-orchestrator.git
cd vscode-agent-orchestrator
npm install
npm run install:local
```

If the repository is already cloned, skip `git clone`, enter the existing folder, run `git pull`, then run `npm install` and `npm run install:local`.

After `npm run install:local` succeeds, tell the user to run **Developer: Reload Window**. The installed extension id is `jpc-local.vscode-agent-orchestrator`.

### 2. Open the workspace to orchestrate

The orchestrator stores workflow state inside the currently opened workspace, not inside the extension repository unless the user is testing the extension itself. Open the project folder where the agents should work, then run **Agent Orchestrator: Open Graph Editor** from the Command Palette.

Opening the graph editor initializes this workspace layout as needed:

```text
.agent-orchestrator/
├── workflows.json
├── inbox/<node>/*.json
├── outbox/<node>/*.json
├── ledger.jsonl
└── runtime/workflow.schema.json
```

### 3. Create a first workflow

In the graph editor:

1. Add a node for each role, such as `PM`, `Lead Dev`, `QA`, or `Security`.
2. Pick the node's VS Code Agent from the **Agent** dropdown when custom agents are available.
3. Choose a model per node when you need predictable background runs. Blank uses the chat picker for manual `@orchestrator` chat runs, or VS Code's first available model for background dispatch.
4. Set **Thinking effort** if the selected model supports it.
5. Set **On Trigger** to `Manual`, `New Message`, `Timer`, `Webhook`, or another trigger.
6. Use `+ OR` under a trigger when a node needs multiple inputs, such as `New Message OR Timer`.
7. Connect node outputs to node inputs with graph edges for automatic handoffs.
8. Save the workflow.

### 4. Run and validate

Use any of these paths:

```text
Command Palette -> Agent Orchestrator: Run Node Manually
Graph editor -> select a node -> Run selected
Native VS Code Chat -> @orchestrator /list
Native VS Code Chat -> @orchestrator /run <node label or id> <optional task text>
```

Example chat commands:

```text
@orchestrator /list
@orchestrator /run PM check Monday for status updates and hand off implementation work
@orchestrator /run Lead Dev summarize the latest handoff
@orchestrator /resume Lead Dev
@orchestrator Lead Dev resume
```

Watch the graph activity, selected-node **Run Output** panel, and ledger panel. For deeper inspection, run **Agent Orchestrator: Tail Ledger** to open `.agent-orchestrator/ledger.jsonl`.

Right-click a graph node and choose **Open chat window** to open a dedicated editor tab for that node's latest captured background transcript. The side-panel **Open chat** button does the same thing.

### 5. MCP and tools

When running inside VS Code, orchestrated nodes can use registered VS Code language-model tools, including MCP tools, through the same chat/tool system used by native Agent mode. If VS Code shows a message such as an MCP server may have new tools or needs to be started, tell the user to click **Start it now**.

For MCP-heavy or implementation-heavy flows, especially Monday.com project-manager nodes, Lead Dev PR workflows, and architect nodes that coordinate several reviewers, set the node's **Tool round limit** higher if it needs many tool calls. Blank uses the global `vscodeAgentOrchestrator.toolRoundLimit` setting. The global default is `64`; per-node and global limits can be set up to `200`.

VS Code also has a separate hard limit of `128` advertised tools per model request. This is not the same as tool rounds and cannot be made unlimited. The orchestrator caps the advertised tool list with `vscodeAgentOrchestrator.maxToolsPerRequest` and prioritizes workspace/search/GitHub/Monday tools when the current VS Code session has more tools registered than the model request can accept.

If a productive run reaches the tool-round cap, the orchestrator saves the original node run for manual resume. Continue it with `@orchestrator /resume <node label or id>` or the shorthand `@orchestrator <node label or id> resume`. Resume restores the original user text and drained handoffs, then tells the node to inspect current Git/PR/filesystem/MCP state and continue the remaining work rather than starting from scratch.

Nodes should create or update files with the orchestrator's `<<WRITE_FILE path=...>>...<<END_WRITE_FILE>>` block protocol. By default, the orchestrator hides a small blocklist of registered tools that are known to break or loop in this custom participant/background context, including Copilot file-mutation tools such as `copilot_createFile`, planning/meta tools such as `manage_todo_list`, and nested-agent execution tools such as `execution_subagent`. This is configurable with `vscodeAgentOrchestrator.blockedTools`; set it to `[]` to expose every native tool.

If a node hits a usage or rate limit and the error includes text like `Try again in ~63 min`, the orchestrator saves the failed run context, preserves drained handoffs, and schedules a one-shot retry one minute after the reported wait time. In that example, the node retries after 64 minutes. The graph shows this as `Retry scheduled`, and retry state is stored under `.agent-orchestrator/runtime/retries/` until the retry runs.

Scheduled triggers (`timer` and `interval`) also check outgoing graph-edge targets before dispatching. If a Project Manager timer fires while an output node such as Lead Dev is still `running`, the dispatch is skipped with a `downstream-running` guardrail entry and the timer waits for its next tick instead of piling up another task.

The graph also records token usage per node run. Inside VS Code, the extension uses the selected model's native `countTokens` API for prompt and response counts; headless/mock runs fall back to a deterministic estimate. Usage appears as a total in the graph toolbar, a workflow total in the side panel, and a per-node total when a node is selected. The raw ledger event is `usage.recorded` with input, output, total, model, and estimated fields.

### 6. What to tell the user after setup

Use this plain-language summary:

```text
I installed the Agent Orchestrator extension locally, reloaded VS Code, and opened the graph editor. You create agent workflows as nodes, choose each node's agent/model/trigger, connect nodes with edges, and run them from the graph or with @orchestrator /run <node>. The workflow state lives in .agent-orchestrator/ inside your project, and the ledger shows what fired, what ran, and what was handed off.
```

### 7. Developer validation commands

When changing this repository, validate before handing work back:

```sh
npm test
npm run build
npm run install:local
git status --short --branch
```

## How it works

Each node in your graph maps to a call into the shared node runner. When a trigger fires, the dispatcher runs that node in the extension host by default. These background runs do not share one chat thread, so multiple nodes can run at once up to the workflow's **Concurrency limit**.

Manual chat remains available through the single chat participant, **`@orchestrator`**:

```
@orchestrator /run sec [triggered:ghPr:prNumber=42]
```

Both paths read the node's config from your workflow file, drain pending handoffs from the node's inbox, call the selected VS Code language model, parse any `<<HANDOFF target=NODE_ID>>{...}<<END>>` blocks in the response, and write JSON handoffs to target inboxes. Background dispatch writes progress and captured output to the ledger and selected-node **Run Output** panel instead of streaming into one chat panel. Set `vscodeAgentOrchestrator.dispatchMode` to `chat` to restore the legacy behavior where triggers open the native chat panel with a prefilled query.

State lives in `.agent-orchestrator/` at the workspace root:

```
.agent-orchestrator/
├── workflows.json        # the graph (the editor's source of truth)
├── inbox/<node>/*.json   # pending handoffs for each node
├── outbox/<node>/*.json  # last 50 emitted, for inspection
├── ledger.jsonl          # append-only audit log
├── triggers/state.json   # last-seen PR numbers/states, cron ticks
└── runtime/
    └── workflow.schema.json
```

## Trigger types

| Type | Wakes the node when ... |
|---|---|
| `ghPr` | `gh pr list` polling (default 60s) detects a newer PR number, updated head SHA, reopen, or close/merge event |
| `timer` | A 5-field cron expression matches local (or UTC) time |
| `interval` | A simple every-N-seconds/minutes/hours/days interval elapses |
| `handoff` | A new file appears in this node's inbox |
| `manual` | You click ▶ Run on the node, or type `@orchestrator /run <id>` |
| `fileChange` | A workspace file matching a glob is created, changed, or deleted |
| `startup` | The workspace activates the extension, after an optional delay |
| `diagnostics` | VS Code Problems/diagnostics change for matching files and severity |
| `webhook` | A local HTTP `POST` request hits the node's configured path |
| `any` | Any child trigger fires, e.g. handoff received or every 30 minutes |

Use `any` when a node needs multiple inputs. In the graph editor, click `+ OR` under a trigger to create another input dropdown; the saved workflow uses `any` behind the scenes. For example, a PM node can run on both inbox handoffs and a recurring timer:

GitHub PR triggers keep per-node state in `.agent-orchestrator/triggers/state.json`. The first poll establishes the current high-water mark, such as "latest seen PR is 206"; later polls fire when PR 207 appears, even if it was opened and merged between poll ticks. The GitHub PR trigger editor can detect the workspace's GitHub `owner/repo` and current branch from Source Control, then fill the repo field or an exact branch regex for you. Select `closed` if you want the node to treat fast-merged PRs as close/merge reviews, or `opened` if any newly observed PR number should start the review.

```jsonc
{
    "type": "any",
    "triggers": [
        { "type": "handoff" },
        { "type": "interval", "every": 30, "unit": "minutes" }
    ]
}
```

Webhook triggers listen on `127.0.0.1` and default to port `8787`. Add an optional `secretEnv` to require a shared secret header before the node fires:

```jsonc
{
    "type": "webhook",
    "path": "/agent-orchestrator/security",
    "port": 8787,
    "secretEnv": "AGENT_ORCHESTRATOR_WEBHOOK_SECRET",
    "secretHeader": "x-agent-orchestrator-secret"
}
```

Smoke test with PowerShell:

```powershell
Invoke-RestMethod -Method Post `
    -Uri http://127.0.0.1:8787/agent-orchestrator/security `
    -Headers @{ "x-agent-orchestrator-secret" = $env:AGENT_ORCHESTRATOR_WEBHOOK_SECRET } `
    -ContentType "application/json" `
    -Body '{ "message": "review this external event" }'
```

## Per-node model selection

Each node has an optional `model` selector (`vendor` / `family` / `id`) that maps to `vscode.lm.selectChatModels`. Leave it blank and manual `@orchestrator` chat runs use whatever the user has selected in the chat dropdown. Background trigger/graph runs do not have access to the chat picker selection, so they use VS Code's first available matching model; choose a model per node when the exact model matters.

Nodes can also set `model.reasoningEffort` to `none`, `low`, `medium`, `high`, or `xhigh`. In VS Code this is passed through as the Copilot-style `reasoningEffort` model option, matching the native Thinking Effort menu when the selected model supports it.

When running inside VS Code, node model calls expose registered language-model tools through `vscode.lm.tools` and execute requested tool calls with `vscode.lm.invokeTool`. That is what allows a node to use MCP-backed tools such as Monday.com when those tools are available in the current VS Code session. Tool calls are capped by the node's optional **Tool round limit**, falling back to the `vscodeAgentOrchestrator.toolRoundLimit` setting, which defaults to `64` rounds and can be raised up to `200` for long implementation, PR, or MCP-heavy runs. Separately, VS Code rejects a model request with more than `128` advertised tools, so `vscodeAgentOrchestrator.maxToolsPerRequest` caps and prioritizes the available tool list before each request. If the same tool call fails twice with the same input and error, the orchestrator stops the run early to avoid retry loops. Usage-limit errors that say `try again in ...` are retried automatically one minute after the requested wait. The `vscodeAgentOrchestrator.blockedTools` setting controls the small default blocklist of known-problem native tools; set it to `[]` to expose all registered tools before the request cap is applied.

When a node reaches the tool-round cap, the run is saved under `.agent-orchestrator/runtime/retries/` for manual resume. Use `@orchestrator /resume <node>` or `@orchestrator <node> resume` to restore the original run context and continue after the node inspects current external state.

Each completed or errored node run writes a `usage.recorded` ledger entry. VS Code runs use the selected language model's `countTokens` API; headless and mock providers use a local estimate. The graph editor aggregates those entries into a workflow token total and a per-node usage panel.

Runs that use tools also write `toolUsage.recorded` ledger entries with total calls, tool rounds, failures, the applied limit, whether the cap was reached, and a per-tool breakdown. The graph editor shows total tool calls in the toolbar, workflow-level tool totals, and per-node tool usage when a node is selected.

Background runs write `session.output` ledger entries as text is produced. Select a node in the graph to see the latest captured background transcript in the **Run Output** panel. Use **Open chat** to pop that transcript into a full editor tab that updates live. Manual `@orchestrator` chat runs still stream in native VS Code Chat.

VS Code does not currently expose a supported API for extensions to inject arbitrary background-run messages into native Chat tabs. Set `vscodeAgentOrchestrator.dispatchMode` to `chat` when you specifically want trigger dispatch to use the native Chat panel instead of background execution.

## Quick start

```sh
git clone https://github.com/JohnPayneFun/vscode-agent-orchestrator
cd vscode-agent-orchestrator
npm install
npm run build
code .
# press F5 to launch the Extension Development Host with a sample workflow
```

In the dev host window:

1. `Ctrl+Shift+P` → **Agent Orchestrator: Open Graph Editor**
2. Click a node → ▶ Run selected (or type `@orchestrator /run sec` in the native chat)
3. Graph runs show their captured transcript in the selected node's **Run Output** panel; chat commands still stream in the native chat panel.

## Local install

For day-to-day use, install a local VSIX into your normal VS Code instead of launching the Extension Development Host every time:

```sh
npm run install:local
```

Then reload VS Code and search the Command Palette for **Agent Orchestrator**. The extension id is `jpc-local.vscode-agent-orchestrator`.

When you change extension source, run `npm run install:local` again and reload VS Code. For debugging breakpoints and extension-host logs, keep using `F5` / **Run Extension**.

To remove the local install:

```sh
npm run uninstall:local
```

## Headless preview

The package now also builds a small Node CLI that uses the VS Code-independent runner. This is the first step toward daemon mode; today it is useful for dry runs, static-response smoke tests, and OpenAI-compatible model calls outside VS Code.

```sh
npm run build
node dist/agent-orchestrator.js list
node dist/agent-orchestrator.js run Project_Manager --dry-run
node dist/agent-orchestrator.js run Project_Manager --mock-response "Two sentences from the headless runner."
```

Use `--dry-run` to validate dispatch/prompt wiring, or `--mock-response` to push a deterministic response through file artifacts, graph-edge handoffs, and the ledger.

For real headless model calls, configure an OpenAI-compatible provider:

```sh
set OPENAI_API_KEY=sk-...
node dist/agent-orchestrator.js run Project_Manager --provider openai --model gpt-4o-mini
```

The CLI also honors `AGENT_ORCHESTRATOR_MODEL_PROVIDER`, `AGENT_ORCHESTRATOR_MODEL`, `AGENT_ORCHESTRATOR_OPENAI_API_KEY`, and `AGENT_ORCHESTRATOR_OPENAI_BASE_URL`. `OPENAI_BASE_URL` works for OpenAI-compatible gateways, local servers, and proxy providers that expose `/v1/chat/completions`.

You can add optional headless workspace hooks directly in `.agent-orchestrator/workflows.json`:

```jsonc
{
    "headless": {
        "hooks": {
            "beforeRun": "npm test",
            "afterRun": "node scripts/collect-proof.js",
            "timeoutMs": 60000
        }
    }
}
```

Hooks run from the workspace root. `beforeRun` failures fail the attempt; `afterRun` is best-effort and always recorded in the ledger.

## Commands

| Command | What it does |
|---|---|
| Agent Orchestrator: Open Graph Editor | Webview with React Flow canvas + JSON view + ledger tail |
| Agent Orchestrator: Run Node Manually | Quick-pick a node and dispatch it |
| Agent Orchestrator: Open Node Chat Window | Quick-pick a node and open its live transcript tab |
| Agent Orchestrator: Tail Ledger | Open `ledger.jsonl` for review |
| Agent Orchestrator: Emergency Stop | Disable all triggers and set the global enabled flag to false |

## Settings

| Setting | Default | What |
|---|---|---|
| `vscodeAgentOrchestrator.enabled` | `true` | Master kill switch — when false, no triggers fire |
| `vscodeAgentOrchestrator.dryRun` | `false` | Log dispatch intents without model calls |
| `vscodeAgentOrchestrator.dispatchMode` | `background` | Trigger/graph dispatch mode: `background` runs independent extension-host node sessions; `chat` restores the legacy chat-panel path |
| `vscodeAgentOrchestrator.ghPollSeconds` | `60` | GitHub PR polling interval (min 15) |
| `vscodeAgentOrchestrator.toolRoundLimit` | `64` | Global maximum model/tool-call rounds per node run (1-200); nodes can override this in their Runtime settings |
| `vscodeAgentOrchestrator.maxToolsPerRequest` | `128` | Maximum advertised tools per model request (1-128); VS Code rejects requests above 128, so this cannot be unlimited |
| `vscodeAgentOrchestrator.blockedTools` | Known-problem tools | Native tool names to hide from orchestrated node runs; set to `[]` to expose all tools |

## Why a graph editor and not just `chat.md` files?

Three reasons:
1. **Trigger configuration** is more readable as nodes-with-fields than YAML frontmatter on a markdown file.
2. **Edges** make the dependency / handoff structure visible at a glance.
3. **Live ledger tail** in the same surface lets you see the chain firing in real time.

The underlying source of truth is still a single JSON file (`workflows.json`) that you can commit, diff, and hand-edit via the **View as JSON** toggle.

## License

MIT — see [LICENSE](./LICENSE).

## Status

This is personal-use software, not a product. Expect rough edges. The architecture plan lives in [docs/plan.md](./docs/plan.md).
