import {
  ipcMain,
  dialog,
  Menu,
  Notification,
  shell,
  type BrowserWindow,
} from "electron";
import * as gitReplay from "./git-replay";
import {
  findRepoRoot,
  listBranches,
  resolveWorktree,
} from "./git-worktree";
import { importWebArticle } from "./import-service";
import * as agentActivity from "./agent-activity";
import { registerMethod } from "./json-rpc-server";
import { DISABLE_GIT_REPLAY } from "@collab/shared/replay-types";
import { workspaceForFile } from "./ipc-workspace";

interface IpcContext {
  mainWindow: () => BrowserWindow | null;
  workspaces: () => string[];
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
  trackEvent: (
    name: string,
    props?: Record<string, unknown>,
  ) => void;
}

export function registerMiscHandlers(
  ctx: IpcContext,
): void {
  // Dialog: open folder
  ipcMain.handle("dialog:open-folder", async () => {
    const win = ctx.mainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0]!;
  });

  // Dialog: open image
  ipcMain.handle("dialog:open-image", async () => {
    const win = ctx.mainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        {
          name: "Images",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "bmp",
            "tiff",
            "tif",
            "avif",
            "heic",
            "heif",
          ],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0]!;
  });

  // Dialog: confirm
  ipcMain.handle(
    "dialog:confirm",
    async (
      _event,
      opts: {
        message: string;
        detail?: string;
        buttons?: string[];
      },
    ) => {
      const win = ctx.mainWindow();
      if (!win) return 0;
      const result = await dialog.showMessageBox(win, {
        type: "warning",
        message: opts.message,
        detail: opts.detail,
        buttons: opts.buttons ?? ["OK", "Cancel"],
      });
      return result.response;
    },
  );

  // Context menu
  ipcMain.handle(
    "context-menu:show",
    async (
      _event,
      items: Array<{
        id: string;
        label: string;
        enabled?: boolean;
      }>,
    ) => {
      const win = ctx.mainWindow();
      if (!win) return null;

      return new Promise<string | null>((resolve) => {
        const menu = Menu.buildFromTemplate(
          items.map((item) => {
            if (item.id === "separator") {
              return { type: "separator" as const };
            }
            return {
              label: item.label,
              enabled: item.enabled ?? true,
              click: () => resolve(item.id),
            };
          }),
        );
        menu.popup({
          window: win,
          callback: () => resolve(null),
        });
      });
    },
  );

  ipcMain.handle(
    "git:list-branches",
    async (_event, workspacePath: string) => {
      const repoRoot = await findRepoRoot(workspacePath);
      if (!repoRoot) return null;
      return {
        repoRoot,
        branches: await listBranches(repoRoot),
      };
    },
  );

  ipcMain.handle(
    "git:resolve-worktree",
    async (
      _event,
      repoRoot: string,
      branch: string,
      create: boolean,
      base?: string,
    ) => {
      try {
        return {
          cwd: await resolveWorktree(repoRoot, branch, {
            create,
            base,
          }),
        };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // Open external URL
  ipcMain.on(
    "shell:open-external",
    (_event, url: string) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    },
  );

  // Git replay
  if (!DISABLE_GIT_REPLAY) {
    gitReplay.setNotifyFn((msg) => {
      ctx.forwardToWebview(
        `viewer:${msg.workspacePath}`,
        "replay:data",
        msg,
      );
    });
  }

  ipcMain.handle(
    "replay:start",
    (
      _event,
      params: { workspacePath: string },
    ): boolean => {
      if (DISABLE_GIT_REPLAY) return false;
      return gitReplay.startReplay(params.workspacePath);
    },
  );

  ipcMain.handle("replay:stop", () => {
    if (DISABLE_GIT_REPLAY) return;
    gitReplay.stopReplay();
  });

  // Import web article
  ipcMain.handle(
    "import:web-article",
    async (_event, url: string, targetDir: string) => {
      const ws = workspaceForFile(
        targetDir,
        ctx.workspaces(),
      );
      if (!ws) {
        throw new Error("No workspace found for target directory");
      }
      const articleResult = await importWebArticle(
        url,
        targetDir,
        ws,
      );
      ctx.trackEvent("web_article_imported");
      return articleResult;
    },
  );

  // Agent activity
  agentActivity.setNotifyFn((event) => {
    ctx.forwardToWebview(
      "viewer",
      `agent:${event.kind}`,
      event,
    );
  });

  ipcMain.handle(
    "agent:focus-session",
    (_event, sessionId: string) => {
      const ptyId =
        agentActivity.getPtySessionId(sessionId);
      if (ptyId) {
        ctx.forwardToWebview(
          "terminal",
          "focus-tab",
          ptyId,
        );
      }
    },
  );

  // Viewer: run in terminal
  ipcMain.on(
    "viewer:run-in-terminal",
    (_event, command: string) => {
      ctx.forwardToWebview(
        "terminal",
        "run-in-terminal",
        command,
      );
    },
  );

  // JSON-RPC methods
  registerMethod(
    "agent.sessionStart",
    (params) => {
      const p = params as {
        session_id: string;
        cwd: string;
        pty_session_id?: string;
      };
      agentActivity.sessionStart(p);
      if (p.pty_session_id) {
        agentActivity.linkPtySession(
          p.session_id,
          p.pty_session_id,
        );
      }
      return { ok: true };
    },
    {
      description: "Register a new agent session",
      params: {
        session_id: "Unique session identifier",
        cwd: "Working directory of the agent",
        pty_session_id:
          "(optional) PTY session to link",
      },
    },
  );

  registerMethod(
    "agent.fileTouched",
    (params) => {
      const p = params as {
        session_id: string;
        tool_name: string;
        file_path: string | null;
      };
      agentActivity.fileTouched(p);
      return { ok: true };
    },
    {
      description:
        "Log a file read/write by an agent",
      params: {
        session_id: "Agent session identifier",
        tool_name: "Tool that accessed the file",
        file_path: "Absolute path to the file",
      },
    },
  );

  registerMethod(
    "agent.sessionEnd",
    (params) => {
      const p = params as { session_id: string };
      agentActivity.sessionEnd(p);
      return { ok: true };
    },
    {
      description: "End an agent session",
      params: {
        session_id: "Agent session identifier",
      },
    },
  );

  registerMethod(
    "app.notify",
    (params) => {
      const p = params as {
        title?: string;
        body: string;
      };
      const note = new Notification({
        title: p.title ?? "Collaborator",
        body: p.body,
      });
      note.show();
      return { ok: true };
    },
    {
      description: "Show a native macOS notification",
      params: {
        title:
          "(optional) Notification title, defaults to 'Collaborator'",
        body: "Notification body text",
      },
    },
  );
}
