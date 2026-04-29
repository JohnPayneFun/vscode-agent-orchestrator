import * as fs from "fs";
import * as path from "path";
import lockfile from "proper-lockfile";
import type { LedgerEntry } from "../../shared/types.js";

export class Ledger {
  private listeners: Array<(e: LedgerEntry) => void> = [];

  constructor(private readonly file: string) {}

  onAppend(listener: (e: LedgerEntry) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async append(partial: Omit<LedgerEntry, "ts"> & { ts?: string }): Promise<void> {
    // Cast: TS narrows the spread of `Omit<X,K> & {...}` and loses the discriminant.
    // The runtime shape is verified by the `partial` parameter type at the call site.
    const entry = { ...partial, ts: partial.ts ?? new Date().toISOString() } as LedgerEntry;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) {
      await fs.promises.writeFile(this.file, "");
    }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.file, { retries: { retries: 5, minTimeout: 20, maxTimeout: 200 } });
      await fs.promises.appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
    } finally {
      if (release) await release();
    }
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        // Listener errors shouldn't block the writer
      }
    }
  }

  async tail(maxLines = 500): Promise<LedgerEntry[]> {
    if (!fs.existsSync(this.file)) return [];
    const raw = await fs.promises.readFile(this.file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines
      .slice(Math.max(0, lines.length - maxLines))
      .map((l) => {
        try {
          return JSON.parse(l) as LedgerEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is LedgerEntry => e !== null);
  }

  async countToday(type: string): Promise<number> {
    const day = new Date().toISOString().slice(0, 10);
    const entries = await this.tail(100000);
    return entries.filter((e) => e.type === type && e.ts.startsWith(day)).length;
  }
}
