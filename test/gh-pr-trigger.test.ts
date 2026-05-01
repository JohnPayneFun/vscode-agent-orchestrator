import test from "node:test";
import assert from "node:assert/strict";
import { detectGhPrEvents, type GhPrNodeTriggerState, type PrSnapshot } from "../src/runtime/triggers/gh-pr-events.js";

function pr(number: number, state = "OPEN", headRefOid = `sha-${number}`): PrSnapshot {
  return {
    number,
    state,
    headRefOid,
    title: `PR ${number}`,
    url: `https://github.com/example/repo/pull/${number}`,
    baseRefName: "master",
    headRefName: `branch-${number}`,
    closedAt: state === "CLOSED" || state === "MERGED" ? "2026-05-01T00:00:00.000Z" : null,
    mergedAt: state === "MERGED" ? "2026-05-01T00:00:00.000Z" : null
  };
}

test("GitHub PR polling baselines on first poll and fires for newer PR numbers", () => {
  const first = detectGhPrEvents([pr(206)], { seen: {} }, ["opened"]);
  assert.deepEqual(first.events, []);
  assert.equal(first.nextState.highestSeenPrNumber, 206);

  const second = detectGhPrEvents([pr(206), pr(207)], first.nextState, ["opened"]);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].pr.number, 207);
  assert.equal(second.events[0].eventKind, "opened");
});

test("GitHub PR polling can fire closed for fast merged PRs", () => {
  const state: GhPrNodeTriggerState = {
    lastPolledAt: "2026-05-01T00:00:00.000Z",
    highestSeenPrNumber: 206,
    seen: { "206": { headRefOid: "sha-206", state: "OPEN" } }
  };

  const result = detectGhPrEvents([pr(207, "MERGED")], state, ["closed"]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].pr.number, 207);
  assert.equal(result.events[0].eventKind, "closed");
});

test("GitHub PR polling treats fast merged PRs as opened when closed is not selected", () => {
  const state: GhPrNodeTriggerState = {
    lastPolledAt: "2026-05-01T00:00:00.000Z",
    highestSeenPrNumber: 206,
    seen: { "206": { headRefOid: "sha-206", state: "OPEN" } }
  };

  const result = detectGhPrEvents([pr(207, "MERGED")], state, ["opened"]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].pr.number, 207);
  assert.equal(result.events[0].eventKind, "opened");
});

test("GitHub PR polling detects update, close, and reopen transitions", () => {
  const state: GhPrNodeTriggerState = {
    lastPolledAt: "2026-05-01T00:00:00.000Z",
    highestSeenPrNumber: 206,
    seen: { "206": { headRefOid: "old-sha", state: "OPEN" } }
  };

  const updated = detectGhPrEvents([pr(206, "OPEN", "new-sha")], state, ["synchronize"]);
  assert.equal(updated.events[0].eventKind, "synchronize");

  const closed = detectGhPrEvents([pr(206, "CLOSED", "new-sha")], updated.nextState, ["closed"]);
  assert.equal(closed.events[0].eventKind, "closed");

  const reopened = detectGhPrEvents([pr(206, "OPEN", "newer-sha")], closed.nextState, ["reopened"]);
  assert.equal(reopened.events[0].eventKind, "reopened");
});

test("GitHub PR polling ignores older historical PRs below the high watermark", () => {
  const state: GhPrNodeTriggerState = {
    lastPolledAt: "2026-05-01T00:00:00.000Z",
    highestSeenPrNumber: 206,
    seen: { "206": { headRefOid: "sha-206", state: "OPEN" } }
  };

  const result = detectGhPrEvents([pr(205)], state, ["opened"]);
  assert.deepEqual(result.events, []);
  assert.equal(result.nextState.highestSeenPrNumber, 206);
});
