const USAGE_LIMIT_RE = /(usage limit|rate limit|quota|too many requests|try again)/i;
const TRY_AGAIN_RE = /try again in\s*(?:~|about|approximately)?\s*(\d+(?:\.\d+)?)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs)\b/i;
const ONE_MINUTE_MS = 60_000;

export interface UsageLimitRetry {
  waitMs: number;
  retryDelayMs: number;
  retryAt: string;
  matchedText: string;
}

export function parseUsageLimitRetry(message: string, now = new Date()): UsageLimitRetry | null {
  if (!USAGE_LIMIT_RE.test(message)) return null;
  const match = message.match(TRY_AGAIN_RE);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const waitMs = Math.ceil(amount * unitToMs(match[2] ?? "minutes"));
  const retryDelayMs = Math.max(ONE_MINUTE_MS, waitMs + ONE_MINUTE_MS);
  return {
    waitMs,
    retryDelayMs,
    retryAt: new Date(now.getTime() + retryDelayMs).toISOString(),
    matchedText: match[0]
  };
}

function unitToMs(unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized.startsWith("sec")) return 1_000;
  if (normalized.startsWith("hour") || normalized === "hr" || normalized === "hrs") return 60 * ONE_MINUTE_MS;
  return ONE_MINUTE_MS;
}
