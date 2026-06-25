import type {
  AppConfig,
  FolderTableData,
  TreeNode,
} from "./types";
import type { ReplayMessage } from "./replay-types";

type Unsubscribe = () => void;

interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  progress?: number;
  version?: string;
  releaseNotes?: string;
  error?: string;
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
  createdAt: string;
  modifiedAt: string;
  fileCount?: number;
}

interface FileStats {
  ctime: string;
  mtime: string;
}

interface GraphData {
  nodes: Array<{
    id: string;
    title: string;
    path: string;
    nodeType?: "file" | "code";
    weight?: number;
  }>;
  links: Array<{
    source: string;
    target: string;
    linkType?: "wikilink" | "import";
  }>;
}

interface WikilinkSuggestion {
  stem: string;
  path: string;
  ambiguous: boolean;
}

interface Backlink {
  path: string;
  context: string;
}

interface PtySession {
  sessionId: string;
  shell: string;
  displayName: string;
  target: string;
  command: string;
  args: string[];
  cwdHostPath: string;
  cwdGuestPath?: string;
}

interface TerminalTargetOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

type PtyDataCb = (
  payload: { sessionId: string; data: Uint8Array },
) => void;
type PtyExitCb = (
  payload: { sessionId: string; exitCode: number },
) => void;
type CdToCb = (path: string) => void;
type RunInTerminalCb = (command: string) => void;

interface AgentSessionEvent {
  kind: "session-started";
  sessionId: string;
}

interface AgentFileTouchedEvent {
  kind: "file-touched";
  sessionId: string;
  filePath: string;
  touchType: "read" | "write";
  timestamp: number;
}

interface AgentSessionEndedEvent {
  kind: "session-ended";
  sessionId: string;
}

type AgentEvent =
  | AgentSessionEvent
  | AgentFileTouchedEvent
  | AgentSessionEndedEvent;

export interface AcpUpdate {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?:
      | { type: string; text?: string }
      | Array<{
        type: string;
        content?: { type: string; text?: string };
      }>;
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    rawOutput?: unknown;
  };
}

interface AgentSpawnResult {
  sessionId: string;
  resumed: boolean;
  cachedMessages: unknown[];
}

interface AgentInfo {
  id: string;
  name: string;
  detected: boolean;
  installed: boolean;
}

interface SkillResult {
  ok: boolean;
  error?: string;
}

type TileListMessageCb = (
  channel: string,
  ...args: unknown[]
) => void;

export interface CollabApi {
  // Config
  getPlatform: () => NodeJS.Platform;
  getConfig: () => Promise<AppConfig>;
  getAppVersion: () => Promise<string>;
  getDeviceId: () => Promise<string>;
  getPref: (key: string) => Promise<unknown>;
  setPref: (key: string, value: unknown) => Promise<void>;
  listTerminalTargets: () => Promise<TerminalTargetOption[]>;
  getWorkspacePref: (key: string, workspacePath: string) => Promise<unknown>;
  setWorkspacePref: (
    key: string,
    value: unknown,
    workspacePath: string,
  ) => Promise<void>;

  // Theme
  setTheme: (mode: string) => Promise<void>;

  // File selection
  selectFile: (path: string | null) => void;

  // Folder selection
  selectFolder: (path: string) => void;
  readFolderTable: (
    folderPath: string,
  ) => Promise<FolderTableData>;

  // File system (nav)
  readDir: (path: string) => Promise<DirEntry[]>;
  countFiles: (path: string) => Promise<number>;
  trashFile: (path: string) => Promise<void>;
  createDir: (path: string) => Promise<void>;
  moveFile: (
    oldPath: string,
    newParentDir: string,
  ) => Promise<string>;

  // Import
  importWebArticle(
    url: string,
    targetDir: string,
  ): Promise<{ path: string }>;

  // File system (viewer)
  readFile: (path: string) => Promise<string>;
  writeFile: (
    path: string,
    content: string,
    expectedMtime?: string,
  ) => Promise<WriteResult>;
  renameFile: (
    oldPath: string,
    newTitle: string,
  ) => Promise<string>;
  getFileStats: (path: string) => Promise<FileStats>;

  // Images
  getImageThumbnail: (
    path: string,
    size: number,
  ) => Promise<string>;
  getImageFull: (path: string) => Promise<{
    url: string;
    width: number;
    height: number;
  }>;
  resolveImagePath: (
    reference: string,
    fromNotePath: string,
  ) => Promise<string | null>;
  saveDroppedImage: (
    noteDir: string,
    fileName: string,
    buffer: ArrayBuffer,
  ) => Promise<string>;
  openImageDialog: () => Promise<string | null>;

  readTree: (params: {
    root: string;
  }) => Promise<TreeNode[]>;

  // Workspace
  workspaceAdd: () => Promise<{ workspaces: string[] } | null>;
  workspaceRemoveByPath: (
    path: string,
  ) => Promise<{ workspaces: string[] }>;
  getWorkspaceGraph: (params: {
    workspacePath: string;
  }) => Promise<GraphData>;
  updateFrontmatter: (
    filePath: string,
    field: string,
    value: unknown,
  ) => Promise<{ ok: boolean; retried?: boolean }>;

  // Wikilinks
  resolveWikilink: (
    target: string,
  ) => Promise<string | null>;
  suggestWikilinks: (
    partial: string,
  ) => Promise<WikilinkSuggestion[]>;
  getBacklinks: (
    filePath: string,
  ) => Promise<Backlink[]>;

  // PTY
  ptyCreate: (
    cwd?: string,
    cols?: number,
    rows?: number,
    target?: string,
    tileId?: string,
  ) => Promise<PtySession>;
  ptyWrite: (
    sessionId: string,
    data: string,
  ) => void;
  ptySendRawKeys: (
    sessionId: string,
    data: string,
  ) => void;
  ptyResize: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Promise<void>;
  ptyKill: (sessionId: string) => Promise<void>;
  ptyReconnect: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Promise<PtySession>;
  ptyDiscover: () => Promise<
    Array<{
      sessionId: string;
      meta: {
        shell: string;
        cwd: string;
        createdAt: string;
        displayName?: string;
        target?: string;
        cwdHostPath?: string;
        cwdGuestPath?: string;
      };
    }>
  >;
  ptyReadMeta: (sessionId: string) => Promise<{
    shell: string;
    cwd: string;
    createdAt: string;
    target?: string;
  } | null>;
  notifyPtySessionId: (sessionId: string) => void;
  notifyCwdChanged: (sessionId: string, cwd: string) => void;
  onPtyData: (sessionId: string, cb: PtyDataCb) => void;
  offPtyData: (sessionId: string, cb: PtyDataCb) => void;
  onPtyExit: (sessionId: string, cb: PtyExitCb) => void;
  offPtyExit: (sessionId: string, cb: PtyExitCb) => void;
  onCdTo: (cb: CdToCb) => void;
  offCdTo: (cb: CdToCb) => void;

  // Navigation
  openInTerminal: (path: string) => void;
  revealInFinder: (path: string) => void;
  createGraphTile: (folderPath: string) => void;
  runInTerminal: (command: string) => void;
  onRunInTerminal: (cb: RunInTerminalCb) => void;
  offRunInTerminal: (cb: RunInTerminalCb) => void;

  // File drop support
  getPathForFile: (file: File) => string;
  isDirectory: (filePath: string) => Promise<boolean>;

  // Cross-webview drag-and-drop
  setDragPaths: (paths: string[]) => void;
  clearDragPaths: () => void;
  getDragPaths: () => Promise<string[]>;
  onNavDragActive: (
    cb: (active: boolean) => void,
  ) => Unsubscribe;

  // Settings
  openFolder: () => Promise<string | null>;
  close: () => void;

  // Context menu
  showContextMenu: (
    items: Array<{
      id: string;
      label: string;
      enabled?: boolean;
    }>,
  ) => Promise<string | null>;

  // IPC event listeners
  onFocusSearch: (cb: () => void) => Unsubscribe;
  onFileSelected: (
    cb: (path: string | null) => void,
  ) => Unsubscribe;
  onFolderSelected: (
    cb: (path: string) => void,
  ) => Unsubscribe;
  onFileRenamed: (
    cb: (oldPath: string, newPath: string) => void,
  ) => Unsubscribe;
  onFilesDeleted: (
    cb: (paths: string[]) => void,
  ) => Unsubscribe;
  onFsChanged: (
    cb: (
      events: Array<{
        dirPath: string;
        changes: Array<{ path: string; type: number }>;
      }>,
    ) => void,
  ) => Unsubscribe;
  onWorkspaceAdded: (
    cb: (path: string) => void,
  ) => Unsubscribe;
  onWorkspaceRemoved: (
    cb: (path: string) => void,
  ) => Unsubscribe;
  onWikilinksUpdated: (
    cb: (paths: string[]) => void,
  ) => Unsubscribe;
  onNavVisibility: (
    cb: (visible: boolean) => void,
  ) => Unsubscribe;

  onScopeChanged: (
    cb: (newPath: string) => void,
  ) => Unsubscribe;

  // Auto-updater
  updateGetStatus: () => Promise<UpdateState>;
  updateCheck: () => Promise<UpdateState>;
  updateDownload: () => Promise<UpdateState>;
  updateInstall: () => void;
  onUpdateStatus: (
    cb: (state: UpdateState) => void,
  ) => Unsubscribe;

  // Integrations
  getAgents: () => Promise<AgentInfo[]>;
  installSkill: (agentId: string) => Promise<SkillResult>;
  uninstallSkill: (agentId: string) => Promise<SkillResult>;
  hasOfferedPlugin: () => Promise<boolean>;
  markPluginOffered: () => Promise<{ ok: boolean }>;

  // Agent activity
  onAgentEvent: (cb: (event: AgentEvent) => void) => Unsubscribe;
  focusAgentSession: (sessionId: string) => Promise<void>;

  // ACP agent
  agentSpawn: (cwd: string) => Promise<AgentSpawnResult>;
  agentPrompt: (sessionId: string, text: string) => Promise<void>;
  agentCancel: (sessionId: string) => Promise<void>;
  agentKill: (sessionId: string) => Promise<void>;
  agentSaveMessages: (messages: unknown[]) => Promise<void>;
  onAgentUpdate: (cb: (params: AcpUpdate) => void) => Unsubscribe;
  onAgentPromptComplete: (
    cb: (data: { sessionId: string; stopReason: string }) => void,
  ) => Unsubscribe;
  onAgentPromptError: (
    cb: (data: { sessionId: string; error: string }) => void,
  ) => Unsubscribe;
  onAgentExit: (
    cb: (data: { sessionId: string }) => void,
  ) => Unsubscribe;
  onAgentSessionReady: (
    cb: (data: { sessionId: string }) => void,
  ) => Unsubscribe;
  onAgentSessionFailed: (
    cb: (data: { sessionId: string }) => void,
  ) => Unsubscribe;

  // Terminal list (shell renderer ↔ webview)
  sendToHost: (channel: string, ...args: unknown[]) => void;
  onTileListMessage: (cb: TileListMessageCb) => Unsubscribe;

  // Git replay
  startReplay: (params: { workspacePath: string }) => Promise<boolean>;
  stopReplay: () => Promise<void>;
  onReplayData: (
    cb: (msg: ReplayMessage) => void,
  ) => Unsubscribe;

  // Terminal focus (receiving end)
  onFocusTab: (cb: (ptySessionId: string) => void) => Unsubscribe;
  onShellBlur: (cb: () => void) => Unsubscribe;

  // Canvas pinch forwarding
  forwardPinch: (deltaY: number) => void;
}

declare global {
  interface WriteResult {
    ok: boolean;
    mtime: string;
    conflict?: boolean;
  }

  interface Window {
    api: CollabApi;
  }
}
