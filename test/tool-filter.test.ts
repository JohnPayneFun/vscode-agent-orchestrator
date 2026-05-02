import test from "node:test";
import assert from "node:assert/strict";
import { exposedTools, isBlockedToolName, resolveBackgroundBlockedTools, selectExposedTools } from "../src/runtime/tool-filter.js";

test("tool filter blocks Copilot file mutation tools", () => {
  assert.equal(isBlockedToolName("copilot_createFile"), true);
  assert.equal(isBlockedToolName("copilot_editFile"), true);
});

test("tool filter blocks internal planning todo tools", () => {
  assert.equal(isBlockedToolName("manage_todo_list"), true);
  assert.equal(isBlockedToolName("functions.manage_todo_list"), true);
});

test("tool filter blocks native subagent execution in participant runs", () => {
  assert.equal(isBlockedToolName("execution_subagent"), true);
  assert.equal(isBlockedToolName("functions.execution_subagent"), true);
});

test("tool filter can expose every native tool when blocklist is empty", () => {
  assert.equal(isBlockedToolName("manage_todo_list", []), false);
  assert.equal(isBlockedToolName("copilot_createFile", []), false);
});

test("tool filter keeps MCP and workspace read/search tools", () => {
  const tools = exposedTools([
    { name: "manage_todo_list" },
    { name: "mcp_com_monday_mo_get_board_items_page" },
    { name: "read_file" },
    { name: "grep_search" }
  ]);

  assert.deepEqual(tools.map((tool) => tool.name), [
    "mcp_com_monday_mo_get_board_items_page",
    "read_file",
    "grep_search"
  ]);
});

test("tool filter accepts a custom blocklist", () => {
  const tools = exposedTools([
    { name: "manage_todo_list" },
    { name: "read_file" }
  ], ["read_file"]);

  assert.deepEqual(tools.map((tool) => tool.name), ["manage_todo_list"]);
});

test("tool filter accepts wildcard block patterns", () => {
  assert.equal(isBlockedToolName("mcp_com_monday_mo_update_doc", ["mcp_com_monday_mo_update*"]), true);
  assert.equal(isBlockedToolName("mcp_com_monday_mo_change_column_value", ["mcp_com_monday_mo_*change*"]), true);
  assert.equal(isBlockedToolName("mcp_com_monday_mo_get_assets", ["mcp_com_monday_mo_update*"]), false);
});

test("background safe mode blocks confirmation-heavy tools", () => {
  const blocked = resolveBackgroundBlockedTools("safe");
  assert.equal(isBlockedToolName("run_in_terminal", blocked), true);
  assert.equal(isBlockedToolName("mcp_com_monday_mo_create_update", blocked), true);
  assert.equal(isBlockedToolName("mcp_com_monday_mo_get_assets", blocked), false);
  assert.deepEqual(resolveBackgroundBlockedTools("all"), []);
});

test("tool filter caps advertised tools before model requests", () => {
  const tools = Array.from({ length: 140 }, (_, index) => ({ name: `tool_${index}` }));
  const selection = selectExposedTools(tools);

  assert.equal(selection.tools.length, 128);
  assert.equal(selection.availableCount, 140);
  assert.equal(selection.omittedCount, 12);
  assert.equal(selection.capped, true);
});

test("tool filter prioritizes workspace and Monday tools when capped", () => {
  const tools = [
    { name: "misc_0" },
    { name: "misc_1" },
    { name: "mcp_com_monday_mo_search" },
    { name: "read_file" },
    { name: "grep_search" }
  ];
  const selection = selectExposedTools(tools, [], 3);

  assert.deepEqual(selection.tools.map((tool) => tool.name), ["mcp_com_monday_mo_search", "read_file", "grep_search"]);
});
