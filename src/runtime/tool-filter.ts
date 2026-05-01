export interface ToolInfo {
  name: string;
}

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

export function exposedTools<T extends ToolInfo>(
  tools: readonly T[],
  blockedToolNames: readonly string[] = DEFAULT_BLOCKED_TOOL_NAMES
): T[] {
  return tools.filter((tool) => !isBlockedToolName(tool.name, blockedToolNames));
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
