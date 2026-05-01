import test from "node:test";
import assert from "node:assert/strict";
import { exposedTools, isBlockedToolName } from "../src/runtime/tool-filter.js";

test("tool filter blocks Copilot file mutation tools", () => {
  assert.equal(isBlockedToolName("copilot_createFile"), true);
  assert.equal(isBlockedToolName("copilot_editFile"), true);
});

test("tool filter blocks internal planning todo tools", () => {
  assert.equal(isBlockedToolName("manage_todo_list"), true);
  assert.equal(isBlockedToolName("functions.manage_todo_list"), true);
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
