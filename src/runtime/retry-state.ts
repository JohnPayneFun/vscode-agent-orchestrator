import * as fs from "fs";
import * as path from "path";
import { ulid } from "ulid";
import type { HandoffPayload } from "../../shared/types.js";
import type { OrchestrationPaths } from "../orchestration/paths.js";

export type RetryKind = "usageLimit" | "toolRoundLimit";

export interface RetryState {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  retryKind?: RetryKind;
  retryAt: string;
  nodeId: string;
  triggerType: string;
  userText: string;
  drainedHandoffs: HandoffPayload[];
  reason: string;
}

export async function saveRetryState(
  p: OrchestrationPaths,
  state: Omit<RetryState, "schemaVersion" | "id" | "createdAt">
): Promise<RetryState> {
  const retryState: RetryState = {
    schemaVersion: 1,
    id: ulid(),
    createdAt: new Date().toISOString(),
    ...state
  };
  await fs.promises.mkdir(p.retriesRoot, { recursive: true });
  await fs.promises.writeFile(retryStatePath(p, retryState.id), JSON.stringify(retryState, null, 2), "utf8");
  return retryState;
}

export async function takeRetryState(p: OrchestrationPaths, id: string): Promise<RetryState | null> {
  const fullPath = retryStatePath(p, id);
  try {
    const raw = await fs.promises.readFile(fullPath, "utf8");
    await fs.promises.unlink(fullPath).catch(() => undefined);
    return JSON.parse(raw) as RetryState;
  } catch {
    return null;
  }
}

export async function takeLatestRetryStateForNode(
  p: OrchestrationPaths,
  nodeId: string,
  retryKind?: RetryKind
): Promise<RetryState | null> {
  const states = await listRetryStates(p);
  const match = states
    .filter((state) => state.nodeId === nodeId && (!retryKind || state.retryKind === retryKind))
    .sort((left, right) => {
      const createdDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return createdDelta !== 0 ? createdDelta : right.id.localeCompare(left.id);
    })[0];
  return match ? takeRetryState(p, match.id) : null;
}

export async function listRetryStates(p: OrchestrationPaths): Promise<RetryState[]> {
  try {
    const files = (await fs.promises.readdir(p.retriesRoot)).filter((file) => file.endsWith(".json")).sort();
    const states: RetryState[] = [];
    for (const file of files) {
      try {
        const raw = await fs.promises.readFile(path.join(p.retriesRoot, file), "utf8");
        states.push(JSON.parse(raw) as RetryState);
      } catch {
        // Ignore malformed retry files; users can delete them manually.
      }
    }
    return states;
  } catch {
    return [];
  }
}

function retryStatePath(p: OrchestrationPaths, id: string): string {
  return path.join(p.retriesRoot, `${id}.json`);
}
