import React, { useEffect, useRef } from "react";
import type { LedgerEntry } from "../../shared/types.js";

interface Props {
  entries: LedgerEntry[];
}

export function LedgerPanel({ entries }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length]);

  return (
    <div className="ledger-panel" ref={ref}>
      {entries.length === 0 ? (
        <div style={{ opacity: 0.6 }}>Ledger is empty. Run a node or wait for a trigger to fire.</div>
      ) : null}
      {entries.map((e, idx) => (
        <div key={`${e.ts}-${idx}`} className={classFor(e)}>
          <span className="entry">
            <span className="ts">{shortTime(e.ts)}</span>
            <span className="type">{e.type}</span>
            <span>{summary(e)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function classFor(e: LedgerEntry): string {
  if (e.type === "guardrail.tripped" || e.type === "session.errored") return "entry guardrail";
  if (e.type === "session.spawned") return "entry spawn";
  return "entry";
}

function shortTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().slice(11, 23);
}

function summary(e: LedgerEntry): string {
  const parts: string[] = [];
  if (e.node) parts.push(`node=${e.node}`);
  if (e.from) parts.push(`from=${e.from}`);
  if (e.to) parts.push(`to=${e.to}`);
  if (e.detail) parts.push(JSON.stringify(e.detail).slice(0, 120));
  return parts.join(" ");
}
