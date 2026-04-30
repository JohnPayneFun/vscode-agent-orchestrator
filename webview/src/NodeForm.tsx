import React from "react";
import type {
  WorkflowNode,
  TriggerConfig,
  TriggerType,
  ModelSelector,
  AgentOption,
  ModelOption
} from "../../shared/types.js";

interface Props {
  node: WorkflowNode;
  agents: AgentOption[];
  models: ModelOption[];
  onChange: (next: WorkflowNode) => void;
  onDelete: () => void;
}

export function NodeForm({ node, agents, models, onChange, onDelete }: Props): JSX.Element {
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
  const selectedAgent = agents.find((agent) => agent.id === node.agent) ?? null;
  const selectedModel = m ? models.find((model) => modelMatchesSelector(model, m)) ?? null : null;
  const modelSelectValue = m ? (selectedModel ? modelKey(selectedModel) : "__custom") : "";

  return (
    <div>
      <h3>Node</h3>
      <p className="field-note">ID: <code>{node.id}</code></p>
      <label>Label</label>
      <input value={node.label} onChange={(e) => set("label", e.target.value)} />

      <label>Agent</label>
      <select
        value={node.agent}
        onChange={(e) => {
          const nextAgent = agents.find((agent) => agent.id === e.target.value) ?? null;
          onChange({
            ...node,
            agent: e.target.value,
            label:
              nextAgent && (node.label.trim() === "" || node.label === "New Persona")
                ? nextAgent.label
                : node.label
          });
        }}
      >
        <option value="">No custom agent</option>
        {agents.map((agent) => (
          <option key={`${agent.source}:${agent.id}`} value={agent.id} title={agent.path}>
            {agent.label} ({agent.source})
          </option>
        ))}
      </select>
      {selectedAgent?.description ? (
        <p className="field-note">{selectedAgent.description}</p>
      ) : null}

      <label>On Trigger</label>
      <select value={node.trigger.type} onChange={(e) => setTriggerType(e.target.value as TriggerType)}>
        <option value="manual">Manual</option>
        <option value="handoff">New Message (handoff received)</option>
        <option value="timer">Timer (cron)</option>
        <option value="ghPr">GitHub PR</option>
        <option value="fileChange">File change</option>
        <option value="startup">Workspace start</option>
        <option value="diagnostics">Problems / diagnostics</option>
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
        Leave blank to use whatever the user picks in the native chat model dropdown.
      </p>
      <label>Model</label>
      <select
        value={modelSelectValue}
        onChange={(e) => {
          const value = e.target.value;
          if (!value) {
            setModel(null);
            return;
          }
          const nextModel = models.find((model) => modelKey(model) === value);
          setModel(nextModel ? selectorFromModel(nextModel) : m);
        }}
      >
        <option value="">Use chat picker default</option>
        {m && !selectedModel ? <option value="__custom">Custom: {formatModelSelector(m)}</option> : null}
        {models.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)}>
            {model.name} ({model.vendor})
          </option>
        ))}
      </select>
      {m ? <p className="field-note">{formatModelSelector(m)}</p> : null}

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

function selectorFromModel(model: ModelOption): ModelSelector {
  return {
    vendor: model.vendor,
    family: model.family,
    id: model.id,
    version: model.version
  };
}

function modelMatchesSelector(model: ModelOption, selector: ModelSelector): boolean {
  return (
    (!selector.vendor || selector.vendor === model.vendor) &&
    (!selector.family || selector.family === model.family) &&
    (!selector.id || selector.id === model.id) &&
    (!selector.version || selector.version === model.version)
  );
}

function modelKey(model: ModelOption): string {
  return [model.vendor, model.family, model.id, model.version].join("||");
}

function formatModelSelector(selector: ModelSelector): string {
  return [
    selector.vendor ? `vendor=${selector.vendor}` : "",
    selector.family ? `family=${selector.family}` : "",
    selector.id ? `id=${selector.id}` : "",
    selector.version ? `version=${selector.version}` : ""
  ]
    .filter(Boolean)
    .join(", ");
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
    case "startup":
      return (
        <>
          <label>Delay after activation (seconds)</label>
          <input
            type="number"
            min={0}
            max={3600}
            value={trigger.delaySeconds ?? 3}
            onChange={(e) => onChange({ ...trigger, delaySeconds: Number(e.target.value) || 0 })}
          />
        </>
      );
    case "diagnostics":
      return (
        <>
          <label>File glob</label>
          <input
            value={trigger.glob}
            placeholder="src/**/*"
            onChange={(e) => onChange({ ...trigger, glob: e.target.value })}
          />
          <label>Severity</label>
          <select
            value={trigger.severity}
            onChange={(e) => onChange({ ...trigger, severity: e.target.value as typeof trigger.severity })}
          >
            <option value="any">Any</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
            <option value="info">Info</option>
            <option value="hint">Hints</option>
          </select>
          <label>Debounce (milliseconds)</label>
          <input
            type="number"
            min={100}
            max={60000}
            value={trigger.debounceMs ?? 1000}
            onChange={(e) => onChange({ ...trigger, debounceMs: Number(e.target.value) || 1000 })}
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
    case "startup":
      return { type: "startup", delaySeconds: 3 };
    case "diagnostics":
      return { type: "diagnostics", glob: "src/**/*", severity: "error", debounceMs: 1000 };
  }
}
