import type { TriggerGhPr } from "../../../shared/types.js";

export interface PrSnapshot {
  number: number;
  headRefOid: string;
  state: string;
  title: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  closedAt?: string | null;
  mergedAt?: string | null;
}

export type GhPrEventKind = TriggerGhPr["events"][number];

interface SeenPrSnapshot {
  headRefOid: string;
  state: string;
}

export interface GhPrNodeTriggerState {
  lastPolledAt?: string;
  highestSeenPrNumber?: number;
  seen: Record<string, string | SeenPrSnapshot>;
}

export interface GhPrDetectedEvent {
  pr: PrSnapshot;
  eventKind: GhPrEventKind;
}

export function detectGhPrEvents(
  prs: PrSnapshot[],
  perNode: GhPrNodeTriggerState,
  configuredEvents: readonly GhPrEventKind[],
  branchFilter: RegExp | null = null
): { events: GhPrDetectedEvent[]; nextState: GhPrNodeTriggerState } {
  const seen = normalizeSeen(perNode.seen);
  const highWatermark = perNode.highestSeenPrNumber ?? highestSeenPrNumber(seen);
  const isFirstPoll = !perNode.lastPolledAt && perNode.highestSeenPrNumber === undefined && Object.keys(seen).length === 0;
  const events: GhPrDetectedEvent[] = [];
  let nextHighWatermark = highWatermark;

  for (const pr of [...prs].sort((left, right) => left.number - right.number)) {
    if (branchFilter && !branchFilter.test(pr.headRefName)) continue;
    const previous = seen[String(pr.number)];
    const eventKind = isFirstPoll ? null : inferPrEventKind(pr, previous, highWatermark, configuredEvents);
    if (eventKind && configuredEvents.includes(eventKind)) {
      events.push({ pr, eventKind });
    }

    seen[String(pr.number)] = { headRefOid: pr.headRefOid, state: normalizePrState(pr.state) };
    if (nextHighWatermark === undefined || pr.number > nextHighWatermark) nextHighWatermark = pr.number;
  }

  return {
    events,
    nextState: {
      ...perNode,
      seen,
      highestSeenPrNumber: nextHighWatermark
    }
  };
}

function normalizeSeen(seen: GhPrNodeTriggerState["seen"]): Record<string, SeenPrSnapshot> {
  const normalized: Record<string, SeenPrSnapshot> = {};
  for (const [number, value] of Object.entries(seen)) {
    normalized[number] = typeof value === "string" ? { headRefOid: value, state: "OPEN" } : value;
  }
  return normalized;
}

function inferPrEventKind(
  pr: PrSnapshot,
  previous: SeenPrSnapshot | undefined,
  highWatermark: number | undefined,
  configuredEvents: readonly GhPrEventKind[]
): GhPrEventKind | null {
  const currentState = normalizePrState(pr.state);
  if (!previous) {
    if (highWatermark !== undefined && pr.number <= highWatermark) return null;
    if (closedPrState(currentState) && configuredEvents.includes("closed")) return "closed";
    return "opened";
  }

  const previousState = normalizePrState(previous.state);
  if (!closedPrState(previousState) && closedPrState(currentState)) return "closed";
  if (closedPrState(previousState) && currentState === "OPEN") return "reopened";
  if (currentState === "OPEN" && previous.headRefOid !== pr.headRefOid) return "synchronize";
  return null;
}

function highestSeenPrNumber(seen: Record<string, SeenPrSnapshot>): number | undefined {
  const numbers = Object.keys(seen).map((value) => Number(value)).filter(Number.isFinite);
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

function normalizePrState(state: string): string {
  return state.trim().toUpperCase();
}

function closedPrState(state: string): boolean {
  return state === "CLOSED" || state === "MERGED";
}
