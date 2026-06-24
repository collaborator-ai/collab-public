import { execFileSync } from "node:child_process";
import * as os from "node:os";
import { displayBasename, hostPathToGuestPath, parseWslUncPath } from "@collab/shared/path-utils";
import { type TerminalTarget } from "./config";

export interface TerminalTargetOption {
  id: TerminalTarget;
  label: string;
  isDefault?: boolean;
}

interface AgentTarget {
  command: string;
  args: string[];
  displayName: string;
}

/** CLI agents a terminal can launch directly instead of a shell. */
const AGENT_TARGETS: Record<string, AgentTarget> = {
  claude: {
    command: "claude",
    args: ["--dangerously-skip-permissions"],
    displayName: "Claude Code",
  },
  codex: {
    command: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox"],
    displayName: "Codex",
  },
  opencode: {
    command: "opencode",
    args: [],
    displayName: "opencode",
  },
};

export interface ResolvedTerminalTarget {
  target: TerminalTarget;
  command: string;
  args: string[];
  displayName: string;
  cwd: string;
  cwdHostPath: string;
  cwdGuestPath?: string;
}

function withGuestPath(
  base: Omit<ResolvedTerminalTarget, "cwdGuestPath">,
  cwdGuestPath: string | null,
): ResolvedTerminalTarget {
  return cwdGuestPath
    ? { ...base, cwdGuestPath }
    : base;
}

interface WslDistro {
  name: string;
  isDefault: boolean;
}

function commandExists(command: string): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      [command],
      {
        encoding: "utf8",
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function listWslDistributions(): WslDistro[] {
  if (process.platform !== "win32") return [];
  try {
    const output = execFileSync("wsl.exe", ["-l", "-v"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.replace(/\u0000/g, "").trimEnd())
      .filter((line) => line && !/^windows subsystem/i.test(line))
      .filter((line) => !/^name\s+state\s+version$/i.test(line.trim()))
      .map((line) => {
        const isDefault = line.trimStart().startsWith("*");
        const clean = line.replace(/^\*\s*/, "").trim();
        const [name] = clean.split(/\s{2,}/);
        return name ? { name, isDefault } : null;
      })
      .filter((value): value is WslDistro => value !== null);
  } catch {
    return [];
  }
}

export function getDefaultWslDistro(): string | null {
  const distros = listWslDistributions();
  return distros.find((d) => d.isDefault)?.name
    ?? distros[0]?.name
    ?? null;
}

export function listTerminalTargets(): TerminalTargetOption[] {
  if (process.platform !== "win32") {
    return [
      { id: "auto", label: "Automatic", isDefault: true },
      { id: "shell", label: "Login shell" },
    ];
  }

  const options: TerminalTargetOption[] = [
    { id: "auto", label: "Automatic", isDefault: true },
    { id: "powershell", label: "PowerShell" },
  ];
  for (const distro of listWslDistributions()) {
    options.push({
      id: `wsl:${distro.name}`,
      label: distro.isDefault
        ? `${distro.name} (WSL default)`
        : distro.name,
    });
  }
  return options;
}

function resolveWindowsAutoTarget(
  preferred: TerminalTarget,
  cwdHostPath: string,
): TerminalTarget {
  const unc = parseWslUncPath(cwdHostPath);
  if (unc) {
    return `wsl:${unc.distro}`;
  }
  if (preferred !== "auto") {
    return preferred;
  }
  const defaultDistro = getDefaultWslDistro();
  return defaultDistro ? `wsl:${defaultDistro}` : "powershell";
}

function resolveShellPath(): string {
  if (process.platform === "darwin") {
    return process.env.SHELL || "/bin/zsh";
  }
  return process.env.SHELL || "/bin/bash";
}

function resolvePowerShellCommand(): string {
  return commandExists("pwsh.exe") ? "pwsh.exe" : "powershell.exe";
}

export function resolveTerminalTarget(
  preferredTarget: TerminalTarget,
  cwdHostPath?: string,
): ResolvedTerminalTarget {
  const initialCwd = cwdHostPath || os.homedir();

  const agent = AGENT_TARGETS[preferredTarget];
  if (agent) {
    return {
      target: preferredTarget,
      command: agent.command,
      args: agent.args,
      displayName: agent.displayName,
      cwd: initialCwd,
      cwdHostPath: initialCwd,
    };
  }

  if (process.platform === "win32") {
    const target = resolveWindowsAutoTarget(
      preferredTarget,
      initialCwd,
    );

    if (target === "powershell") {
      const command = resolvePowerShellCommand();
      return {
        target,
        command,
        args: [],
        displayName: "PowerShell",
        cwd: initialCwd,
        cwdHostPath: initialCwd,
      };
    }

    if (target.startsWith("wsl:")) {
      const distro = target.slice(4);
      const guestPath = hostPathToGuestPath(initialCwd, target);
      const args = ["-d", distro];
      if (guestPath) {
        args.push("--cd", guestPath);
      }
      return withGuestPath({
        target,
        command: "wsl.exe",
        args,
        displayName: distro || "WSL",
        cwd: os.homedir(),
        cwdHostPath: initialCwd,
      }, guestPath);
    }

    const command = resolvePowerShellCommand();
    return {
      target: "powershell",
      command,
      args: [],
      displayName: "PowerShell",
      cwd: initialCwd,
      cwdHostPath: initialCwd,
    };
  }

  const shellPath = resolveShellPath();
  return {
    target: "shell",
    command: shellPath,
    args: [],
    displayName: displayBasename(shellPath) || "shell",
    cwd: initialCwd,
    cwdHostPath: initialCwd,
  };
}
