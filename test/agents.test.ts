import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentFile } from "../src/orchestration/agents.js";

test("custom agent parser reads frontmatter and instructions", () => {
  const parsed = parseAgentFile(`---
name: "Security Reviewer"
description: "Use when reviewing risky code changes"
model: "GPT-5.5 (copilot)"
user-invocable: true
---
You are careful and specific.
`);

  assert.equal(parsed.name, "Security Reviewer");
  assert.equal(parsed.description, "Use when reviewing risky code changes");
  assert.equal(parsed.model, "GPT-5.5 (copilot)");
  assert.equal(parsed.userInvocable, true);
  assert.equal(parsed.instructions, "You are careful and specific.");
});

test("custom agent parser detects hidden agents", () => {
  const parsed = parseAgentFile(`---
description: "Internal-only helper"
user-invocable: false
---
Stay hidden from the picker.
`);

  assert.equal(parsed.userInvocable, false);
});