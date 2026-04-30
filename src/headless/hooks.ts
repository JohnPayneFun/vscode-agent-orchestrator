import { exec } from "child_process";

interface HookExecError extends Error {
  code?: string | number;
  signal?: string | null;
}

export interface HeadlessHooksConfig {
  beforeRun?: string;
  afterRun?: string;
  timeoutMs?: number;
}

export interface WorkspaceHookResult {
  ok: boolean;
  name: keyof Pick<HeadlessHooksConfig, "beforeRun" | "afterRun">;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode?: number;
  signal?: string;
  error?: string;
}

export async function runWorkspaceHook(args: {
  hooks: HeadlessHooksConfig | null | undefined;
  name: keyof Pick<HeadlessHooksConfig, "beforeRun" | "afterRun">;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WorkspaceHookResult | null> {
  const command = args.hooks?.[args.name]?.trim();
  if (!command) return null;

  return executeHook({
    name: args.name,
    command,
    cwd: args.cwd,
    timeoutMs: args.hooks?.timeoutMs ?? 60000,
    env: args.env
  });
}

function executeHook(args: {
  name: keyof Pick<HeadlessHooksConfig, "beforeRun" | "afterRun">;
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<WorkspaceHookResult> {
  return new Promise((resolve) => {
    exec(
      args.command,
      {
        cwd: args.cwd,
        env: { ...process.env, ...args.env },
        timeout: args.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        const execError = error as HookExecError | null;
        const exitCode = typeof execError?.code === "number" ? execError.code : undefined;
        const signal = typeof execError?.signal === "string" ? execError.signal : undefined;
        resolve({
          ok: !error,
          name: args.name,
          command: args.command,
          cwd: args.cwd,
          stdout,
          stderr,
          exitCode,
          signal,
          error: error ? error.message : undefined
        });
      }
    );
  });
}