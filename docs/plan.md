# Plan: VS Code Agent Orchestrator

> **Note (2026-04-29):** This plan was originally written assuming Claude Code as the runtime. After implementation began, the design pivoted to **VS Code's native Chat Participant API + Language Model API**, removing the dependency on Anthropic's `anthropic.claude-code` extension. The graph editor, file-based handoff contract, trigger watchers, and ledger all carried over unchanged. The runtime is now a single chat participant `@orchestrator` that uses `request.model.sendRequest(...)` — so the user's choice in the native model dropdown drives every node automatically. See `README.md` for the current architecture; everything below describes the original Claude Code-targeted design and is kept for historical reference.

## Context

You have several Claude Code chat tabs open per persona (Lead Dev, UX, PM, Sec) and want them to coordinate automatically: Sec reviews each PR, hands findings to PM, PM logs them in Monday/Jira, Lead Dev polls Monday on a timer and works through open items. You drew this as a directed graph (see screenshot in conversation): each persona is a node with **Name**, **On Trigger** (GH PR / New Message / Timer), and **Context** (persona prompt), connected by drag-drop edges that route handoffs.

Research verdict: nothing off-the-shelf combines (a) named persistent personas, (b) cross-session handoff with structured payloads, (c) per-persona triggers including GitHub PR + timer + message-received, and (d) external system integration like Monday.com. Closest matches each cover roughly half: `GobbyAI/gobby` (handoff + spawning, no per-persona cron), `Lexus2016/claude-code-studio` (scheduling + multi-agent in its own web UI, not VS Code tabs), `benfinklea/nofx-vscode` (very early VS Code orchestrator, ~1 star). The primitives needed already exist in Claude Code (hooks, MCP, VS Code commands); a thin VS Code extension closes the gap. Personal use first — no marketplace polish in v1.

## The architectural constraint that shapes everything

Anthropic's `anthropic.claude-code` extension (v2.1.123) **explicitly refuses** to inject prompts into already-open chat tabs. The bundled `extension.js` shows the literal branch: if a target session panel exists, it reveals the panel and shows *"Session is already open. Your prompt was not applied — enter it manually."* Verified by reverse-engineering the bundle.

The only way third-party code delivers a prompt to a Claude Code session in VS Code is to **spawn a fresh session** via the undocumented but stable command:
```
vscode.commands.executeCommand(
  'claude-vscode.editor.open',
  undefined,                  // sessionId — undefined = new session
  promptText,                 // initial prompt (becomes data-initial-prompt on webview root)
  vscode.ViewColumn.Beside
)
```
`claude-vscode.newConversation` does **not** accept a prompt argument (verified — registered as zero-arg).

→ **Implication**: each handoff spawns a fresh ephemeral session preloaded with the persona's agent definition + the handoff payload as the first user prompt. The chat tabs in your screenshot remain as **human-interaction consoles**; orchestrated handoffs run as short-lived siblings. Persona persistent state lives in `~/.claude/agents/{name}.md` frontmatter (with `memory: user` for cross-session memory) — not in any single chat tab.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Orchestrator VS Code Extension (this project)                   │
│                                                                  │
│  Webview (React Flow graph editor)  ◄──messaging──►  extension.ts│
│                                                          │       │
│         ┌────────────────────────────────────────────────┴──┐    │
│         ▼                                                   ▼    │
│  .claude/orchestration/workflows.json     Trigger watchers:      │
│  (source of truth — your graph)            • GH-PR (gh CLI poll) │
│                                            • Timer (setInterval) │
│  .claude/orchestration/                    • Handoff (FS watcher)│
│  ├── inbox/{persona}/*.json   ← target's pending payloads        │
│  ├── outbox/{persona}/*.json  ← what was just emitted (for log)  │
│  ├── ledger.jsonl             ← append-only audit (every event)  │
│  └── triggers/                ← cron/webhook state               │
│                                                                  │
│  Hook generator → .claude/settings.local.json                    │
│  (orchestrator-owned file; never clobbers user's settings.json)  │
│                                                                  │
│  Action: spawn persona session with prompt                       │
│  → claude-vscode.editor.open(undefined, promptText, Beside)      │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
       ┌──────────────────────────────────────────────┐
       │ anthropic.claude-code (Anthropic's extension)│
       │ • Reads .claude/settings.local.json (hooks)  │
       │ • Reads ~/.claude/agents/{name}.md (persona) │
       │ • Renders the spawned session as a chat tab  │
       └──────────────────────────────────────────────┘
```

## JSON contracts (the full source of truth)

Everything the orchestrator does is driven by JSON files on disk. The graph editor is a thin renderer over these. Five contracts:

### 1. `workflows.json` — graph definition (the output of the editor)

```jsonc
// {workspace}/.claude/orchestration/workflows.json
{
  "$schema": "./runtime/workflow.schema.json",
  "version": 1,
  "id": "default",                              // multiple workflows allowed; UI shows tabs
  "name": "PR security pipeline",
  "createdAt": "2026-04-29T12:00:00Z",
  "updatedAt": "2026-04-29T12:00:00Z",
  "settings": {
    "dailyHandoffCap": 200,                     // safety: stop firing after N events/day
    "concurrencyLimit": 2,                      // max simultaneous spawned tabs
    "ledgerRetentionDays": 30
  },
  "nodes": [
    {
      "id": "sec",                              // stable id; never renamed
      "label": "SecAgent",                      // user-facing display name
      "agent": "engineering-security-engineer", // basename of ~/.claude/agents/<file>.md
      "trigger": {
        "type": "ghPr",
        "repo": "JPC/example",                  // owner/repo
        "events": ["opened", "synchronize"],    // GH PR webhook event types
        "branchFilter": null                    // optional regex; null = all branches
      },
      "context": "Do a security review on the PR diff. Emit findings as a handoff to pm.",
      "model": null,                            // null = persona's default
      "permissions": "ask",                     // "ask" | "allow" | "deny" passthrough to spawned session
      "position": { "x": 100, "y": 80 },
      "enabled": true
    },
    {
      "id": "pm",
      "label": "PMAgent",
      "agent": "product-manager",
      "trigger": { "type": "handoff" },
      "context": "When you receive findings from other agents, create Monday tasks via the Monday MCP, prioritize by severity.",
      "position": { "x": 360, "y": 260 },
      "enabled": true
    },
    {
      "id": "leadDev",
      "label": "LeadDevAgent",
      "agent": "engineering-senior-developer",
      "trigger": { "type": "timer", "cron": "*/27 * * * *", "tz": "local" },
      "context": "Check Monday for open items. Pick highest priority, implement, update status and notes.",
      "position": { "x": 620, "y": 80 },
      "enabled": true
    }
  ],
  "edges": [
    {
      "id": "e_sec_pm",
      "from": "sec",
      "to": "pm",
      "payloadSchema": {                        // shape the producer must emit and consumer can rely on
        "type": "object",
        "required": ["findings"],
        "properties": {
          "findings": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["severity", "description"],
              "properties": {
                "severity":       { "enum": ["critical", "high", "medium", "low", "info"] },
                "file":           { "type": "string" },
                "line":           { "type": "integer" },
                "description":    { "type": "string" },
                "recommendation": { "type": "string" }
              }
            }
          },
          "prNumber": { "type": "integer" },
          "prUrl":    { "type": "string", "format": "uri" }
        }
      }
    },
    {
      "id": "e_pm_leadDev",
      "from": "pm",
      "to": "leadDev",
      "via": "monday",                          // edge exists for graph display; runtime state lives in Monday
      "payloadSchema": null
    }
  ]
}
```

### 2. Inbox payload — `{workspace}/.claude/orchestration/inbox/{persona}/{ts}_{uuid}.json`

```jsonc
{
  "schemaVersion": 1,
  "id": "01J7XK3...",                           // ULID; matches outbox copy & ledger entry
  "createdAt": "2026-04-29T12:34:56.789Z",
  "from": "sec",
  "to": "pm",
  "edgeId": "e_sec_pm",
  "trigger": { "type": "ghPr", "prNumber": 42, "headSha": "abc123" },  // what kicked off the chain
  "payload": {                                  // conforms to edge.payloadSchema
    "findings": [
      { "severity": "high", "file": "auth.py", "line": 87,
        "description": "JWT signature not verified", "recommendation": "Use jwt.decode(..., verify=True)" }
    ],
    "prNumber": 42,
    "prUrl": "https://github.com/JPC/example/pull/42"
  },
  "trace": {                                    // for debugging chains
    "rootId": "01J7XJ0...",                     // first event in this chain
    "depth": 1,                                 // hops from root
    "parents": ["01J7XJ0..."]
  }
}
```

### 3. Outbox payload — same shape as inbox, written when the source persona's `Stop` hook parses `<<HANDOFF>>` blocks. Mirrors the file dropped into the target's inbox so producer-side history is recoverable even if the target consumes and deletes.

### 4. `ledger.jsonl` — append-only audit log, one event per line

```jsonc
{ "ts": "2026-04-29T12:34:56.789Z", "type": "trigger.fired",
  "node": "sec", "trigger": "ghPr", "detail": { "prNumber": 42 }, "eventId": "01J7XJ0..." }
{ "ts": "2026-04-29T12:34:57.012Z", "type": "session.spawned",
  "node": "sec", "claudeSessionId": null, "vsCodeTabId": "panel:7",
  "promptLength": 1842, "eventId": "01J7XJ0..." }
{ "ts": "2026-04-29T12:36:10.301Z", "type": "handoff.emitted",
  "from": "sec", "to": "pm", "edgeId": "e_sec_pm", "handoffId": "01J7XK3...",
  "payloadBytes": 612, "eventId": "01J7XJ0..." }
{ "ts": "2026-04-29T12:36:10.450Z", "type": "handoff.delivered",
  "to": "pm", "handoffId": "01J7XK3...", "inboxPath": ".claude/orchestration/inbox/pm/...json" }
{ "ts": "2026-04-29T12:36:11.118Z", "type": "session.spawned",
  "node": "pm", "promptLength": 2104, "handoffId": "01J7XK3..." }
{ "ts": "2026-04-29T12:38:02.900Z", "type": "guardrail.tripped",
  "rule": "dailyHandoffCap", "limit": 200, "current": 200, "action": "halted" }
```

Event types: `trigger.fired`, `session.spawned`, `session.errored`, `handoff.emitted`, `handoff.delivered`, `handoff.consumed`, `guardrail.tripped`, `workflow.saved`.

### 5. Trigger configs — discriminated union on `type`

```jsonc
// type: "ghPr"
{ "type": "ghPr", "repo": "owner/repo", "events": ["opened", "synchronize", "reopened"], "branchFilter": null }

// type: "timer"
{ "type": "timer", "cron": "*/27 * * * *", "tz": "local" }

// type: "handoff"   (wakes when inbox/{persona}/* appears; no other config)
{ "type": "handoff" }

// type: "manual"    (only fires when user clicks Run in graph)
{ "type": "manual" }

// type: "fileChange"  (deferred to v1.1; included so schema is forward-compatible)
{ "type": "fileChange", "glob": "src/**/*.ts" }
```

### Where each contract lives

| Contract | Path | Owner | Lifetime |
|---|---|---|---|
| `workflows.json` | `{workspace}/.claude/orchestration/workflows.json` | Editor | Persistent, version-controlled |
| Inbox payload | `inbox/{persona}/{ts}_{ulid}.json` | Producer hook | Deleted by consumer hook on read |
| Outbox payload | `outbox/{persona}/{ts}_{ulid}.json` | Producer hook | Last 50 retained per persona (rolling) |
| Ledger entry | `ledger.jsonl` | Both hooks + extension | Rotated by `ledgerRetentionDays` |
| Trigger state | `triggers/state.json` | Watchers | Persistent (last-seen SHAs, cron ticks) |

### Round-trip example matching your screenshot

```
SecAgent.trigger.ghPr fires (PR #42 opened)
  → ledger: trigger.fired
  → spawn Sec session with prompt
  → ledger: session.spawned
Sec session emits <<HANDOFF target=pm>>{"findings":[...],"prNumber":42}<<END>>
  → Stop hook writes outbox/sec/...json AND inbox/pm/...json
  → ledger: handoff.emitted, handoff.delivered
PMAgent.trigger.handoff fires (FSWatcher on inbox/pm/)
  → spawn PM session with prompt + drained inbox
  → PM calls Monday MCP create_item; emits no handoff (edge is "via": "monday")
  → ledger: handoff.consumed
LeadDev.trigger.timer fires (next */27 tick)
  → spawn LeadDev session; reads Monday open items via MCP; works one
  → ledger: trigger.fired, session.spawned
```

A JSON Schema file (`runtime/workflow.schema.json`) ships with the extension. The webview validates on save before writing — invalid graphs never reach disk.

## Trigger types (v1)

| Type | Implementation | Notes |
|---|---|---|
| `ghPr` | Poll `gh pr list --json number,headRefOid,createdAt --repo {repo}` every 60s; cache last seen `headRefOid` per PR | `gh` is already installed; avoids running an HTTP server |
| `timer` | `setInterval` in extension host; cron parsed via `cron-parser` npm | Off-minute jitter applied automatically (e.g. user types `*/30` → stored `*/27`) |
| `handoff` | `vscode.workspace.createFileSystemWatcher('**/.claude/orchestration/inbox/{persona}/*.json')` | Debounced 500ms |
| `manual` | Right-click node → "Run now" | For testing |

GitHub webhook (push-based) is deferred to v1.1 — polling is good enough for personal use and avoids exposing a port.

## Action (what firing a node does)

1. Drain `inbox/{persona}/*.json` into a single JSON payload.
2. Read node's `context` + edge `payloadSchema` → compose initial prompt:
   ```
   You are {agent}. {context}
   Incoming handoff:
   {payload as fenced JSON}
   When done, emit any handoffs as: <<HANDOFF target=X>>{json}<<END>>
   ```
3. `executeCommand('claude-vscode.editor.open', undefined, prompt, ViewColumn.Beside)` — spawns a fresh tab labeled by the agent name.
4. Generated `Stop` hook runs at end of turn, parses the assistant's last message from `transcript_path` (the hook payload provides `session_id`, `transcript_path`, `cwd`, `hook_event_name` — **not** the message content directly), extracts `<<HANDOFF target=X>>...<<END>>` blocks, writes each to `inbox/X/{ts}.json`. Also appends a row to `ledger.jsonl`.
5. Inbox watcher on target persona fires its trigger — loop continues.

## Hook plumbing

Generated into `.claude/settings.local.json` (orchestrator-owned, gitignored, never overwrites your `settings.json`):

```jsonc
{
  "hooks": {
    "Stop": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node ${workspaceFolder}/.claude/orchestration/runtime/stop.js" }] }
    ],
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node ${workspaceFolder}/.claude/orchestration/runtime/prompt-submit.js" }] }
    ]
  }
}
```

`stop.js` and `prompt-submit.js` are tiny Node scripts emitted by the extension (one shared copy, persona-aware via reading session's agent name from `transcript_path` JSONL). `prompt-submit.js` returns `{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit", "additionalContext": "..." } }` to inject pending inbox items when a human types in a long-lived persona console (graceful degradation for the human-driven path).

## Directory layout (created on extension activation)

```
{workspace}/.claude/
├── orchestration/
│   ├── workflows.json              # Graph (source of truth)
│   ├── inbox/{persona}/*.json      # Pending handoffs
│   ├── outbox/{persona}/*.json     # Last 50 emitted (for inspection)
│   ├── ledger.jsonl                # Append-only audit log
│   ├── triggers/state.json         # Last seen PR SHAs, timer ticks
│   └── runtime/
│       ├── stop.js                 # Generated, ~80 LOC
│       ├── prompt-submit.js        # Generated, ~40 LOC
│       └── handoff-schema.json
└── settings.local.json             # Generated hooks config (gitignored)
```

## Implementation phases

**Phase 1 — Skeleton + spawn (1-2 days)**
1. `yo code` scaffold a TypeScript VS Code extension named `claude-orchestrator`.
2. Single command `Claude Orchestrator: Open Graph` that opens an empty Webview.
3. Verify `claude-vscode.editor.open(undefined, "hello", ViewColumn.Beside)` spawns a Claude tab with prompt prefilled. **This is the load-bearing assumption — verify before writing anything else.**

**Phase 2 — Graph editor (3-4 days)**
4. Webview hosts a React Flow canvas. Custom node component renders Name / Trigger badge / Context (matches your sketch).
5. Right panel: edit node fields. Persona dropdown lists `~/.claude/agents/*.md` (162 prebuilt + any local).
6. Drag-drop creates edges. Save round-trips through extension to `workflows.json`.
7. **Dual-view toggle**: top-right button switches the canvas between "Graph" and "JSON". JSON view is a Monaco editor wired to the same `workflows.json` file with live `workflow.schema.json` validation — edits in either view update the other on save. This lets you commit/diff workflows in git, paste into prompts, and hand-edit edges that are awkward to draw.

**Phase 3 — Runtime (3-4 days)**
7. Trigger watchers: timer (`setInterval` + `cron-parser`), handoff (`FileSystemWatcher`), gh-pr (60s `gh` poll).
8. Action runner: drains inbox, composes prompt, calls `editor.open`.
9. Hook generator: writes `.claude/settings.local.json` + emits `runtime/stop.js` + `runtime/prompt-submit.js`.
10. Ledger view: bottom panel showing `ledger.jsonl` tail with filters.

**Phase 4 — End-to-end demo (2-3 days)**
11. Install Monday.com MCP (none currently installed — verify availability or fall back to a stub MCP that writes to a local JSON "Monday-mock").
12. Build the exact 3-node workflow in your screenshot (Sec → PM → Lead Dev).
13. Open a real PR in a test repo, watch the chain fire, confirm a Monday item is created and Lead Dev picks it up on the next timer tick.

## Critical files and references

- **Existing prebuilt agents** to wire up (no new persona files needed): [engineering-security-engineer.md](C:/Users/JPC/.claude/agents/engineering-security-engineer.md), [product-manager.md](C:/Users/JPC/.claude/agents/product-manager.md), [engineering-senior-developer.md](C:/Users/JPC/.claude/agents/engineering-senior-developer.md), [agents-orchestrator.md](C:/Users/JPC/.claude/agents/agents-orchestrator.md)
- **Anthropic extension to confirm command signatures against**: `C:/Users/JPC/.vscode/extensions/anthropic.claude-code-2.1.123-win32-x64/extension.js` and its `package.json`
- **Hooks doc**: https://code.claude.com/docs/en/hooks (UserPromptSubmit `additionalContext` is the documented injection mechanism)
- **Plan file (this file, only file editable in plan mode)**: [majestic-dreaming-clock.md](C:/Users/JPC/.claude/plans/majestic-dreaming-clock.md)

## Verification

After Phase 1: open the extension command, run a one-shot test that spawns a Claude tab with `"Say hello and stop"` prefilled. If the tab opens and the prompt is visible, the load-bearing assumption holds.

After Phase 3: define a 2-node manual workflow (NodeA `manual` trigger → NodeB `handoff` trigger). Click Run on NodeA. Confirm:
- A Claude tab opens with NodeA's persona + prompt.
- When that turn ends, `outbox/nodeA/*.json` and `inbox/nodeB/*.json` both appear.
- A second Claude tab spawns automatically for NodeB with the payload.
- `ledger.jsonl` shows two events with correct timestamps.

After Phase 4 (the screenshot's full workflow): open a PR in a test repo, wait one poll cycle (≤60s), confirm SecAgent tab opens, runs review, emits handoff. PM tab opens, calls Monday MCP. Within 27 minutes, LeadDevAgent tab opens and shows it picked up the new task.

## Open questions / risks

1. **`claude-vscode.editor.open` signature stability** — undocumented. If Anthropic renames in v2.2.x, the runtime breaks. Mitigation: feature-detect on activation; surface a clear error pointing at the disassembly notes; pin tested extension versions in extension's `engines`.
2. **Stop hook timing across spawned tabs** — if multiple personas fire near-simultaneously, hook scripts may race on `ledger.jsonl`. Use a lockfile (`proper-lockfile` npm) on writes.
3. **Monday MCP not installed** — Phase 4 needs `mondaydotcom-api/mcp-server-monday` (or equivalent). If user prefers Jira, swap MCP. Plan assumes it's pluggable per-edge.
4. **Anthropic shipped `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in v2.1.32+** with native mailbox + `SendMessage` + `TeammateIdle`/`TaskCreated`/`TaskCompleted` hooks. Worth investigating *after* Phase 1 — if it matures and works in VS Code (currently terminal-only), the file-bus could be replaced with the native primitive while the graph editor remains the value-add. Keep the runtime layer abstracted behind one `MessageBus` interface so this is a one-file swap later.
5. **Cost** — every handoff = one Claude session. Three-node loops can run away. Add a per-workflow daily-cap and emergency-stop button in the UI before Phase 3 finishes.
