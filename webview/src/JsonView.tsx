import React, { useEffect, useRef, useState } from "react";
import type { Workflow } from "../../shared/types.js";

interface Props {
  workflow: Workflow;
  onChange: (next: Workflow) => void;
}

export function JsonView({ workflow, onChange }: Props): JSX.Element {
  const [text, setText] = useState(() => JSON.stringify(workflow, null, 2));
  const [error, setError] = useState<string | null>(null);
  const lastExternalRef = useRef(workflow);

  // When the workflow changes externally (e.g. user used the graph view), reset text.
  useEffect(() => {
    if (lastExternalRef.current !== workflow) {
      lastExternalRef.current = workflow;
      setText(JSON.stringify(workflow, null, 2));
      setError(null);
    }
  }, [workflow]);

  const handleChange = (value: string): void => {
    setText(value);
    try {
      const parsed = JSON.parse(value);
      setError(null);
      lastExternalRef.current = parsed;
      onChange(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="json-view">
      <textarea spellCheck={false} value={text} onChange={(e) => handleChange(e.target.value)} />
      <div className={`validation-bar ${error ? "error" : "ok"}`}>
        {error ? `JSON error: ${error}` : "Valid JSON. Saving will run schema validation."}
      </div>
    </div>
  );
}
