# Agent Orchestrator — Sample Workspace

This folder is opened by the Extension Development Host launch config. It already contains a 3-node demo workflow under `.agent-orchestrator/workflows.json` matching the SecAgent → PMAgent → LeadDevAgent design.

## What to try

1. Run **Agent Orchestrator: Open Graph Editor** from the command palette (Ctrl+Shift+P).
2. You'll see three nodes connected by edges:
   - **SecAgent** (trigger: GH PR) → **PMAgent** (trigger: New Message) → **LeadDevAgent** (trigger: Timer · `*/27 * * * *`)
3. Toggle **View as JSON** to see the same graph as raw JSON. Edits in either view round-trip on save.
4. **To run a node manually**: click a node in the graph, then **▶ Run selected** in the toolbar — *or* type `@orchestrator /run sec` in the native chat panel (Ctrl+Alt+I).

## Phase-1 verification (the load-bearing test)

Click the SecAgent node, then click ▶ Run selected. The native VS Code chat panel should open with the prompt `@orchestrator /run sec [triggered:manual]` already filled in. The orchestrator participant streams back a response that uses whatever model you've selected in the native model dropdown.

Multi-turn chats work: type follow-ups in the same thread; the participant sees `context.history` and continues the conversation.
