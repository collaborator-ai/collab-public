import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from "electron";
import type { ReplayMessage } from "@collab/shared/replay-types";

// -- PTY listener sets (terminal) ------------------------------------

type PtyDataCallback = (
  payload: { sessionId: string; data: Uint8Array },
) => void;
type PtyExitCallback = (
  payload: { sessionId: string; exitCode: number },
) => void;
type CdToCallback = (path: string) => void;

const dataListeners = new Map<string, Set<PtyDataCallback>>();
const exitListeners = new Map<string, Set<PtyExitCallback>>();
type RunInTerminalCb = (command: string) => void;

const MAX_BUFFERED_PTY_EVENTS = 32;
const bufferedPtyData = new Map<
  string,
  Array<{ sessionId: string; data: Uint8Array }>
>();
const bufferedPtyExit = new Map<
  string,
  { sessionId: string; exitCode: number }
>();

const cdToListeners = new Set<CdToCallback>();
const runInTerminalListeners = new Set<RunInTerminalCb>();

type ReplayDataCb = (msg: ReplayMessage) => void;
const replayDataListeners = new Set<ReplayDataCb>();

type AgentEventCb = (event: {
  kind: string;
  sessionId: string;
  filePath?: string;
  touchType?: string;
  timestamp?: number;
}) => void;

const agentEventListeners = new Set<AgentEventCb>();
type FocusTabCb = (ptySessionId: string) => void;
const focusTabListeners = new Set<FocusTabCb>();
type ShellBlurCb = () => void;
const shellBlurListeners = new Set<ShellBlurCb>();

function getOrCreateListenerSet<T>(
  map: Map<string, Set<T>>,
  sessionId: string,
): Set<T> {
  let listeners = map.get(sessionId);
  if (!listeners) {
    listeners = new Set<T>();
    map.set(sessionId, listeners);
  }
  return listeners;
}

function removeListener<T>(
  map: Map<string, Set<T>>,
  sessionId: string,
  cb: T,
): void {
  const listeners = map.get(sessionId);
  if (!listeners) return;
  listeners.delete(cb);
  if (listeners.size === 0) {
    map.delete(sessionId);
  }
}

ipcRenderer.on("pty:data", (_event, payload) => {
  if ((dataListeners.get(payload.sessionId)?.size ?? 0) === 0) {
    const sessionBuffer = bufferedPtyData.get(payload.sessionId) ?? [];
    sessionBuffer.push(payload);
    if (sessionBuffer.length > MAX_BUFFERED_PTY_EVENTS) {
      sessionBuffer.shift();
    }
    bufferedPtyData.set(payload.sessionId, sessionBuffer);
  }

  for (const cb of dataListeners.get(payload.sessionId) ?? []) cb(payload);
});

ipcRenderer.on("pty:exit", (_event, payload) => {
  if ((exitListeners.get(payload.sessionId)?.size ?? 0) === 0) {
    bufferedPtyExit.set(payload.sessionId, payload);
  }
  for (const cb of exitListeners.get(payload.sessionId) ?? []) cb(payload);
});

ipcRenderer.on("cd-to", (_event, path: string) => {
  for (const cb of cdToListeners) cb(path);
});

ipcRenderer.on("run-in-terminal", (_event, command: string) => {
  for (const cb of runInTerminalListeners) cb(command);
});

ipcRenderer.on("agent:session-started", (_event, data) => {
  for (const cb of agentEventListeners) cb(data);
});
ipcRenderer.on("agent:file-touched", (_event, data) => {
  for (const cb of agentEventListeners) cb(data);
});
ipcRenderer.on("agent:session-ended", (_event, data) => {
  for (const cb of agentEventListeners) cb(data);
});
ipcRenderer.on("focus-tab", (_event, ptySessionId: string) => {
  for (const cb of focusTabListeners) cb(ptySessionId);
});
ipcRenderer.on("shell-blur", () => {
  for (const cb of shellBlurListeners) cb();
});

ipcRenderer.on("replay:data", (_event, msg) => {
  for (const cb of replayDataListeners) cb(msg);
});

// -- Canvas opacity ---------------------------------------------------
// The shell forwards canvas-opacity so webview backgrounds can match.
ipcRenderer.on("canvas-opacity", (_event: unknown, value: number) => {
  document.documentElement.style.setProperty(
    "--canvas-opacity",
    String(value),
  );
});

// -- Nav-visibility buffer -------------------------------------------
let bufferedNavVisible: boolean | null = null;
const navVisBuffer = (
  _event: unknown,
  visible: boolean,
) => {
  bufferedNavVisible = visible;
};
ipcRenderer.on("nav-visibility", navVisBuffer);

// -- Unified API surface --------------------------------------------

contextBridge.exposeInMainWorld("api", {
  // Shared
  getPlatform: (): NodeJS.Platform => process.platform,
  getConfig: () => ipcRenderer.invoke("config:get"),
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  getDeviceId: () =>
    ipcRenderer.invoke("analytics:get-device-id"),
  getPref: (key: string) => ipcRenderer.invoke("pref:get", key),
  setPref: (key: string, value: unknown) =>
    ipcRenderer.invoke("pref:set", key, value),
  listTerminalTargets: () =>
    ipcRenderer.invoke("terminal:list-targets"),
  getWorkspacePref: (key: string, workspacePath: string) =>
    ipcRenderer.invoke("workspace-pref:get", { key, workspacePath }),
  setWorkspacePref: (key: string, value: unknown, workspacePath: string) =>
    ipcRenderer.invoke("workspace-pref:set", { key, value, workspacePath }),

  // Nav + Viewer
  selectFile: (path: string | null) =>
    ipcRenderer.send("nav:select-file", path),

  // Nav
  readDir: (path: string) =>
    ipcRenderer.invoke("fs:readdir", path),
  countFiles: (path: string) =>
    ipcRenderer.invoke("fs:count-files", path),
  trashFile: (path: string) =>
    ipcRenderer.invoke("fs:trash", path),
  createDir: (path: string) =>
    ipcRenderer.invoke("fs:mkdir", path),
  moveFile: (oldPath: string, newParentDir: string) =>
    ipcRenderer.invoke("fs:move", oldPath, newParentDir),
  selectFolder: (path: string) =>
    ipcRenderer.send("nav:select-folder", path),
  readFolderTable: (folderPath: string) =>
    ipcRenderer.invoke("fs:read-folder-table", folderPath),
  importWebArticle: (url: string, targetDir: string) =>
    ipcRenderer.invoke("import:web-article", url, targetDir),
  openInTerminal: (path: string) =>
    ipcRenderer.send("nav:open-in-terminal", path),
  revealInFinder: (path: string) =>
    ipcRenderer.send("nav:reveal-in-finder", path),
  createGraphTile: (folderPath: string) =>
    ipcRenderer.send("nav:create-graph-tile", folderPath),
  runInTerminal: (command: string) =>
    ipcRenderer.send("viewer:run-in-terminal", command),

  // Viewer
  readFile: (path: string) =>
    ipcRenderer.invoke("fs:readfile", path),
  renameFile: (oldPath: string, newTitle: string) =>
    ipcRenderer.invoke("fs:rename", oldPath, newTitle),
  getFileStats: (path: string) =>
    ipcRenderer.invoke("fs:stat", path),
  getImageThumbnail: (path: string, size: number) =>
    ipcRenderer.invoke("image:thumbnail", path, size),
  getImageFull: (path: string) =>
    ipcRenderer.invoke("image:full", path),
  resolveImagePath: (reference: string, fromNotePath: string) =>
    ipcRenderer.invoke("image:resolve-path", reference, fromNotePath),
  saveDroppedImage: (
    noteDir: string,
    fileName: string,
    buffer: ArrayBuffer,
  ) =>
    ipcRenderer.invoke(
      "image:save-dropped",
      noteDir,
      fileName,
      buffer,
    ),
  openImageDialog: () =>
    ipcRenderer.invoke("dialog:open-image"),
  getWorkspaceGraph: (
    params: { workspacePath: string },
  ) => ipcRenderer.invoke("workspace:get-graph", params),
  updateFrontmatter: (
    filePath: string,
    field: string,
    value: unknown,
  ) =>
    ipcRenderer.invoke(
      "workspace:update-frontmatter",
      filePath,
      field,
      value,
    ),
  resolveWikilink: (target: string) =>
    ipcRenderer.invoke("wikilink:resolve", target),
  suggestWikilinks: (partial: string) =>
    ipcRenderer.invoke("wikilink:suggest", partial),
  getBacklinks: (filePath: string) =>
    ipcRenderer.invoke("wikilink:backlinks", filePath),

  // Nav + Viewer (shared FS helpers)
  writeFile: (path: string, content: string, expectedMtime?: string) =>
    ipcRenderer.invoke("fs:writefile", path, content, expectedMtime),
  readTree: (params: { root: string }) =>
    ipcRenderer.invoke("workspace:read-tree", params),
  // Terminal (PTY)
  ptyCreate: (
    cwd?: string,
    cols?: number,
    rows?: number,
    target?: string,
    tileId?: string,
  ) =>
    ipcRenderer.invoke(
      "pty:create",
      { cwd, cols, rows, target, tileId },
    ),
  ptyWrite: (sessionId: string, data: string) => {
    ipcRenderer.send("pty:write", { sessionId, data });
  },
  ptySendRawKeys: (sessionId: string, data: string) => {
    ipcRenderer.send("pty:send-raw-keys", { sessionId, data });
  },
  ptyResize: (
    sessionId: string,
    cols: number,
    rows: number,
  ) =>
    ipcRenderer.invoke(
      "pty:resize",
      { sessionId, cols, rows },
    ),
  ptyKill: (sessionId: string) =>
    ipcRenderer.invoke("pty:kill", { sessionId }),
  ptyReconnect: (
    sessionId: string,
    cols: number,
    rows: number,
  ) =>
    ipcRenderer.invoke(
      "pty:reconnect",
      { sessionId, cols, rows },
    ),
  ptyDiscover: () =>
    ipcRenderer.invoke("pty:discover"),
  ptyReadMeta: (sessionId: string) =>
    ipcRenderer.invoke("pty:read-meta", sessionId),
  onPtyData: (sessionId: string, cb: PtyDataCallback) => {
    getOrCreateListenerSet(dataListeners, sessionId).add(cb);
    const buffered = bufferedPtyData.get(sessionId);
    if (buffered && buffered.length > 0) {
      for (const payload of buffered) cb(payload);
      bufferedPtyData.delete(sessionId);
    }
  },
  offPtyData: (sessionId: string, cb: PtyDataCallback) => {
    removeListener(dataListeners, sessionId, cb);
  },
  onPtyExit: (sessionId: string, cb: PtyExitCallback) => {
    getOrCreateListenerSet(exitListeners, sessionId).add(cb);
    const buffered = bufferedPtyExit.get(sessionId);
    if (buffered) {
      cb(buffered);
      bufferedPtyExit.delete(sessionId);
    }
  },
  offPtyExit: (sessionId: string, cb: PtyExitCallback) => {
    removeListener(exitListeners, sessionId, cb);
  },
  notifyPtySessionId: (sessionId: string) =>
    ipcRenderer.sendToHost("pty-session-id", sessionId),
  notifyCwdChanged: (sessionId: string, cwd: string) =>
    ipcRenderer.sendToHost("pty-cwd-changed", sessionId, cwd),
  onCdTo: (cb: CdToCallback) => {
    cdToListeners.add(cb);
  },
  offCdTo: (cb: CdToCallback) => {
    cdToListeners.delete(cb);
  },
  onRunInTerminal: (cb: RunInTerminalCb) => {
    runInTerminalListeners.add(cb);
  },
  offRunInTerminal: (cb: RunInTerminalCb) => {
    runInTerminalListeners.delete(cb);
  },

  // File drop support
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  isDirectory: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke("fs:is-directory", filePath),

  // Cross-webview drag-and-drop
  setDragPaths: (paths: string[]) =>
    ipcRenderer.send("drag:set-paths", paths),
  clearDragPaths: () =>
    ipcRenderer.send("drag:clear-paths"),
  getDragPaths: () =>
    ipcRenderer.invoke("drag:get-paths"),
  onNavDragActive: (cb: (active: boolean) => void) => {
    const handler = (_event: unknown, active: boolean) => cb(active);
    ipcRenderer.on("nav-drag-active", handler);
    return () => ipcRenderer.removeListener("nav-drag-active", handler);
  },

  // Workspace management
  workspaceAdd: () => ipcRenderer.invoke("workspace:add"),
  workspaceRemoveByPath: (path: string) =>
    ipcRenderer.invoke("workspace:remove-by-path", path),

  // Theme
  setTheme: (mode: string) =>
    ipcRenderer.invoke("theme:set", mode),

  // Settings
  openFolder: () =>
    ipcRenderer.invoke("dialog:open-folder"),
  showContextMenu: (
    items: Array<{
      id: string;
      label: string;
      enabled?: boolean;
    }>,
  ) => ipcRenderer.invoke("context-menu:show", items),
  close: () => ipcRenderer.send("settings:close"),

  // Integrations
  getAgents: () =>
    ipcRenderer.invoke("integrations:get-agents"),
  installSkill: (agentId: string) =>
    ipcRenderer.invoke("integrations:install-skill", agentId),
  uninstallSkill: (agentId: string) =>
    ipcRenderer.invoke("integrations:uninstall-skill", agentId),
  hasOfferedPlugin: () =>
    ipcRenderer.invoke("integrations:has-offered-plugin"),
  markPluginOffered: () =>
    ipcRenderer.invoke("integrations:mark-plugin-offered"),

  // IPC event listeners (nav, viewer, terminal)
  onFocusSearch: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("focus-search", handler);
    return () =>
      ipcRenderer.removeListener("focus-search", handler);
  },
  onFileSelected: (cb: (path: string | null) => void) => {
    const handler = (
      _event: unknown,
      path: string | null,
    ) => cb(path);
    ipcRenderer.on("file-selected", handler);
    return () =>
      ipcRenderer.removeListener("file-selected", handler);
  },
  onFolderSelected: (cb: (path: string) => void) => {
    const handler = (
      _event: unknown,
      path: string,
    ) => cb(path);
    ipcRenderer.on("folder-selected", handler);
    return () =>
      ipcRenderer.removeListener("folder-selected", handler);
  },
  onFileRenamed: (
    cb: (oldPath: string, newPath: string) => void,
  ) => {
    const handler = (
      _event: unknown,
      oldPath: string,
      newPath: string,
    ) => cb(oldPath, newPath);
    ipcRenderer.on("file-renamed", handler);
    return () =>
      ipcRenderer.removeListener("file-renamed", handler);
  },
  onFilesDeleted: (cb: (paths: string[]) => void) => {
    const handler = (
      _event: unknown,
      paths: string[],
    ) => cb(paths);
    ipcRenderer.on("files-deleted", handler);
    return () =>
      ipcRenderer.removeListener("files-deleted", handler);
  },
  onFsChanged: (
    cb: (
      events: Array<{
        dirPath: string;
        changes: Array<{ path: string; type: number }>;
      }>,
    ) => void,
  ) => {
    const handler = (_event: unknown, events: unknown) =>
      cb(
        events as Array<{
          dirPath: string;
          changes: Array<{ path: string; type: number }>;
        }>,
      );
    ipcRenderer.on("fs-changed", handler);
    return () =>
      ipcRenderer.removeListener("fs-changed", handler);
  },
  onWorkspaceAdded: (cb: (path: string) => void) => {
    const handler = (
      _event: unknown,
      path: string,
    ) => cb(path);
    ipcRenderer.on("workspace-added", handler);
    return () =>
      ipcRenderer.removeListener("workspace-added", handler);
  },
  onWorkspaceRemoved: (cb: (path: string) => void) => {
    const handler = (
      _event: unknown,
      path: string,
    ) => cb(path);
    ipcRenderer.on("workspace-removed", handler);
    return () =>
      ipcRenderer.removeListener("workspace-removed", handler);
  },
  onWikilinksUpdated: (cb: (paths: string[]) => void) => {
    const handler = (
      _event: unknown,
      paths: string[],
    ) => cb(paths);
    ipcRenderer.on("wikilinks-updated", handler);
    return () =>
      ipcRenderer.removeListener("wikilinks-updated", handler);
  },
  onNavVisibility: (cb: (visible: boolean) => void) => {
    if (bufferedNavVisible !== null) {
      cb(bufferedNavVisible);
      bufferedNavVisible = null;
    }
    ipcRenderer.removeListener("nav-visibility", navVisBuffer);
    const handler = (
      _event: unknown,
      visible: boolean,
    ) => cb(visible);
    ipcRenderer.on("nav-visibility", handler);
    return () =>
      ipcRenderer.removeListener("nav-visibility", handler);
  },

  onScopeChanged: (cb: (newPath: string) => void) => {
    const handler = (
      _event: IpcRendererEvent,
      path: string,
    ) => cb(path);
    ipcRenderer.on("scope-changed", handler);
    return () =>
      ipcRenderer.removeListener("scope-changed", handler);
  },

  // Auto-updater
  updateGetStatus: () =>
    ipcRenderer.invoke("update:getStatus"),
  updateCheck: () =>
    ipcRenderer.invoke("update:check"),
  updateInstall: () =>
    ipcRenderer.send("update:install"),
  onUpdateStatus: (cb: (state: unknown) => void) => {
    const handler = (
      _event: IpcRendererEvent,
      state: unknown,
    ) => cb(state);
    ipcRenderer.on("update:status", handler);
    return () =>
      ipcRenderer.removeListener("update:status", handler);
  },

  // Agent activity
  onAgentEvent: (cb: AgentEventCb) => {
    agentEventListeners.add(cb);
    return () => {
      agentEventListeners.delete(cb);
    };
  },
  focusAgentSession: (sessionId: string) =>
    ipcRenderer.invoke("agent:focus-session", sessionId),

  // Git replay
  startReplay: (params: { workspacePath: string }) =>
    ipcRenderer.invoke("replay:start", params),
  stopReplay: () =>
    ipcRenderer.invoke("replay:stop"),
  onReplayData: (cb: ReplayDataCb) => {
    replayDataListeners.add(cb);
    return () => { replayDataListeners.delete(cb); };
  },

  // Terminal focus
  onFocusTab: (cb: FocusTabCb) => {
    focusTabListeners.add(cb);
    return () => {
      focusTabListeners.delete(cb);
    };
  },

  onShellBlur: (cb: ShellBlurCb) => {
    shellBlurListeners.add(cb);
    return () => {
      shellBlurListeners.delete(cb);
    };
  },

  // Canvas pinch forwarding
  forwardPinch: (deltaY: number) =>
    ipcRenderer.send("canvas:forward-pinch", deltaY),

  // Generic sendToHost for webview → shell renderer communication
  sendToHost: (channel: string, ...args: unknown[]) =>
    ipcRenderer.sendToHost(channel, ...args),

  // Terminal list channels (shell renderer → webview via webview.send)
  onTileListMessage: (
    cb: (channel: string, ...args: unknown[]) => void,
  ) => {
    const channels = [
      "tile-list:init",
      "tile-list:add",
      "tile-list:remove",
      "tile-list:update",
      "tile-list:focus",
    ];
    const handlers = channels.map((ch) => {
      const handler = (_event: unknown, ...args: unknown[]) =>
        cb(ch, ...args);
      ipcRenderer.on(ch, handler);
      return { ch, handler };
    });
    return () => {
      for (const { ch, handler } of handlers) {
        ipcRenderer.removeListener(ch, handler);
      }
    };
  },
  // -- ACP agent --
  agentSpawn: (
    cwd: string,
  ): Promise<{
    sessionId: string;
    resumed: boolean;
    cachedMessages: unknown[];
  }> =>
    ipcRenderer.invoke("agent:spawn", { cwd }),

  agentPrompt: (
    sessionId: string, text: string,
  ): Promise<void> =>
    ipcRenderer.invoke("agent:prompt", { sessionId, text }),

  agentCancel: (
    sessionId: string,
  ): Promise<void> =>
    ipcRenderer.invoke("agent:cancel", { sessionId }),

  agentKill: (
    sessionId: string,
  ): Promise<void> =>
    ipcRenderer.invoke("agent:kill", { sessionId }),

  agentSaveMessages: (
    messages: unknown[],
  ): Promise<void> =>
    ipcRenderer.invoke(
      "agent:save-messages", { messages },
    ),

  onAgentUpdate: (
    cb: (params: unknown) => void,
  ) => {
    const handler = (
      _event: unknown, params: unknown,
    ) => cb(params);
    ipcRenderer.on("agent:update", handler);
    return () =>
      ipcRenderer.removeListener("agent:update", handler);
  },

  onAgentPromptComplete: (
    cb: (data: {
      sessionId: string;
      stopReason: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { sessionId: string; stopReason: string },
    ) => cb(data);
    ipcRenderer.on("agent:prompt-complete", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:prompt-complete", handler,
      );
  },

  onAgentPromptError: (
    cb: (data: {
      sessionId: string; error: string;
    }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { sessionId: string; error: string },
    ) => cb(data);
    ipcRenderer.on("agent:prompt-error", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:prompt-error", handler,
      );
  },

  onAgentExit: (
    cb: (data: { sessionId: string }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { sessionId: string },
    ) => cb(data);
    ipcRenderer.on("agent:exit", handler);
    return () =>
      ipcRenderer.removeListener("agent:exit", handler);
  },

  onAgentSessionReady: (
    cb: (data: { sessionId: string }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { sessionId: string },
    ) => cb(data);
    ipcRenderer.on("agent:session-ready", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:session-ready", handler,
      );
  },

  onAgentSessionFailed: (
    cb: (data: { sessionId: string }) => void,
  ) => {
    const handler = (
      _event: unknown,
      data: { sessionId: string },
    ) => cb(data);
    ipcRenderer.on("agent:session-failed", handler);
    return () =>
      ipcRenderer.removeListener(
        "agent:session-failed", handler,
      );
  },
});

// Forward ctrl+wheel (trackpad pinch) from tile webviews to the canvas
window.addEventListener("wheel", (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    ipcRenderer.send("canvas:forward-pinch", e.deltaY);
  }
}, { passive: false });
