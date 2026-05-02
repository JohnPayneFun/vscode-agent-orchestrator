export interface ToolInfo {
  name: string;
}

export const DEFAULT_MAX_TOOLS_PER_REQUEST = 128;

export const DEFAULT_BLOCKED_TOOL_NAMES = [
  "copilot_createfile",
  "copilot_editfile",
  "copilot_insertedit",
  "copilot_replacestring",
  "copilot_applypatch",
  "manage_todo_list",
  "update_todo_list",
  "todo_write",
  "update_plan",
  "execution_subagent"
] as const;

const PRIORITY_TOOL_PREFIXES = [
  "read_",
  "grep_",
  "file_",
  "semantic_",
  "list_",
  "get_",
  "run_in_terminal",
  "send_to_terminal",
  "terminal_",
  "github_",
  "mcp_com_monday_",
  "mcp_com_github_"
] as const;

export interface ToolSelection<T extends ToolInfo> {
  tools: T[];
  availableCount: number;
  omittedCount: number;
  limit: number;
  capped: boolean;
}

export function exposedTools<T extends ToolInfo>(
  tools: readonly T[],
  blockedToolNames: readonly string[] = DEFAULT_BLOCKED_TOOL_NAMES
): T[] {
  return tools.filter((tool) => !isBlockedToolName(tool.name, blockedToolNames));
}

export function selectExposedTools<T extends ToolInfo>(
  tools: readonly T[],
  blockedToolNames: readonly string[] = DEFAULT_BLOCKED_TOOL_NAMES,
  maxTools: number = DEFAULT_MAX_TOOLS_PER_REQUEST
): ToolSelection<T> {
  const available = exposedTools(tools, blockedToolNames);
  const limit = clampToolLimit(maxTools);
  if (available.length <= limit) {
    return { tools: available, availableCount: available.length, omittedCount: 0, limit, capped: false };
  }

  const prioritized = available
    .map((tool, index) => ({ tool, index, priority: toolPriority(tool.name) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.tool);

  return {
    tools: prioritized,
    availableCount: available.length,
    omittedCount: available.length - prioritized.length,
    limit,
    capped: true
  };
}

export function isBlockedToolName(
  name: string,
  blockedToolNames: readonly string[] = DEFAULT_BLOCKED_TOOL_NAMES
): boolean {
  return new Set(blockedToolNames.map(normalizeToolName)).has(normalizeToolName(name));
}

function normalizeToolName(name: string): string {
  const lowerName = name.toLowerCase();
  return lowerName.includes(".") ? lowerName.slice(lowerName.lastIndexOf(".") + 1) : lowerName;
}

function clampToolLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOOLS_PER_REQUEST;
  return Math.max(1, Math.min(DEFAULT_MAX_TOOLS_PER_REQUEST, Math.floor(value)));
}

function toolPriority(name: string): number {
  const normalized = normalizeToolName(name);
  const prefixIndex = PRIORITY_TOOL_PREFIXES.findIndex((prefix) => normalized.startsWith(prefix));
  return prefixIndex === -1 ? PRIORITY_TOOL_PREFIXES.length : prefixIndex;
}
