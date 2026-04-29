import React from "react";
import type { WorkflowNode, TriggerConfig, TriggerType, ModelSelector } from "../../shared/types.js";

interface Props {
  node: WorkflowNode;
  agents: Array<{ id: string; label: string; path: string }>;
  onChange: (next: WorkflowNode) => void;
  onDelete: () => void;
}

export function NodeForm({ node, onChange, onDelete }: Props): JSX.Element {
  const set = <K extends keyof WorkflowNode>(key: K, value: WorkflowNode[K]): void => {
    onChange({ ...node, [key]: value });
  };

  const setTriggerType = (type: TriggerType): void => {
    onChange({ ...node, trigger: defaultTrigger(type) });
  };

  const setTrigger = (next: TriggerConfig): void => {
    onChange({ ...node, trigger: next });
  };

  const setModel = (next: ModelSelector | null): void => {
    onChange({ ...node, model: next });
  };

  const m = node.model ?? null;

  return (
    <div>
      <h3>Node · {node.id}</h3>
      <label>Label</label>
      <input value={node.label} onChange={(e) => set("label", e.target.value)} />

      <label>Agent label (free-form, shown on the node)</label>
      <input value={node.agent} onChange={(e) => set("agent", e.target.value)} placeholder="e.g. security-reviewer" />

      <label>On Trigger</label>
      <select value={node.trigger.type} onChange={(e) => setTriggerType(e.target.value as TriggerType)}>
        <option value="manual">Manual</option>
        <option value="handoff">New Message (handoff received)</option>
        <option value="timer">Timer (cron)</option>
        <option value="ghPr">GitHub PR</option>
        <option value="fileChange">File change</option>
      </select>

      <TriggerFields trigger={node.trigger} onChange={setTrigger} />

      <label>Context (system prompt — the persona's standing instructions)</label>
      <textarea
        rows={6}
        value={node.context}
        onChange={(e) => set("context", e.target.value)}
        placeholder="You are a security engineer. When you receive a PR diff, ..."
      />

      <h3 style={{ marginTop: 18 }}>Model (optional)</h3>
      <p style={{ fontSize: 11, opacity: 0.7, marginTop: 0 }}>
        Leave blank to use whatever the user picks in the native chat model dropdown. Fill in to pre-select a specific model via{" "}
        <code>vscode.lm.selectChatModels</code>.
      </p>
      <div className="row">
        <div>
          <label>Vendor</label>
          <input
            value={m?.vendor ?? ""}
            placeholder="copilot"
            onChange={(e) => setModel(updateModel(m, { vendor: e.target.value || undefined }))}
          />
        </div>
        <div>
          <label>Family</label>
          <input
            value={m?.family ?? ""}
            placeholder="gpt-4o"
            onChange={(e) => setModel(updateModel(m, { family: e.target.value || undefined }))}
          />
        </div>
      </div>
      <label>Specific model id (optional)</label>
      <input
        value={m?.id ?? ""}
        placeholder="(leave blank to match by vendor/family)"
        onChange={(e) => setModel(updateModel(m, { id: e.target.value || undefined }))}
      />

      <div className="row" style={{ marginTop: 12 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={node.enabled}
            style={{ width: "auto" }}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          Enabled
        </label>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="danger" onClick={onDelete}>Delete node</button>
      </div>
    </div>
  );
}

function updateModel(prev: ModelSelector | null, patch: Partial<ModelSelector>): ModelSelector | null {
  const next: ModelSelector = { ...(prev ?? {}), ...patch };
  // Clean undefined keys so the JSON representation is tidy.
  for (const k of Object.keys(next) as Array<keyof ModelSelector>) {
    if (next[k] === undefined || next[k] === "") delete next[k];
  }
  return Object.keys(next).length === 0 ? null : next;
}

function TriggerFields({
  trigger,
  onChange
}: {
  trigger: TriggerConfig;
  onChange: (t: TriggerConfig) => void;
}): JSX.Element | null {
  switch (trigger.type) {
    case "ghPr":
      return (
        <>
          <label>Repo (owner/repo)</label>
          <input
            value={trigger.repo}
            placeholder="owner/repo"
            onChange={(e) => onChange({ ...trigger, repo: e.target.value })}
          />
          <label>Events</label>
          <select
            multiple
            value={trigger.events}
            onChange={(e) => {
              const values = Array.from(e.target.selectedOptions, (o) => o.value) as Array<
                "opened" | "synchronize" | "reopened" | "closed"
              >;
              onChange({ ...trigger, events: values });
            }}
            style={{ height: 80 }}
          >
            <option value="opened">opened</option>
            <option value="synchronize">synchronize</option>
            <option value="reopened">reopened</option>
            <option value="closed">closed</option>
          </select>
        </>
      );
    case "timer":
      return (
        <>
          <label>Cron (5-field, local time)</label>
          <input
            value={trigger.cron}
            placeholder="*/27 * * * *"
            onChange={(e) => onChange({ ...trigger, cron: e.target.value })}
          />
          <label>Timezone</label>
          <select value={trigger.tz} onChange={(e) => onChange({ ...trigger, tz: e.target.value as "local" | "utc" })}>
            <option value="local">local</option>
            <option value="utc">utc</option>
          </select>
        </>
      );
    case "fileChange":
      return (
        <>
          <label>Glob pattern</label>
          <input
            value={trigger.glob}
            placeholder="src/**/*.ts"
            onChange={(e) => onChange({ ...trigger, glob: e.target.value })}
          />
        </>
      );
    case "handoff":
    case "manual":
    default:
      return null;
  }
}

function defaultTrigger(type: TriggerType): TriggerConfig {
  switch (type) {
    case "ghPr":
      return { type: "ghPr", repo: "owner/repo", events: ["opened", "synchronize"], branchFilter: null };
    case "timer":
      return { type: "timer", cron: "*/27 * * * *", tz: "local" };
    case "handoff":
      return { type: "handoff" };
    case "manual":
      return { type: "manual" };
    case "fileChange":
      return { type: "fileChange", glob: "src/**/*.ts" };
  }
}
