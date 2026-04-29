import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface AgentInfo {
  id: string; // basename without .md
  label: string; // first heading or front-matter "name:" if findable, else id
  path: string;
  source: "user" | "project";
}

export async function listAgents(workspaceRoot?: string): Promise<AgentInfo[]> {
  const out: AgentInfo[] = [];
  const userDir = path.join(os.homedir(), ".claude", "agents");
  await collect(userDir, "user", out);
  if (workspaceRoot) {
    const projectDir = path.join(workspaceRoot, ".claude", "agents");
    await collect(projectDir, "project", out);
  }
  // De-duplicate: project overrides user when ids collide
  const byId = new Map<string, AgentInfo>();
  for (const a of out) {
    const existing = byId.get(a.id);
    if (!existing || a.source === "project") byId.set(a.id, a);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

async function collect(dir: string, source: "user" | "project", out: AgentInfo[]): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const files = await fs.promises.readdir(dir);
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const id = f.slice(0, -3);
    const full = path.join(dir, f);
    let label = id;
    try {
      const head = (await fs.promises.readFile(full, "utf8")).slice(0, 800);
      const fmName = head.match(/^name:\s*(.+)$/m);
      if (fmName) label = fmName[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      // ignore
    }
    out.push({ id, label, path: full, source });
  }
}
