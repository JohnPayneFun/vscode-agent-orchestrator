# Trigger Roadmap

This is the current trigger research shortlist, ordered by how much orchestration value each trigger unlocks.

## Near Term

1. **Webhook / HTTP**
   - Universal adapter for GitHub, Linear, Slack, CI, scripts, local tools, and future headless daemon mode.
   - Implemented first as a local `127.0.0.1` listener with optional shared-secret header auth.

2. **Git State**
   - Fire on branch changes, staged-file changes, dirty/clean transitions, or new commits.
   - Useful for code review, release notes, and repo hygiene agents.

3. **GitHub Comments / Review Requests**
   - Fire when a PR/issue comment matches a command such as `/security-review` or when a review is requested.
   - More precise than polling every PR update.

4. **Check / Test Failure**
   - Fire when a configured command exits non-zero, a CI check fails, or diagnostics cross a threshold.
   - Good fit for fix agents and failure summarizers.

## Later

5. **Artifact Created**
   - Fire when a report, export, or file artifact appears in a watched directory.
   - Useful for non-chat chains and external tool handoffs.

6. **Human Approval / Gate**
   - Pause a chain until a user approves, rejects, or edits the payload.
   - Important once actions become more autonomous.

7. **Workspace Idle / Focus**
   - Fire after the user has been idle, on window focus, or after a quiet period.
   - Useful for background summarization without interrupting work.

8. **Tracker Adapters**
   - Linear, Jira, monday.com, GitHub Issues, and similar tools should sit behind adapter boundaries rather than bespoke core trigger logic.

## Design Notes

- Prefer generic trigger primitives first: webhook, file, git, command/check.
- Keep cron for precise schedules, but expose simple interval timers for everyday “every N minutes/hours” workflows.
- Keep provider-specific integrations as adapters so headless mode can reuse them.
- Every trigger should produce a structured handoff payload before it fires the node.
- Every trigger needs a validation path in the graph UI or CLI.