import React from "react";
import type {
  WorkflowNode,
  TriggerConfig,
  TriggerLeafConfig,
  TriggerType,
  ModelReasoningEffort,
  ModelSelector,
  AgentOption,
  ModelOption,
  SourceControlInfo
} from "../../shared/types.js";

interface Props {
  node: WorkflowNode;
  agents: AgentOption[];
  models: ModelOption[];
  sourceControl: SourceControlInfo | null;
  onRefreshSourceControl: () => void;
  onChange: (next: WorkflowNode) => void;
  onDelete: () => void;
}

export function NodeForm({ node, agents, models, sourceControl, onRefreshSourceControl, onChange, onDelete }: Props): JSX.Element {
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

  const setModelIdentity = (nextModel: ModelOption | null): void => {
    const reasoningEffort = m?.reasoningEffort;
    if (!nextModel) {
      setModel(reasoningEffort ? { reasoningEffort } : null);
      return;
    }
    setModel({ ...selectorFromModel(nextModel), ...(reasoningEffort ? { reasoningEffort } : {}) });
  };

  const setReasoningEffort = (reasoningEffort: ModelReasoningEffort | null): void => {
    const base = m ? { ...m } : {};
    if (reasoningEffort) base.reasoningEffort = reasoningEffort;
    else delete base.reasoningEffort;
    setModel(Object.keys(base).length > 0 ? base : null);
  };

  const m = node.model ?? null;
  const selectedAgent = agents.find((agent) => agent.id === node.agent) ?? null;
  const hasIdentity = m ? hasModelIdentity(m) : false;
  const selectedModel = hasIdentity && m ? models.find((model) => modelMatchesSelector(model, m)) ?? null : null;
  const modelSelectValue = hasIdentity && m ? (selectedModel ? modelKey(selectedModel) : "__custom") : "";

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
        <option value="any">Any of these inputs</option>
        <option value="handoff">New Message (handoff received)</option>
        <option value="interval">Timer (simple interval)</option>
        <option value="timer">Timer (cron)</option>
        <option value="ghPr">GitHub PR</option>
        <option value="fileChange">File change</option>
        <option value="startup">Workspace start</option>
        <option value="diagnostics">Problems / diagnostics</option>
        <option value="webhook">Webhook</option>
      </select>

      <TriggerFields
        trigger={node.trigger}
        sourceControl={sourceControl}
        onRefreshSourceControl={onRefreshSourceControl}
        onChange={setTrigger}
      />

      <label>Context (system prompt — the persona's standing instructions)</label>
      <textarea
        rows={6}
        value={node.context}
        onChange={(e) => set("context", e.target.value)}
        placeholder="You are a security engineer. When you receive a PR diff, ..."
      />
      <div className="row" style={{ marginTop: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={node.display?.showFullContext ?? false}
            style={{ width: "auto" }}
            onChange={(e) => set("display", { ...(node.display ?? {}), showFullContext: e.target.checked })}
          />
          Show full context on node
        </label>
      </div>

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
            setModelIdentity(null);
            return;
          }
          const nextModel = models.find((model) => modelKey(model) === value);
          if (nextModel) setModelIdentity(nextModel);
        }}
      >
        <option value="">Use chat picker default</option>
        {hasIdentity && m && !selectedModel ? <option value="__custom">Custom: {formatModelSelector(m)}</option> : null}
        {models.map((model) => (
          <option key={modelKey(model)} value={modelKey(model)}>
            {model.name} ({model.vendor})
          </option>
        ))}
      </select>
      <label>Thinking effort</label>
      <select
        value={m?.reasoningEffort ?? ""}
        onChange={(e) => setReasoningEffort(e.target.value ? (e.target.value as ModelReasoningEffort) : null)}
      >
        <option value="">Use model/default</option>
        <option value="none">None</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="xhigh">Extra High</option>
      </select>
      {m ? <p className="field-note">{formatModelSelector(m)}</p> : null}

      <h3 style={{ marginTop: 18 }}>Runtime (optional)</h3>
      <p className="field-note">Leave blank to use the global tool-round limit.</p>
      <label>Tool round limit</label>
      <input
        type="number"
        min={1}
        max={200}
        value={node.toolRoundLimit ?? ""}
        placeholder="Use global default"
        onChange={(e) => set("toolRoundLimit", parseOptionalLimit(e.target.value))}
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

function parseOptionalLimit(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
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

function hasModelIdentity(selector: ModelSelector): boolean {
  return Boolean(selector.vendor?.trim() || selector.family?.trim() || selector.id?.trim() || selector.version?.trim());
}

function modelKey(model: ModelOption): string {
  return [model.vendor, model.family, model.id, model.version].join("||");
}

function formatModelSelector(selector: ModelSelector): string {
  return [
    selector.vendor ? `vendor=${selector.vendor}` : "",
    selector.family ? `family=${selector.family}` : "",
    selector.id ? `id=${selector.id}` : "",
    selector.version ? `version=${selector.version}` : "",
    selector.reasoningEffort ? `thinking=${formatReasoningEffort(selector.reasoningEffort)}` : ""
  ]
    .filter(Boolean)
    .join(", ");
}

function formatReasoningEffort(effort: ModelReasoningEffort): string {
  switch (effort) {
    case "none":
      return "None";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "Extra High";
  }
}

function TriggerFields({
  trigger,
  sourceControl,
  onRefreshSourceControl,
  onChange,
  allowOperator = true
}: {
  trigger: TriggerConfig;
  sourceControl: SourceControlInfo | null;
  onRefreshSourceControl: () => void;
  onChange: (t: TriggerConfig) => void;
  allowOperator?: boolean;
}): JSX.Element | null {
  switch (trigger.type) {
    case "any":
      return (
        <div className="trigger-list">
          {trigger.triggers.map((child, index) => (
            <React.Fragment key={`${index}:${child.type}`}>
              {index > 0 ? <div className="trigger-or-separator">OR</div> : null}
              <div className="trigger-group">
                <div className="row trigger-group-header">
                  <div>
                    <label>Input {index + 1}</label>
                    <select
                      value={child.type}
                      onChange={(e) => {
                        const nextChild = defaultTrigger(e.target.value as TriggerType) as TriggerLeafConfig;
                        onChange({
                          ...trigger,
                          triggers: trigger.triggers.map((candidate, childIndex) => (childIndex === index ? nextChild : candidate))
                        });
                      }}
                    >
                      {leafTriggerOptions()}
                    </select>
                  </div>
                  <button
                    className="secondary"
                    disabled={trigger.triggers.length <= 1}
                    onClick={() => onChange({ ...trigger, triggers: trigger.triggers.filter((_, childIndex) => childIndex !== index) })}
                  >
                    Remove
                  </button>
                </div>
                <TriggerFields
                  trigger={child}
                  sourceControl={sourceControl}
                  onRefreshSourceControl={onRefreshSourceControl}
                  allowOperator={false}
                  onChange={(nextChild) =>
                    onChange({
                      ...trigger,
                      triggers: trigger.triggers.map((candidate, childIndex) =>
                        childIndex === index ? (nextChild as TriggerLeafConfig) : candidate
                      )
                    })
                  }
                />
              </div>
            </React.Fragment>
          ))}
          <div className="trigger-or-action">
            <button
              className="secondary"
              onClick={() => onChange({ ...trigger, triggers: [...trigger.triggers, defaultAdditionalInput(trigger.triggers)] })}
            >
              + OR
            </button>
          </div>
        </div>
      );
    case "ghPr":
      return withTriggerOperator(
        <>
          <label>Repo (owner/repo)</label>
          <input
            value={trigger.repo}
            placeholder="owner/repo"
            onChange={(e) => onChange({ ...trigger, repo: e.target.value })}
          />
          {sourceControl?.ownerRepo || sourceControl?.currentBranch ? (
            <p className="field-note">
              Detected {sourceControl.ownerRepo ?? "workspace repo"}{sourceControl.currentBranch ? ` on ${sourceControl.currentBranch}` : ""}.
            </p>
          ) : sourceControl?.error ? (
            <p className="field-note">Source control detection failed: {sourceControl.error}</p>
          ) : null}
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="secondary"
              disabled={!sourceControl?.ownerRepo}
              onClick={() => sourceControl?.ownerRepo && onChange({ ...trigger, repo: sourceControl.ownerRepo })}
            >
              Use detected repo
            </button>
            <button
              className="secondary"
              disabled={!sourceControl?.ownerRepo || !sourceControl.currentBranchFilter}
              onClick={() =>
                sourceControl?.ownerRepo &&
                sourceControl.currentBranchFilter &&
                onChange({ ...trigger, repo: sourceControl.ownerRepo, branchFilter: sourceControl.currentBranchFilter })
              }
            >
              Use repo + branch
            </button>
            <button className="secondary" onClick={onRefreshSourceControl}>
              Refresh
            </button>
          </div>
          <label>Branch filter (optional regex)</label>
          <input
            value={trigger.branchFilter ?? ""}
            placeholder={sourceControl?.currentBranchFilter ?? "^feature/.+$"}
            onChange={(e) => onChange({ ...trigger, branchFilter: e.target.value.trim() || null })}
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
        </>,
        trigger,
        onChange,
        allowOperator
      );
    case "timer":
      return withTriggerOperator(
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
        </>,
        trigger,
        onChange,
        allowOperator
      );
    case "interval":
      return withTriggerOperator(
        <>
          <div className="row">
            <div>
              <label>Every</label>
              <input
                type="number"
                min={1}
                value={trigger.every}
                onChange={(e) => onChange({ ...trigger, every: Number(e.target.value) || 1 })}
              />
            </div>
            <div>
              <label>Unit</label>
              <select
                value={trigger.unit}
                onChange={(e) => onChange({ ...trigger, unit: e.target.value as typeof trigger.unit })}
              >
                <option value="seconds">seconds</option>
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
            </div>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={trigger.runOnStart ?? false}
                style={{ width: "auto" }}
                onChange={(e) => onChange({ ...trigger, runOnStart: e.target.checked })}
              />
              Run once when trigger starts
            </label>
          </div>
        </>,
        trigger,
        onChange,
        allowOperator
      );
    case "fileChange":
      return withTriggerOperator(
        <>
          <label>Glob pattern</label>
          <input
            value={trigger.glob}
            placeholder="src/**/*.ts"
            onChange={(e) => onChange({ ...trigger, glob: e.target.value })}
          />
        </>,
        trigger,
        onChange,
        allowOperator
      );
    case "startup":
      return withTriggerOperator(
        <>
          <label>Delay after activation (seconds)</label>
          <input
            type="number"
            min={0}
            max={3600}
            value={trigger.delaySeconds ?? 3}
            onChange={(e) => onChange({ ...trigger, delaySeconds: Number(e.target.value) || 0 })}
          />
        </>,
        trigger,
        onChange,
        allowOperator
      );
    case "diagnostics":
      return withTriggerOperator(
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
        </>,
        trigger,
        onChange,
        allowOperator
      );
    case "webhook":
      return withTriggerOperator(
        <>
          <label>Path</label>
          <input
            value={trigger.path}
            placeholder="/agent-orchestrator/security"
            onChange={(e) => onChange({ ...trigger, path: e.target.value })}
          />
          <label>Port</label>
          <input
            type="number"
            min={1024}
            max={65535}
            value={trigger.port ?? 8787}
            onChange={(e) => onChange({ ...trigger, port: Number(e.target.value) || 8787 })}
          />
          <label>Secret env var (optional)</label>
          <input
            value={trigger.secretEnv ?? ""}
            placeholder="AGENT_ORCHESTRATOR_WEBHOOK_SECRET"
            onChange={(e) => onChange({ ...trigger, secretEnv: e.target.value || null })}
          />
          <label>Secret header</label>
          <input
            value={trigger.secretHeader ?? "x-agent-orchestrator-secret"}
            placeholder="x-agent-orchestrator-secret"
            onChange={(e) => onChange({ ...trigger, secretHeader: e.target.value || undefined })}
          />
        </>,
        trigger,
        onChange,
        allowOperator
      );
    case "handoff":
    case "manual":
    default:
      return withTriggerOperator(null, trigger, onChange, allowOperator);
  }
}

function withTriggerOperator(
  fields: JSX.Element | null,
  trigger: TriggerLeafConfig,
  onChange: (t: TriggerConfig) => void,
  allowOperator: boolean
): JSX.Element | null {
  if (!allowOperator) return fields;
  return (
    <>
      {fields}
      <div className="trigger-or-action">
        <button
          className="secondary"
          onClick={() => onChange({ type: "any", triggers: [trigger, defaultAdditionalInput(trigger)] })}
        >
          + OR
        </button>
      </div>
    </>
  );
}

function defaultAdditionalInput(existing: TriggerLeafConfig | TriggerLeafConfig[]): TriggerLeafConfig {
  const triggers = Array.isArray(existing) ? existing : [existing];
  if (!triggers.some((trigger) => trigger.type === "handoff")) return { type: "handoff" };
  if (!triggers.some((trigger) => trigger.type === "interval")) return { type: "interval", every: 30, unit: "minutes" };
  return { type: "manual" };
}

function defaultTrigger(type: TriggerType): TriggerConfig {
  switch (type) {
    case "any":
      return { type: "any", triggers: [{ type: "handoff" }, { type: "interval", every: 30, unit: "minutes" }] };
    case "ghPr":
      return { type: "ghPr", repo: "owner/repo", events: ["opened", "synchronize"], branchFilter: null };
    case "timer":
      return { type: "timer", cron: "*/27 * * * *", tz: "local" };
    case "interval":
      return { type: "interval", every: 15, unit: "minutes", runOnStart: false };
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
    case "webhook":
      return { type: "webhook", path: "/agent-orchestrator/webhook", port: 8787, secretEnv: null };
  }
}

function leafTriggerOptions(): JSX.Element[] {
  return [
    <option key="manual" value="manual">Manual</option>,
    <option key="handoff" value="handoff">New Message (handoff received)</option>,
    <option key="interval" value="interval">Timer (simple interval)</option>,
    <option key="timer" value="timer">Timer (cron)</option>,
    <option key="ghPr" value="ghPr">GitHub PR</option>,
    <option key="fileChange" value="fileChange">File change</option>,
    <option key="startup" value="startup">Workspace start</option>,
    <option key="diagnostics" value="diagnostics">Problems / diagnostics</option>,
    <option key="webhook" value="webhook">Webhook</option>
  ];
}
