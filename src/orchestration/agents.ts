import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentOption } from "../../shared/types.js";

export interface AgentInfo extends AgentOption {
  instructions: string;
}

export async function listAgents(workspaceRoot?: string): Promise<AgentInfo[]> {
  const out: AgentInfo[] = [];
  for (const userDir of userAgentDirs()) {
    await collect(userDir, "user", out);
  }
  if (workspaceRoot) {
    await collect(path.join(workspaceRoot, ".github", "agents"), "workspace", out);
  }
  // De-duplicate: workspace overrides user when ids collide.
  const byId = new Map<string, AgentInfo>();
  for (const a of out) {
    const existing = byId.get(a.id);
    if (!existing || a.source === "workspace") byId.set(a.id, a);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getAgent(workspaceRoot: string | undefined, id: string): Promise<AgentInfo | null> {
  const agents = await listAgents(workspaceRoot);
  return agents.find((agent) => agent.id === id) ?? null;
}

function userAgentDirs(): string[] {
  const dirs = new Set<string>();
  if (process.env.VSCODE_USER_PROMPTS_FOLDER) {
    dirs.add(process.env.VSCODE_USER_PROMPTS_FOLDER);
  }
  if (process.env.APPDATA) {
    dirs.add(path.join(process.env.APPDATA, "Code", "User", "prompts"));
    dirs.add(path.join(process.env.APPDATA, "Code - Insiders", "User", "prompts"));
  }
  if (process.platform === "darwin") {
    dirs.add(path.join(os.homedir(), "Library", "Application Support", "Code", "User", "prompts"));
    dirs.add(path.join(os.homedir(), "Library", "Application Support", "Code - Insiders", "User", "prompts"));
  }
  if (process.platform === "linux") {
    dirs.add(path.join(os.homedir(), ".config", "Code", "User", "prompts"));
    dirs.add(path.join(os.homedir(), ".config", "Code - Insiders", "User", "prompts"));
  }
  return Array.from(dirs);
}

async function collect(dir: string, source: "user" | "workspace", out: AgentInfo[]): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = await fs.promises.readdir(dir);
  for (const f of files) {
    if (!f.endsWith(".agent.md")) continue;
    const id = f.slice(0, -".agent.md".length);
    const full = path.join(dir, f);
    try {
      const parsed = parseAgentFile(await fs.promises.readFile(full, "utf8"));
      if (parsed.userInvocable === false) continue;
      out.push({
        id,
        label: parsed.name ?? id,
        description: parsed.description,
        defaultModel: parsed.model,
        instructions: parsed.instructions,
        path: full,
        source
      });
    } catch {
      // ignore
    }
  }
}

export function parseAgentFile(raw: string): {
  name?: string;
  description?: string;
  model?: string;
  userInvocable?: boolean;
  instructions: string;
} {
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  const frontmatter = match?.[1] ?? "";
  const instructions = match ? raw.slice(match[0].length).trim() : raw.trim();
  return {
    name: frontmatterValue(frontmatter, "name"),
    description: frontmatterValue(frontmatter, "description"),
    model: frontmatterValue(frontmatter, "model"),
    userInvocable: frontmatterBoolean(frontmatter, "user-invocable"),
    instructions
  };
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function frontmatterBoolean(frontmatter: string, key: string): boolean | undefined {
  const value = frontmatterValue(frontmatter, key)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
