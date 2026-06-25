import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { COLLAB_DIR } from "./paths";
import { atomicWriteFileSync } from "./files";

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export interface AppConfig {
  workspaces: string[];
  expanded_workspaces: string[];
  window_state: WindowState | null;
  ui: Record<string, unknown>;
}

export type TerminalTarget =
  | "auto"
  | "powershell"
  | "shell"
  | "claude"
  | "codex"
  | "opencode"
  | `wsl:${string}`;

const DEFAULT_CONFIG: AppConfig = {
  workspaces: [],
  expanded_workspaces: [],
  window_state: null,
  ui: {},
};

function configPath(): string {
  return join(COLLAB_DIR, "config.json");
}

export function loadConfig(): AppConfig {
  try {
    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ui =
      parsed.ui && typeof parsed.ui === "object"
        ? { ...(parsed.ui as Record<string, unknown>) }
        : {};

    if (!isTerminalTarget(ui.terminalTarget)) {
      ui.terminalTarget = "auto";
    }

    let workspaces: string[];

    if (Array.isArray(parsed.workspaces)) {
      workspaces = (parsed.workspaces as unknown[]).filter(
        (p): p is string => typeof p === "string",
      );
    } else if (
      typeof parsed.workspace_path === "string" &&
      parsed.workspace_path !== ""
    ) {
      workspaces = [parsed.workspace_path];
    } else {
      workspaces = [];
    }

    const expandedWorkspaces = Array.isArray(parsed.expanded_workspaces)
      ? (parsed.expanded_workspaces as unknown[]).filter(
          (p): p is string => typeof p === "string",
        )
      : [];

    return {
      workspaces,
      expanded_workspaces: expandedWorkspaces,
      window_state: (parsed.window_state as WindowState) ?? null,
      ui,
    };
  } catch {
    return {
      ...DEFAULT_CONFIG,
      ui: { terminalTarget: "auto" },
    };
  }
}

export function saveConfig(config: AppConfig): void {
  const filePath = configPath();
  mkdirSync(dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify(config, null, 2));
}

export function getPref(
  config: AppConfig,
  key: string,
): unknown {
  return config.ui[key] ?? null;
}

export function setPref(
  config: AppConfig,
  key: string,
  value: unknown,
): void {
  config.ui[key] = value;
  saveConfig(config);
}

export function isTerminalTarget(value: unknown): value is TerminalTarget {
  return value === "auto"
    || value === "powershell"
    || value === "shell"
    || value === "claude"
    || value === "codex"
    || value === "opencode"
    || (typeof value === "string" && value.startsWith("wsl:"));
}

export function getTerminalTarget(): TerminalTarget {
  const config = loadConfig();
  const target = getPref(config, "terminalTarget");
  return isTerminalTarget(target) ? target : "auto";
}

function getBoolPref(key: string, defaultValue: boolean): boolean {
  const config = loadConfig();
  const pref = getPref(config, key);
  if (pref === true || pref === false) return pref;
  return defaultValue;
}

/**
 * Whether terminal tiles render in-process (xterm.js mounted directly in the
 * shell renderer) instead of one Chromium webview per tile. Defaults on: it
 * removes one Chromium renderer process per terminal, trading per-tile crash
 * isolation for a large memory reduction. Set the `inProcessTerminals` pref to
 * false to fall back to the webview-per-tile path.
 */
export const getInProcessTerminals = (): boolean =>
  getBoolPref("inProcessTerminals", true);
