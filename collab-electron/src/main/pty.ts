import * as pty from "node-pty";
import * as os from "os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as crypto from "crypto";
import { type IDisposable } from "node-pty";
import { displayBasename } from "@collab/shared/path-utils";
import {
  getTmuxBin,
  getTerminfoDir,
  getSocketName,
  tmuxExec,
  tmuxHasSession,
  tmuxSessionName,
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
  type SessionMeta,
} from "./tmux";
import { cleanupEndpoint } from "./ipc-endpoint";
import {
  getTerminalMode,
  getTerminalTarget,
  type TerminalMode,
  type TerminalTarget,
} from "./config";
import { SidecarClient } from "./sidecar/client";
import {
  SIDECAR_SOCKET_PATH,
  SIDECAR_PID_PATH,
} from "./sidecar/protocol";
import { COLLAB_DIR } from "./paths";
import { resolveTerminalTarget } from "./terminal-target";
import { nearestExistingDir } from "./cwd-fallback";

interface PtySession {
  pty: pty.IPty;
  shell: string;
  displayName: string;
  disposables: IDisposable[];
}

const sessions = new Map<string, PtySession>();
let shuttingDown = false;

let sidecarClient: SidecarClient | null = null;

/** Map of sessionId -> data socket for sidecar sessions. */
const dataSockets = new Map<string, net.Socket>();

/**
 * Track which sessions are sidecar-managed. Sidecar sessions never
 * touch the `sessions` Map (which holds IPty objects).
 */
const sidecarSessionIds = new Set<string>();
const sidecarPowerShellSessionIds = new Set<string>();
const pendingPtyData = new Map<string, Buffer[]>();
const pendingPtyDataTimers = new Map<
  string,
  ReturnType<typeof setTimeout>
>();
const WINDOWS_POWERSHELL_PTY_BATCH_MS = 16;

function getSidecarClient(): SidecarClient {
  if (!sidecarClient) throw new Error("Sidecar client not initialized");
  return sidecarClient;
}

/**
 * Determine which backend owns an existing session.
 * Checks in-memory tracking first, then falls back to persisted metadata.
 */
function sessionBackend(sessionId: string): TerminalMode {
  if (sidecarSessionIds.has(sessionId)) return "sidecar";
  if (dataSockets.has(sessionId)) return "sidecar";
  if (sessions.has(sessionId)) return "tmux";
  const meta = readSessionMeta(sessionId);
  return meta?.backend ?? "tmux";
}

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

function getWebContents(): typeof import("electron").webContents | null {
  try {
    return require("electron").webContents;
  } catch {
    return null;
  }
}

function sendToSender(
  senderWebContentsId: number | undefined,
  channel: string,
  payload: unknown,
): void {
  if (senderWebContentsId == null) return;
  const wc = getWebContents();
  if (!wc) return;
  const sender = wc.fromId(senderWebContentsId);
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

function notifyCwdFallback(
  sessionId: string,
  senderWebContentsId: number | undefined,
  requestedCwd: string,
  actualCwd: string,
): void {
  if (path.resolve(requestedCwd) === actualCwd) return;
  const notice =
    `\r\n\x1b[33m⚠ directory not found: ${requestedCwd}\r\n`
    + `  opened in ${actualCwd} instead\x1b[0m\r\n`;
  sendToSender(senderWebContentsId, "pty:data", {
    sessionId,
    data: Buffer.from(notice, "utf8"),
  });
}

function shouldBatchWindowsPowerShellOutput(sessionId: string): boolean {
  return (
    process.platform === "win32"
    && sidecarPowerShellSessionIds.has(sessionId)
  );
}

function clearPendingPtyData(sessionId: string): void {
  const timer = pendingPtyDataTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingPtyDataTimers.delete(sessionId);
  }
  pendingPtyData.delete(sessionId);
}

function flushPendingPtyData(
  sessionId: string,
  senderWebContentsId: number | undefined,
): void {
  pendingPtyDataTimers.delete(sessionId);
  const chunks = pendingPtyData.get(sessionId);
  if (!chunks || chunks.length === 0) return;
  pendingPtyData.delete(sessionId);

  const data = chunks.length === 1
    ? chunks[0]
    : Buffer.concat(chunks);
  sendToSender(senderWebContentsId, "pty:data", {
    sessionId,
    data,
  });
  scheduleForegroundCheck(sessionId);
}

function forwardPtyData(
  sessionId: string,
  senderWebContentsId: number | undefined,
  data: Buffer,
): void {
  if (!shouldBatchWindowsPowerShellOutput(sessionId)) {
    sendToSender(senderWebContentsId, "pty:data", {
      sessionId,
      data,
    });
    scheduleForegroundCheck(sessionId);
    return;
  }

  const queued = pendingPtyData.get(sessionId) ?? [];
  queued.push(data);
  pendingPtyData.set(sessionId, queued);
  if (!pendingPtyDataTimers.has(sessionId)) {
    pendingPtyDataTimers.set(
      sessionId,
      setTimeout(
        () => flushPendingPtyData(sessionId, senderWebContentsId),
        WINDOWS_POWERSHELL_PTY_BATCH_MS,
      ),
    );
  }
}

function utf8Env(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (!env.LANG || !env.LANG.includes("UTF-8")) {
    env.LANG = "en_US.UTF-8";
  }
  // xterm.js supports 24-bit color; ensure spawned shells know this
  // so CLI tools (e.g. Claude Code) render with full true color
  // instead of falling back to 256-color palettes.
  env.COLORTERM = "truecolor";
  // supports-color (used by chalk/Ink) checks FORCE_COLOR before all
  // other heuristics.  Without this, env vars inherited from the
  // developer's shell (CI, TERM_PROGRAM, etc.) can cause
  // supports-color to short-circuit and return a lower color level
  // before it ever reaches the COLORTERM check.
  env.FORCE_COLOR = "3";
  const terminfoDir = getTerminfoDir();
  if (terminfoDir) {
    env.TERMINFO = terminfoDir;
  }
  return env;
}

function withOptionalFields<T extends object>(
  base: T,
  fields: Record<string, unknown>,
): T {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      Object.assign(base, { [key]: value });
    }
  }
  return base;
}

let sidecarStarting: Promise<void> | null = null;

export async function ensureSidecar(): Promise<void> {
  if (sidecarClient) {
    try {
      await sidecarClient.ping();
      return;
    } catch {
      sidecarClient.disconnect();
      sidecarClient = null;
    }
  }

  if (sidecarStarting) return sidecarStarting;
  sidecarStarting = doEnsureSidecar().finally(() => {
    sidecarStarting = null;
  });
  return sidecarStarting;
}

async function doEnsureSidecar(): Promise<void> {
  let needsSpawn = false;
  try {
    fs.readFileSync(SIDECAR_PID_PATH, "utf-8");
    const client = new SidecarClient(SIDECAR_SOCKET_PATH);
    await client.connect();
    await client.ping();
    sidecarClient = client;
  } catch {
    needsSpawn = true;
  }

  if (needsSpawn) {
    await spawnSidecar();
  }

  if (sidecarClient) {
    sidecarClient.onNotification((method, params) => {
      if (method === "session.exited") {
        const { sessionId, exitCode } = params as {
          sessionId: string;
          exitCode: number;
        };
        console.log(
          `[pty] session.exited sessionId=${sessionId} exitCode=${exitCode}`,
        );
        clearPendingPtyData(sessionId);
        dataSockets.get(sessionId)?.destroy();
        dataSockets.delete(sessionId);
        sidecarPowerShellSessionIds.delete(sessionId);
        deleteSessionMeta(sessionId);
        sendToMainWindow("pty:exit", { sessionId, exitCode });
      }
    });
  }
}

function fixSpawnHelperPerms(): void {
  if (process.platform === "win32") return;
  try {
    const ptyDir = path.dirname(require.resolve("node-pty"));
    const helper = path.join(ptyDir, "..", "build", "Release", "spawn-helper");
    const stat = fs.statSync(helper);
    if (!(stat.mode & 0o111)) {
      fs.chmodSync(helper, 0o755);
    }
  } catch {
    // Best effort — packaged builds bundle the binary with correct perms.
  }
}

async function spawnSidecar(): Promise<void> {
  fixSpawnHelperPerms();
  cleanupEndpoint(SIDECAR_SOCKET_PATH);
  try { fs.unlinkSync(SIDECAR_PID_PATH); } catch {}

  const token = crypto.randomBytes(16).toString("hex");

  let app: typeof import("electron").app | undefined;
  try { app = require("electron").app; } catch {}
  if (!app) throw new Error("Cannot spawn sidecar outside Electron");

  const sidecarPath = app.isPackaged
    ? path.join(
        process.resourcesPath,
        "app.asar",
        "out",
        "main",
        "pty-sidecar.js",
      )
    : path.join(__dirname, "pty-sidecar.js");

  const child = require("node:child_process").spawn(
    process.execPath,
    [sidecarPath, "--token", token],
    {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        COLLAB_SIDECAR_LOG_DIR: path.join(COLLAB_DIR, "logs"),
      },
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[sidecar] ${chunk.toString().trimEnd()}`);
  });
  child.on("exit", (code: number | null) => {
    if (code !== 0 && code !== null) {
      console.error(`Sidecar exited with code ${code}`);
    }
  });
  child.unref();

  const maxWait = 5000;
  const interval = 100;
  let waited = 0;
  while (waited < maxWait) {
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
    try {
      const client = new SidecarClient(SIDECAR_SOCKET_PATH);
      await client.connect();
      const ping = await client.ping();
      if (ping.token === token) {
        sidecarClient = client;
        return;
      }
      client.disconnect();
    } catch {
      // Not ready yet
    }
  }
  throw new Error("Sidecar failed to start within timeout");
}

function attachClient(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId?: number,
): pty.IPty {
  const tmuxBin = getTmuxBin();
  const name = tmuxSessionName(sessionId);

  const ptyProcess = pty.spawn(
    tmuxBin,
    ["-L", getSocketName(), "-u", "attach-session", "-t", name],
    { name: "xterm-256color", cols, rows, env: utf8Env() },
  );

  const disposables: IDisposable[] = [];

  disposables.push(
    ptyProcess.onData((data: string) => {
      sendToSender(
        senderWebContentsId,
        "pty:data",
        { sessionId, data },
      );
      scheduleForegroundCheck(sessionId);
    }),
  );

  disposables.push(
    ptyProcess.onExit(() => {
      if (shuttingDown) {
        sessions.delete(sessionId);
        return;
      }
      if (!tmuxHasSession(name)) {
        deleteSessionMeta(sessionId);
        sendToSender(
          senderWebContentsId,
          "pty:exit",
          { sessionId, exitCode: 0 },
        );
        // Also notify the shell BrowserWindow for terminal list cleanup
        sendToMainWindow("pty:exit", { sessionId, exitCode: 0 });
      }
      sessions.delete(sessionId);
    }),
  );

  sessions.set(sessionId, {
    pty: ptyProcess,
    shell: "",
    displayName: "",
    disposables,
  });

  return ptyProcess;
}

const ZSH_INTEGRATION_DIR = path.join(COLLAB_DIR, "shell-integration", "zsh");

function ensureZshIntegrationDir(): string | null {
  try {
    fs.mkdirSync(ZSH_INTEGRATION_DIR, { recursive: true });

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zshenv"),
      '[ -f "${_COLLAB_ZDOTDIR:-$HOME}/.zshenv" ] && '
        + '. "${_COLLAB_ZDOTDIR:-$HOME}/.zshenv"\n',
    );

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zprofile"),
      '[ -f "${_COLLAB_ZDOTDIR:-$HOME}/.zprofile" ] && '
        + '. "${_COLLAB_ZDOTDIR:-$HOME}/.zprofile"\n',
    );

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zshrc"),
      [
        '_collab_zd="${_COLLAB_ZDOTDIR:-$HOME}"',
        'ZDOTDIR="$_collab_zd"',
        "unset _COLLAB_ZDOTDIR",
        '[ -f "$_collab_zd/.zshrc" ] && . "$_collab_zd/.zshrc"',
        "unset _collab_zd",
        '__collab_osc7() { printf "\\e]7;file://%s%s\\a" "$HOST" "$PWD" }',
        "precmd_functions+=(__collab_osc7)",
        "",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(ZSH_INTEGRATION_DIR, ".zlogin"),
      '[ -f "${ZDOTDIR:-$HOME}/.zlogin" ] && '
        + '. "${ZDOTDIR:-$HOME}/.zlogin"\n',
    );

    return ZSH_INTEGRATION_DIR;
  } catch {
    return null;
  }
}

function osc7ShellHook(shell: string): string | null {
  const base = path.basename(shell);
  if (base === "zsh") {
    return [
      " __collab_osc7()",
      '{ printf "\\e]7;file://%s%s\\a" "$HOST" "$PWD"; };',
      "precmd_functions+=(__collab_osc7);",
      "clear",
    ].join(" ");
  }
  if (base === "bash" || base === "sh") {
    return [
      ' PROMPT_COMMAND=\'printf "\\e]7;file://%s%s\\a"',
      '"$HOSTNAME" "$PWD"\'${PROMPT_COMMAND:+";$PROMPT_COMMAND"};',
      "clear",
    ].join(" ");
  }
  // fish emits OSC 7 by default — no hook needed
  return null;
}

function injectOsc7Hook(
  sessionId: string,
  shell: string,
): void {
  const hook = osc7ShellHook(shell);
  if (!hook) return;
  // Delay to let the shell start and show its first prompt
  setTimeout(() => {
    writeToSession(sessionId, hook + "\n");
  }, 300);
}

export async function createSession(
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
  preferredTarget?: TerminalTarget,
  tileId?: string,
): Promise<{
  sessionId: string;
  shell: string;
  displayName: string;
  target: string;
  command: string;
  args: string[];
  cwdHostPath: string;
  cwdGuestPath?: string;
}> {
  const requestedCwd = cwd || os.homedir();
  // A shell spawned with a missing cwd exits immediately (chdir fails),
  // which silently closes the tile. Land in the nearest existing parent.
  const resolvedCwd = nearestExistingDir(requestedCwd);
  if (resolvedCwd !== path.resolve(requestedCwd)) {
    console.log(
      `[pty] cwd not found: ${requestedCwd} -> using ${resolvedCwd}`,
    );
  }
  const shell = process.env.SHELL || "/bin/zsh";
  const c = cols || 80;
  const r = rows || 24;

  const mode = getTerminalMode();

  if (mode === "tmux") {
    const sessionId = crypto.randomBytes(8).toString("hex");
    const name = tmuxSessionName(sessionId);
    const shellName = displayBasename(shell) || "shell";
    const shellBase = path.basename(shell);

    let zshIntegrated = false;
    if (shellBase === "zsh") {
      const dir = ensureZshIntegrationDir();
      if (dir) {
        const origZd = process.env.ZDOTDIR
          || process.env.HOME || os.homedir();
        try {
          tmuxExec("set-environment", "-g", "ZDOTDIR", dir);
          tmuxExec("set-environment", "-g", "_COLLAB_ZDOTDIR", origZd);
          zshIntegrated = true;
        } catch {
          // Fall back to injection below
        }
      }
    }

    tmuxExec(
      "new-session", "-d",
      "-s", name,
      "-c", resolvedCwd,
      "-x", String(c),
      "-y", String(r),
    );

    if (zshIntegrated) {
      try {
        tmuxExec("set-environment", "-gu", "ZDOTDIR");
        tmuxExec("set-environment", "-gu", "_COLLAB_ZDOTDIR");
      } catch {
        // Non-fatal cleanup
      }
    }

    tmuxExec("set-environment", "-t", name, "COLLAB_PTY_SESSION_ID", sessionId);
    if (tileId) {
      tmuxExec("set-environment", "-t", name, "COLLAB_TILE_ID", tileId);
    }
    tmuxExec("set-environment", "-t", name, "SHELL", shell);

    attachClient(sessionId, c, r, senderWebContentsId);

    writeSessionMeta(sessionId, {
      shell,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
      backend: "tmux",
    });

    const session = sessions.get(sessionId)!;
    session.shell = shell;
    session.displayName = shellName;

    if (!zshIntegrated) {
      injectOsc7Hook(sessionId, shell);
    }

    notifyCwdFallback(sessionId, senderWebContentsId, requestedCwd, resolvedCwd);

    return {
      sessionId,
      shell,
      displayName: shellName,
      target: "shell",
      command: shell,
      args: [],
      cwdHostPath: resolvedCwd,
    };
  }

  const resolvedTarget = resolveTerminalTarget(
    preferredTarget ?? getTerminalTarget(),
    resolvedCwd,
    crypto.randomUUID(),
  );

  await ensureSidecar();
  const client = getSidecarClient();
  const sidecarEnv = utf8Env();
  if (tileId) sidecarEnv.COLLAB_TILE_ID = tileId;

  let zshIntegrated = false;
  if (path.basename(resolvedTarget.command) === "zsh") {
    const dir = ensureZshIntegrationDir();
    if (dir) {
      sidecarEnv._COLLAB_ZDOTDIR = process.env.ZDOTDIR
        || process.env.HOME || os.homedir();
      sidecarEnv.ZDOTDIR = dir;
      zshIntegrated = true;
    }
  }

  const createParams = withOptionalFields({
    command: resolvedTarget.command,
    args: resolvedTarget.args,
    shell: resolvedTarget.command,
    displayName: resolvedTarget.displayName,
    target: resolvedTarget.target,
    cwd: resolvedTarget.cwd,
    cwdHostPath: resolvedTarget.cwdHostPath,
    cols: c,
    rows: r,
    env: sidecarEnv,
  }, {
    cwdGuestPath: resolvedTarget.cwdGuestPath,
  });
  console.log(
    `[pty] createSession target=${resolvedTarget.target}`
    + ` command=${resolvedTarget.command}`
    + ` args=${JSON.stringify(resolvedTarget.args)}`
    + ` cwd=${resolvedTarget.cwd}`,
  );
  const { sessionId, socketPath } = await client.createSession(createParams);
  console.log(`[pty] createSession ok sessionId=${sessionId}`);

  const dataSock = await client.attachDataSocket(
    socketPath,
    (data) => {
      forwardPtyData(sessionId, senderWebContentsId, data);
    },
  );
  dataSockets.set(sessionId, dataSock);

  writeSessionMeta(
    sessionId,
    withOptionalFields({
      shell: resolvedTarget.command,
      cwd: resolvedTarget.cwdHostPath,
      createdAt: new Date().toISOString(),
      target: resolvedTarget.target,
      displayName: resolvedTarget.displayName,
      command: resolvedTarget.command,
      args: resolvedTarget.args,
      cwdHostPath: resolvedTarget.cwdHostPath,
      backend: "sidecar",
    }, {
      cwdGuestPath: resolvedTarget.cwdGuestPath,
      claudeSessionId: resolvedTarget.claudeSessionId,
    }) as SessionMeta,
  );

  sidecarSessionIds.add(sessionId);
  if (resolvedTarget.target === "powershell") {
    sidecarPowerShellSessionIds.add(sessionId);
  }

  if (!zshIntegrated) {
    injectOsc7Hook(sessionId, resolvedTarget.command);
  }

  notifyCwdFallback(sessionId, senderWebContentsId, requestedCwd, resolvedCwd);

  return withOptionalFields({
    sessionId,
    shell: resolvedTarget.command,
    displayName: resolvedTarget.displayName,
    target: resolvedTarget.target,
    command: resolvedTarget.command,
    args: resolvedTarget.args,
    cwdHostPath: resolvedTarget.cwdHostPath,
  }, {
    cwdGuestPath: resolvedTarget.cwdGuestPath,
  });
}

function stripTrailingBlanks(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") {
    end--;
  }
  return lines.slice(0, end).join("\n");
}

export async function reconnectSession(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): Promise<{
  sessionId: string;
  shell: string;
  displayName: string;
  target?: string;
  command?: string;
  args?: string[];
  cwdHostPath?: string;
  cwdGuestPath?: string;
  meta: SessionMeta | null;
  scrollback: string;
  mode: "tmux" | "sidecar";
}> {
  // Route based on the backend that originally created this session.
  // Sessions without a backend field are legacy tmux sessions.
  const meta = readSessionMeta(sessionId);
  const backend = sessionBackend(sessionId);

  if (backend === "sidecar") {
    await ensureSidecar();
    const client = getSidecarClient();
    const { socketPath } = await client.reconnectSession(
      sessionId, cols, rows,
    );

    const dataSock = await client.attachDataSocket(
      socketPath,
      (data) => {
        forwardPtyData(sessionId, senderWebContentsId, data);
      },
    );

    dataSockets.get(sessionId)?.destroy();
    dataSockets.set(sessionId, dataSock);

    const shell = meta?.command || meta?.shell || process.env.SHELL || "/bin/zsh";
    const displayName = meta?.displayName || displayBasename(shell) || "shell";
    sidecarSessionIds.add(sessionId);
    if (meta?.target === "powershell") {
      sidecarPowerShellSessionIds.add(sessionId);
    }

    return withOptionalFields({
      sessionId,
      shell,
      displayName,
      meta,
      scrollback: "",
      mode: "sidecar",
    }, {
      target: meta?.target,
      command: meta?.command,
      args: meta?.args,
      cwdHostPath: meta?.cwdHostPath ?? meta?.cwd,
      cwdGuestPath: meta?.cwdGuestPath,
    });
  }

  const name = tmuxSessionName(sessionId);

  if (!tmuxHasSession(name)) {
    deleteSessionMeta(sessionId);
    throw new Error(`tmux session ${name} not found`);
  }

  let scrollback = "";
  try {
    const raw = tmuxExec(
      "capture-pane", "-t", name,
      "-p", "-e", "-S", "-200000",
    );
    scrollback = stripTrailingBlanks(raw);
  } catch {
    // Proceed without scrollback
  }

  attachClient(sessionId, cols, rows, senderWebContentsId);

  try {
    tmuxExec(
      "resize-window", "-t", name,
      "-x", String(cols), "-y", String(rows),
    );
  } catch {
    // Non-fatal
  }

  const session = sessions.get(sessionId)!;
  session.shell =
    meta?.shell || process.env.SHELL || "/bin/zsh";
  session.displayName =
    meta?.displayName || displayBasename(session.shell) || "shell";

  return withOptionalFields({
    sessionId,
    shell: session.shell,
    displayName: session.displayName,
    meta,
    scrollback,
    mode: "tmux",
  }, {
    target: meta?.target,
    command: meta?.command,
    args: meta?.args,
    cwdHostPath: meta?.cwdHostPath ?? meta?.cwd,
    cwdGuestPath: meta?.cwdGuestPath,
  });
}

export function writeToSession(
  sessionId: string,
  data: string,
): void {
  const dataSock = dataSockets.get(sessionId);
  if (dataSock && !dataSock.destroyed) {
    dataSock.write(data);
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) return;
  session.pty.write(data);
}

export function sendRawKeys(
  sessionId: string,
  data: string,
): void {
  if (sessionBackend(sessionId) !== "tmux") {
    writeToSession(sessionId, data);
    return;
  }
  const name = tmuxSessionName(sessionId);
  tmuxExec("send-keys", "-l", "-t", name, data);
}

export async function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const backend = sessionBackend(sessionId);
  if (backend === "sidecar") {
    try {
      await ensureSidecar();
      const client = getSidecarClient();
      await client.resizeSession(sessionId, cols, rows);
    } catch {
      // Restored renderer tabs can emit an initial resize before the
      // sidecar client is connected, or after the session is already gone.
      // Treat that startup race as non-fatal.
    }
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) return;
  session.pty.resize(cols, rows);

  const name = tmuxSessionName(sessionId);
  try {
    tmuxExec(
      "resize-window", "-t", name,
      "-x", String(cols), "-y", String(rows),
    );
  } catch {
    // Non-fatal
  }
}

export async function killSession(
  sessionId: string,
): Promise<void> {
  clearForegroundCache(sessionId);
  const backend = sessionBackend(sessionId);
  if (backend === "sidecar") {
    dataSockets.get(sessionId)?.destroy();
    dataSockets.delete(sessionId);
    try {
      const client = getSidecarClient();
      await client.killSession(sessionId);
    } catch {
      // Session may already be dead
    }
    sidecarSessionIds.delete(sessionId);
    sidecarPowerShellSessionIds.delete(sessionId);
    clearPendingPtyData(sessionId);
    deleteSessionMeta(sessionId);
    return;
  }

  const session = sessions.get(sessionId);
  if (session) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(sessionId);
  }

  const name = tmuxSessionName(sessionId);
  try {
    tmuxExec("kill-session", "-t", name);
  } catch {
    // Session may already be dead
  }

  clearPendingPtyData(sessionId);
  sidecarPowerShellSessionIds.delete(sessionId);
  deleteSessionMeta(sessionId);
}

export function listSessions(): string[] {
  return [...new Set([...sessions.keys(), ...sidecarSessionIds])];
}

export function killAll(): void {
  shuttingDown = true;
  for (const [, sock] of dataSockets) {
    sock.destroy();
  }
  dataSockets.clear();
  sidecarSessionIds.clear();
  sidecarPowerShellSessionIds.clear();
  for (const sessionId of pendingPtyDataTimers.keys()) {
    clearPendingPtyData(sessionId);
  }
  for (const [, session] of sessions) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
  }
  sessions.clear();
}

const KILL_ALL_TIMEOUT_MS = 2000;

export function killAllAndWait(): Promise<void> {
  shuttingDown = true;
  if (sessions.size === 0) return Promise.resolve();

  const pending: Promise<void>[] = [];
  for (const [id, session] of sessions) {
    pending.push(
      new Promise<void>((resolve) => {
        session.pty.onExit(() => resolve());
      }),
    );
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(id);
  }

  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, KILL_ALL_TIMEOUT_MS),
  );

  return Promise.race([
    Promise.all(pending).then(() => {}),
    timeout,
  ]);
}

export function destroyAll(): void {
  const ownedNames = [...sessions.keys()].map(
    (id) => tmuxSessionName(id),
  );
  killAll();
  for (const name of ownedNames) {
    try {
      tmuxExec("kill-session", "-t", name);
    } catch {
      // Session may already be gone
    }
  }
}

export async function shutdownSidecarIfIdle(): Promise<void> {
  if (!sidecarClient) return;
  try {
    const sessions = await sidecarClient.listSessions();
    if (sessions.length === 0) {
      await sidecarClient.shutdownSidecar();
    }
  } catch {
    // Sidecar already gone or unreachable — nothing to do.
  }
  sidecarClient = null;
}

export interface DiscoveredSession {
  sessionId: string;
  meta: SessionMeta;
}

export async function discoverSessions(): Promise<DiscoveredSession[]> {
  const result: DiscoveredSession[] = [];

  if (getTerminalMode() !== "tmux") {
    try {
      await ensureSidecar();
      const client = getSidecarClient();
      const list = await client.listSessions();
      result.push(...list.map((s) => ({
        sessionId: s.sessionId,
        meta: withOptionalFields({
          shell: s.shell,
          cwd: s.cwdHostPath,
          createdAt: s.createdAt,
          backend: "sidecar",
          target: s.target,
          displayName: s.displayName,
          command: s.shell,
          cwdHostPath: s.cwdHostPath,
        }, {
          cwdGuestPath: s.cwdGuestPath,
        }) as SessionMeta,
      })));
    } catch {
      // Sidecar not running; continue with tmux-only discovery.
    }
  }

  let tmuxNames: string[];
  try {
    const raw = tmuxExec(
      "list-sessions", "-F", "#{session_name}",
    );
    tmuxNames = raw.split("\n").filter(Boolean);
  } catch {
    tmuxNames = [];
  }

  const tmuxSet = new Set(tmuxNames);

  let metaFiles: string[];
  try {
    metaFiles = fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"));
  } catch {
    metaFiles = [];
  }

  for (const file of metaFiles) {
    const sessionId = file.replace(".json", "");
    const meta = readSessionMeta(sessionId);

    // Skip metadata from a different backend — it belongs to the
    // sidecar process and must not be deleted or returned here.
    if (meta?.backend === "sidecar") continue;

    const name = tmuxSessionName(sessionId);

    if (tmuxSet.has(name)) {
      if (meta) {
        result.push({ sessionId, meta });
      }
      tmuxSet.delete(name);
    } else {
      deleteSessionMeta(sessionId);
    }
  }

  return result;
}

export async function captureSession(
  sessionId: string,
  lines = 50,
): Promise<string> {
  const backend = sessionBackend(sessionId);

  if (backend === "sidecar") {
    const client = getSidecarClient();
    return await client.captureSession(sessionId, lines);
  }

  const name = tmuxSessionName(sessionId);
  const raw = tmuxExec(
    "capture-pane", "-t", name,
    "-p", "-S", `-${lines}`,
  );
  return stripTrailingBlanks(raw);
}

export async function getForegroundProcess(
  sessionId: string,
): Promise<string | null> {
  if (sessionBackend(sessionId) === "sidecar") {
    try {
      const client = getSidecarClient();
      return await client.getForeground(sessionId);
    } catch {
      return null;
    }
  }

  const name = tmuxSessionName(sessionId);
  try {
    return tmuxExec(
      "display-message", "-t", name,
      "-p", "#{pane_current_command}",
    );
  } catch {
    return null;
  }
}

const lastForeground = new Map<string, string>();
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
const STATUS_DEBOUNCE_MS = 500;

function shouldSkipForegroundCheck(sessionId: string): boolean {
  return (
    process.platform === "win32"
    && sessionBackend(sessionId) === "sidecar"
  );
}

function sendToMainWindow(channel: string, payload: unknown): void {
  const { BrowserWindow } = require("electron");
  const wins = BrowserWindow.getAllWindows();
  for (const win of wins) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export function scheduleForegroundCheck(sessionId: string): void {
  if (shouldSkipForegroundCheck(sessionId)) {
    clearForegroundCache(sessionId);
    return;
  }

  const existing = statusTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  statusTimers.set(
    sessionId,
    setTimeout(() => {
      statusTimers.delete(sessionId);
      getForegroundProcess(sessionId).then((fg) => {
        if (fg == null) return;

        const prev = lastForeground.get(sessionId);
        if (fg === prev) return;

        lastForeground.set(sessionId, fg);
        sendToMainWindow("pty:status-changed", {
          sessionId,
          foreground: fg,
        });
      });
    }, STATUS_DEBOUNCE_MS),
  );
}

export function clearForegroundCache(sessionId: string): void {
  lastForeground.delete(sessionId);
  const timer = statusTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    statusTimers.delete(sessionId);
  }
}

export function verifyTmuxAvailable(): { ok: true } | { ok: false; message: string } {
  try {
    tmuxExec("-V");
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error
      ? err.message
      : "tmux binary not found or not executable";
    return { ok: false, message };
  }
}
