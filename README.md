# vscode-agent-orchestrator

A graph-based orchestrator for multi-agent workflows in VS Code. Define personas as nodes (Sec, PM, Lead Dev, ...), attach triggers (GitHub PR, timer, message-received), connect them with drag-drop edges, and let the **native VS Code chat** drive each step — using whatever model you've picked in the chat dropdown.

Model-agnostic by design. Anything VS Code's chat picker can talk to (Copilot's GPT-4o, Claude via your Copilot subscription, Gemini, local models registered as language model providers, ...) just works — there's nothing Claude-specific in the runtime.

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
