import * as fs from "fs";
import * as path from "path";
import type { HandoffPayload, WorkflowNode } from "../../shared/types.js";

const WRITE_FILE_BLOCK_RE = /<<WRITE_FILE\s+path=(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>>([\s\S]*?)<<END_WRITE_FILE>>/g;

export interface FileArtifactResult {
  path: string;
  bytes: number;
  mode: "write" | "append";
  source: "writeBlock" | "markdownFallback";
}

export async function writeNodeFileArtifacts(args: {
  node: WorkflowNode;
  workspaceRoot: string;
  assistantText: string;
  drained: HandoffPayload[];
}): Promise<FileArtifactResult[]> {
  const writeBlocks = parseWriteFileBlocks(args.assistantText);
  if (writeBlocks.length > 0) {
    const results: FileArtifactResult[] = [];
    for (const block of writeBlocks) {
      const targetPath = resolveTargetPath(block.path, args.workspaceRoot);
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, block.content, "utf8");
      results.push({ path: targetPath, bytes: Buffer.byteLength(block.content, "utf8"), mode: "write", source: "writeBlock" });
    }
    return results;
  }

  if (!shouldWriteMarkdownFallback(args.node, args.drained)) return [];

  const targetPath = resolveMarkdownFallbackPath(args.node, args.workspaceRoot);
  const entry = buildMarkdownFallbackEntry(args.node, args.drained);
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const exists = fs.existsSync(targetPath);
  const content = `${exists ? "\n\n---\n\n" : `# ${args.node.label} Handoff Log\n\n`}${entry}`;
  await fs.promises.appendFile(targetPath, content, "utf8");
  return [{ path: targetPath, bytes: Buffer.byteLength(content, "utf8"), mode: "append", source: "markdownFallback" }];
}

export function parseWriteFileBlocks(text: string): Array<{ path: string; content: string }> {
  const blocks: Array<{ path: string; content: string }> = [];
  WRITE_FILE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WRITE_FILE_BLOCK_RE.exec(text)) !== null) {
    const requestedPath = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!requestedPath) continue;
    blocks.push({ path: requestedPath, content: stripOuterFence(match[4].trim()) });
  }
  return blocks;
}

function shouldWriteMarkdownFallback(node: WorkflowNode, drained: HandoffPayload[]): boolean {
  if (drained.length === 0) return false;
  const context = node.context.toLocaleLowerCase();
  return /\b(document|save|write|create)\b/.test(context) && (/\.md\b/.test(context) || /markdown/.test(context));
}

function resolveMarkdownFallbackPath(node: WorkflowNode, workspaceRoot: string): string {
  const target = extractSaveTarget(node.context);
  if (!target) return path.join(workspaceRoot, `${slug(node.label)}-handoff-log.md`);

  const resolved = resolveTargetPath(target, workspaceRoot);
  if (path.extname(resolved).toLocaleLowerCase() === ".md") return resolved;
  return path.join(resolved, `${slug(node.label)}-handoff-log.md`);
}

function extractSaveTarget(context: string): string | null {
  const matches = Array.from(context.matchAll(/\bto\s+(.+?)(?=(?:[.;]\s+\b(?:save|write|create)\b)|$)/gim));
  if (matches.length === 0) return null;
  const target = cleanTarget(matches[matches.length - 1][1]);
  return isGenericTarget(target) ? null : target;
}

function isGenericTarget(value: string): boolean {
  return /^(?:a|an|the)\s+/.test(value.toLocaleLowerCase()) || value.toLocaleLowerCase() === "markdown";
}

function cleanTarget(value: string): string {
  return value
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^["']|["']$/g, "")
    .replace(/[.;,]+$/g, "")
    .trim();
}

function resolveTargetPath(requestedPath: string, workspaceRoot: string): string {
  const cleaned = cleanTarget(requestedPath);
  return path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(workspaceRoot, cleaned);
}

function buildMarkdownFallbackEntry(node: WorkflowNode, drained: HandoffPayload[]): string {
  const lines: string[] = [];
  lines.push(`## Entry: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`### Received By`);
  lines.push(`- Node ID: \`${node.id}\``);
  lines.push(`- Label: \`${node.label}\``);
  lines.push("");
  for (const handoff of drained) {
    lines.push(`### Handoff ${handoff.id}`);
    lines.push(`- From: \`${handoff.from}\``);
    lines.push(`- To: \`${handoff.to}\``);
    if (handoff.edgeId) lines.push(`- Edge ID: \`${handoff.edgeId}\``);
    lines.push(`- Trace root ID: \`${handoff.trace.rootId}\``);
    lines.push(`- Trace depth: \`${handoff.trace.depth}\``);
    lines.push("");
    lines.push("#### Payload");
    lines.push(formatPayload(handoff.payload));
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function formatPayload(payload: Record<string, unknown>): string {
  const response = payload.response;
  if (typeof response === "string" && response.trim()) return response.trim();
  return ["```json", JSON.stringify(payload, null, 2), "```"].join("\n");
}

function stripOuterFence(value: string): string {
  return value.replace(/^```(?:\w+)?\s*/i, "").replace(/```$/i, "").trimEnd() + "\n";
}

function slug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node";
}