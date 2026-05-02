# Agent Orchestrator — Sample Workspace

This folder is opened by the Extension Development Host launch config. It already contains a 3-node demo workflow under `.agent-orchestrator/workflows.json` matching the SecAgent → PMAgent → LeadDevAgent design.

## What to try

1. Run **Agent Orchestrator: Open Graph Editor** from the command palette (Ctrl+Shift+P).
2. You'll see three nodes connected by edges:
   - **SecAgent** (trigger: GH PR) → **PMAgent** (trigger: New Message) → **LeadDevAgent** (trigger: Timer · `*/27 * * * *`)
3. Toggle **View as JSON** to see the same graph as raw JSON. Edits in either view round-trip on save.
4. **To run a node manually**: click a node in the graph, then **▶ Run selected** in the toolbar for a background run. Keep the node selected to watch its **Run Output** panel, or type `@orchestrator /run sec` in the native chat panel (Ctrl+Alt+I) for an interactive chat run.

## Phase-1 verification (the load-bearing test)

Click the SecAgent node, then click ▶ Run selected. The node should run in the extension host, record activity in the graph/ledger, and show its captured transcript in the selected node's **Run Output** panel without opening the native chat panel. Type `@orchestrator /run sec` in chat when you specifically want an interactive chat-thread run.

Multi-turn chats work: type follow-ups in the same thread; the participant sees `context.history` and continues the conversation.
