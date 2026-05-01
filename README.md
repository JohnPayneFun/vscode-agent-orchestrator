# vscode-agent-orchestrator

A graph-based orchestrator for multi-agent workflows in VS Code. Define personas as nodes (Sec, PM, Lead Dev, ...), attach triggers (GitHub PR, timer, message-received), connect them with drag-drop edges, and let the **native VS Code chat** drive each step — using whatever model you've picked in the chat dropdown.

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
3. Leave **Model** blank to use the user's native VS Code chat model picker, or choose a model per node.
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
```

Watch the graph activity and ledger panel. For deeper inspection, run **Agent Orchestrator: Tail Ledger** to open `.agent-orchestrator/ledger.jsonl`.

### 5. MCP and tools

When running inside VS Code, orchestrated nodes can use registered VS Code language-model tools, including MCP tools, through the same chat/tool system used by native Agent mode. If VS Code shows a message such as an MCP server may have new tools or needs to be started, tell the user to click **Start it now**.

For MCP-heavy flows, especially Monday.com project-manager nodes, set `vscodeAgentOrchestrator.toolRoundLimit` higher if the node needs many tool calls. The default is `16`; the maximum is `50`.

Nodes should create or update files with the orchestrator's `<<WRITE_FILE path=...>>...<<END_WRITE_FILE>>` block protocol. Copilot file-mutation tools such as `copilot_createFile` are intentionally not exposed to orchestrated node model calls because they can require native chat stream state that is not available in this custom tool loop.

If a node hits a usage or rate limit and the error includes text like `Try again in ~63 min`, the orchestrator saves the failed run context, preserves drained handoffs, and schedules a one-shot retry one minute after the reported wait time. In that example, the node retries after 64 minutes. The graph shows this as `Retry scheduled`, and retry state is stored under `.agent-orchestrator/runtime/retries/` until the retry runs.

Scheduled triggers (`timer` and `interval`) also check outgoing graph-edge targets before opening chat. If a Project Manager timer fires while an output node such as Lead Dev is still `running`, the dispatch is skipped with a `downstream-running` guardrail entry and the timer waits for its next tick instead of piling up another task.

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

Each node in your graph maps to an invocation of a single chat participant, **`@orchestrator`**. When a trigger fires, the orchestrator opens the native chat panel with the query prefilled:

```
@orchestrator /run sec [triggered:ghPr:prNumber=42]
```

The participant handler (this extension) reads the node's config from your workflow file, drains pending handoffs from the node's inbox, calls `request.model.sendRequest(...)` using the model you have selected in the chat picker, streams the response back to the chat UI, then parses any `<<HANDOFF target=NODE_ID>>{...}<<END>>` blocks in the response and writes them as JSON files to the target node's inbox — which fires that node's handoff trigger and the chain continues.

State lives in `.agent-orchestrator/` at the workspace root:

```
.agent-orchestrator/
├── workflows.json        # the graph (the editor's source of truth)
├── inbox/<node>/*.json   # pending handoffs for each node
├── outbox/<node>/*.json  # last 50 emitted, for inspection
├── ledger.jsonl          # append-only audit log
├── triggers/state.json   # last-seen PR SHAs, cron ticks
└── runtime/
    └── workflow.schema.json
```

## Trigger types

| Type | Wakes the node when ... |
|---|---|
| `ghPr` | `gh pr list` polling (default 60s) detects a new or updated PR |
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

Each node has an optional `model` selector (`vendor` / `family` / `id`) that maps to `vscode.lm.selectChatModels`. Leave it blank and the participant uses whatever the user has selected in the chat dropdown — the most natural workflow.

Nodes can also set `model.reasoningEffort` to `none`, `low`, `medium`, `high`, or `xhigh`. In VS Code this is passed through as the Copilot-style `reasoningEffort` model option, matching the native Thinking Effort menu when the selected model supports it.

When running inside VS Code, node model calls expose registered language-model tools through `vscode.lm.tools` and execute requested tool calls with `vscode.lm.invokeTool`. That is what allows a node to use MCP-backed tools such as Monday.com when those tools are available in the current VS Code session. Tool calls are capped by the `vscodeAgentOrchestrator.toolRoundLimit` setting, which defaults to `16` rounds and can be raised up to `50` for MCP-heavy runs. If the same tool call fails twice with the same input and error, the orchestrator stops the run early to avoid retry loops. Usage-limit errors that say `try again in ...` are retried automatically one minute after the requested wait. Copilot file-mutation tools are filtered out; use `<<WRITE_FILE path=...>>` blocks for file artifacts instead.

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
3. The native chat panel streams the response using your selected model

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
| Agent Orchestrator: Tail Ledger | Open `ledger.jsonl` for review |
| Agent Orchestrator: Emergency Stop | Disable all triggers and set the global enabled flag to false |

## Settings

| Setting | Default | What |
|---|---|---|
| `vscodeAgentOrchestrator.enabled` | `true` | Master kill switch — when false, no triggers fire |
| `vscodeAgentOrchestrator.dryRun` | `false` | Log dispatch intents but don't open chats |
| `vscodeAgentOrchestrator.ghPollSeconds` | `60` | GitHub PR polling interval (min 15) |
| `vscodeAgentOrchestrator.toolRoundLimit` | `16` | Maximum model/tool-call rounds per node run (1-50) |

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
