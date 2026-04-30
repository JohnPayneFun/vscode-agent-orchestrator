// JSON Schema for workflows.json. Used by the extension on save and by the
// webview's JSON view for live validation.
//
// Kept hand-written rather than generated from the TS types so we can encode
// runtime-only constraints (cron format, ulid pattern) that don't survive in TS.

export const WORKFLOW_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://local/vscode-agent-orchestrator/workflow.schema.json",
  type: "object",
  required: ["version", "id", "name", "settings", "nodes", "edges"],
  additionalProperties: true,
  properties: {
    $schema: { type: "string" },
    version: { const: 1 },
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    settings: {
      type: "object",
      required: ["dailyHandoffCap", "concurrencyLimit", "ledgerRetentionDays"],
      properties: {
        dailyHandoffCap: { type: "integer", minimum: 1, maximum: 100000 },
        concurrencyLimit: { type: "integer", minimum: 1, maximum: 32 },
        ledgerRetentionDays: { type: "integer", minimum: 1, maximum: 365 }
      }
    },
    nodes: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "label", "agent", "trigger", "context", "position", "enabled"],
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
          label: { type: "string", minLength: 1 },
          agent: { type: "string" },
          trigger: {
            oneOf: [
              {
                type: "object",
                required: ["type", "repo", "events"],
                properties: {
                  type: { const: "ghPr" },
                  repo: { type: "string", pattern: "^[^/]+/[^/]+$" },
                  events: {
                    type: "array",
                    items: { enum: ["opened", "synchronize", "reopened", "closed"] }
                  },
                  branchFilter: { type: ["string", "null"] }
                }
              },
              {
                type: "object",
                required: ["type", "cron"],
                properties: {
                  type: { const: "timer" },
                  cron: { type: "string", minLength: 9 },
                  tz: { enum: ["local", "utc"] }
                }
              },
              { type: "object", required: ["type"], properties: { type: { const: "handoff" } } },
              { type: "object", required: ["type"], properties: { type: { const: "manual" } } },
              {
                type: "object",
                required: ["type", "glob"],
                properties: { type: { const: "fileChange" }, glob: { type: "string" } }
              },
              {
                type: "object",
                required: ["type"],
                properties: {
                  type: { const: "startup" },
                  delaySeconds: { type: "integer", minimum: 0, maximum: 3600 }
                }
              },
              {
                type: "object",
                required: ["type", "glob", "severity"],
                properties: {
                  type: { const: "diagnostics" },
                  glob: { type: "string", minLength: 1 },
                  severity: { enum: ["any", "error", "warning", "info", "hint"] },
                  debounceMs: { type: "integer", minimum: 100, maximum: 60000 }
                }
              }
            ]
          },
          context: { type: "string" },
          model: {
            oneOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  vendor: { type: "string", minLength: 1 },
                  family: { type: "string", minLength: 1 },
                  id: { type: "string", minLength: 1 },
                  version: { type: "string", minLength: 1 }
                },
                anyOf: [
                  { required: ["vendor"] },
                  { required: ["family"] },
                  { required: ["id"] },
                  { required: ["version"] }
                ]
              }
            ]
          },
          permissions: { enum: ["ask", "allow", "deny"] },
          position: {
            type: "object",
            required: ["x", "y"],
            properties: { x: { type: "number" }, y: { type: "number" } }
          },
          enabled: { type: "boolean" }
        }
      }
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "from", "to"],
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
          from: { type: "string" },
          to: { type: "string" },
          payloadSchema: { type: ["object", "null"] },
          via: { enum: ["monday", "jira", null] }
        }
      }
    }
  }
} as const;
