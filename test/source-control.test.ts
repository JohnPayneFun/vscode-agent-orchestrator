import test from "node:test";
import assert from "node:assert/strict";
import { exactBranchFilter, parseGitHubOwnerRepo } from "../src/orchestration/source-control.js";

test("source control parser reads GitHub owner/repo from common remotes", () => {
  assert.equal(parseGitHubOwnerRepo("https://github.com/JohnPayneFun/vscode-agent-orchestrator.git"), "JohnPayneFun/vscode-agent-orchestrator");
  assert.equal(parseGitHubOwnerRepo("git@github.com:JohnPayneFun/vscode-agent-orchestrator.git"), "JohnPayneFun/vscode-agent-orchestrator");
  assert.equal(parseGitHubOwnerRepo("ssh://git@github.com/JohnPayneFun/vscode-agent-orchestrator.git"), "JohnPayneFun/vscode-agent-orchestrator");
});

test("source control parser ignores non-GitHub remotes", () => {
  assert.equal(parseGitHubOwnerRepo("https://example.com/acme/repo.git"), null);
});

test("source control branch filter escapes regex metacharacters", () => {
  assert.equal(exactBranchFilter("feature/foo.1"), "^feature/foo\\.1$");
  assert.equal(exactBranchFilter("bugfix/(hot)"), "^bugfix/\\(hot\\)$");
});
