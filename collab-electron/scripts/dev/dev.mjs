import { spawn } from "node:child_process";
import { join } from "node:path";

function normalizeWindowsPath(path) {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

const repoDir = normalizeWindowsPath(process.cwd());

const child = process.platform === "win32"
  ? spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repoDir, "scripts", "dev", "dev.ps1"),
      ],
      {
        stdio: "inherit",
        cwd: repoDir,
        env: {
          ...process.env,
          COLLAB_DEV_WORKTREE_ROOT: repoDir,
        },
      },
    )
  : spawn(process.execPath, ["x", "electron-vite", "dev"], {
      stdio: "inherit",
      cwd: repoDir,
      env: {
        ...process.env,
        COLLAB_DEV_WORKTREE_ROOT: repoDir,
      },
    });

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", forwardSignal);
process.on("SIGTERM", forwardSignal);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
