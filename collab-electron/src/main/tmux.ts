import { execFileSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { COLLAB_DIR, DEV_WORKTREE_ID } from "./paths";

export interface SessionMeta {
  shell: string;
  cwd: string;
  createdAt: string;
  target?: string;
  displayName?: string;
  command?: string;
  args?: string[];
  claudeSessionId?: string;
  cwdHostPath?: string;
  cwdGuestPath?: string;
  backend?: "tmux" | "sidecar";
}

export const SESSION_DIR = path.join(
  COLLAB_DIR, "terminal-sessions",
);
function getSocketName(): string {
  const app = getApp();
  if (app && !app.isPackaged) {
    return DEV_WORKTREE_ID
      ? `collab-dev-${DEV_WORKTREE_ID}`
      : "collab-dev";
  }
  return "collab";
}

export { getSocketName };

// Electron app module — unavailable in unit tests.
// Lazy-loaded to avoid crashing bun test.
function getApp(): typeof import("electron").app | null {
  try {
    return require("electron").app;
  } catch {
    return null;
  }
}

function packagedResourcePath(...segments: string[]): string | null {
  const app = getApp();
  if (!app?.isPackaged) return null;
  const candidate = path.join(process.resourcesPath, ...segments);
  return fs.existsSync(candidate) ? candidate : null;
}

export function getTmuxBin(): string {
  return packagedResourcePath("tmux") ?? "tmux";
}


export function getTmuxConf(): string {
  const packaged = packagedResourcePath("tmux.conf");
  if (packaged) {
    return packaged;
  }
  // Dev mode: resolve from project root.
  // app.getAppPath() returns project root in electron-vite;
  // fall back to cwd for unit tests.
  const app = getApp();
  const root = app?.getAppPath() ?? process.cwd();
  return path.join(root, "resources", "tmux.conf");
}

export function getTerminfoDir(): string | undefined {
  const packaged = packagedResourcePath("terminfo");
  if (packaged) {
    return packaged;
  }
  return undefined;
}

function baseArgs(): string[] {
  return ["-L", getSocketName(), "-u", "-f", getTmuxConf()];
}

function tmuxEnv(): Record<string, string> | undefined {
  const dir = getTerminfoDir();
  if (!dir) return undefined;
  return { ...process.env, TERMINFO: dir } as Record<string, string>;
}

export function tmuxExec(...args: string[]): string {
  try {
    return execFileSync(
      getTmuxBin(), [...baseArgs(), ...args],
      { encoding: "utf8", timeout: 5000, env: tmuxEnv() },
    ).trim();
  } catch (err: unknown) {
    if (isEnoent(err)) {
      const app = getApp();
      const hint = app?.isPackaged
        ? "tmux is required for legacy session recovery in packaged builds. Install it and ensure it is on your PATH."
        : "tmux is required for dev mode. Install it with: brew install tmux";
      throw new Error(hint);
    }
    throw err;
  }
}

export function tmuxHasSession(name: string): boolean {
  try {
    execFileSync(
      getTmuxBin(),
      [...baseArgs(), "has-session", "-t", name],
      {
        stdio: "ignore",
        timeout: 5000,
        env: tmuxEnv(),
      },
    );
    return true;
  } catch (err: unknown) {
    if (isEnoent(err)) {
      const app = getApp();
      const hint = app?.isPackaged
        ? "tmux is required for legacy session recovery in packaged builds. Install it and ensure it is on your PATH."
        : "tmux is required for dev mode. Install it with: brew install tmux";
      throw new Error(hint);
    }
    return false;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function tmuxExecAsync(
  ...args: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      getTmuxBin(), [...baseArgs(), ...args],
      { encoding: "utf8", timeout: 5000, env: tmuxEnv() },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      },
    );
  });
}

export function tmuxSessionName(sessionId: string): string {
  return `collab-${sessionId}`;
}

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function metaPath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

export function writeSessionMeta(
  sessionId: string,
  meta: SessionMeta,
): void {
  ensureSessionDir();
  fs.writeFileSync(metaPath(sessionId), JSON.stringify(meta));
}

export function readSessionMeta(
  sessionId: string,
): SessionMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(sessionId), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

export function deleteSessionMeta(sessionId: string): void {
  try {
    fs.unlinkSync(metaPath(sessionId));
  } catch {
    // no-op if file doesn't exist
  }
}
