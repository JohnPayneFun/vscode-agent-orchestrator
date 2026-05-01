import { execFile } from "child_process";
import { promisify } from "util";
import type { SourceControlInfo } from "../../shared/types.js";

const exec = promisify(execFile);

export async function detectSourceControl(workspaceRoot: string | undefined): Promise<SourceControlInfo> {
  if (!workspaceRoot) return { error: "No workspace folder open." };
  try {
    const repositoryRoot = await git(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    const [remoteUrl, currentBranch] = await Promise.all([
      git(repositoryRoot, ["remote", "get-url", "origin"]).catch(() => ""),
      git(repositoryRoot, ["branch", "--show-current"]).catch(() => "")
    ]);
    const ownerRepo = parseGitHubOwnerRepo(remoteUrl);
    return {
      repositoryRoot,
      remoteUrl: remoteUrl || undefined,
      ownerRepo: ownerRepo ?? undefined,
      currentBranch: currentBranch || undefined,
      currentBranchFilter: currentBranch ? exactBranchFilter(currentBranch) : undefined
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function parseGitHubOwnerRepo(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  const match =
    trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

export function exactBranchFilter(branch: string): string {
  return `^${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 10000 });
  return stdout.trim();
}
