import type { WebviewToExt, ExtToWebview } from "../../shared/types.js";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  setState(state: unknown): void;
  getState(): unknown;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
  }
}

let api: VsCodeApi | null = null;

export function getVsCode(): VsCodeApi {
  if (!api) {
    if (!window.acquireVsCodeApi) {
      throw new Error("acquireVsCodeApi not available — running outside VS Code webview?");
    }
    api = window.acquireVsCodeApi();
  }
  return api;
}

export function send(msg: WebviewToExt): void {
  getVsCode().postMessage(msg);
}

type Listener = (msg: ExtToWebview) => void;
const listeners = new Set<Listener>();

window.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as ExtToWebview;
  if (!data || typeof (data as { type?: unknown }).type !== "string") return;
  for (const l of listeners) l(data);
});

export function onMessage(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
