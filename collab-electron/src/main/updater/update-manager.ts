import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import { trackEvent } from "../analytics";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  progress?: number;
  version?: string;
  releaseNotes?: string;
  error?: string;
}

/** True when `offered` is a genuine upgrade over `current` (semver). */
export function isNewer(offered: string, current: string): boolean {
  const parse = (v: string) =>
    v.replace(/-.+$/, "").split(".").map(Number);
  const [oMaj = 0, oMin = 0, oPat = 0] = parse(offered);
  const [cMaj = 0, cMin = 0, cPat = 0] = parse(current);
  if (oMaj !== cMaj) return oMaj > cMaj;
  if (oMin !== cMin) return oMin > cMin;
  if (oPat !== cPat) return oPat > cPat;
  // Same major.minor.patch: stable release is newer than a pre-release.
  return !offered.includes("-") && current.includes("-");
}

const ERROR_RESET_DELAY_MS = 30_000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 5_000;

function isMissingReleaseMetadataError(message: string): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  return /Cannot find latest-linux\.yml in the latest release artifacts/i.test(
    message,
  );
}

class UpdateManager {
  private state: UpdateState = { status: "idle" };
  private initialized = false;
  private errorResetTimeout: NodeJS.Timeout | null = null;
  private checkInterval: NodeJS.Timeout | null = null;
  private onBeforeQuit: (() => Promise<void>) | null = null;
  private allowPrerelease = false;

  private shouldIgnoreMissingReleaseMetadataError(message: string): boolean {
    if (!isMissingReleaseMetadataError(message)) {
      return false;
    }
    this.setState({ status: "idle", error: undefined });
    return true;
  }

  init(opts?: { onBeforeQuit?: () => Promise<void>; allowPrerelease?: boolean }): void {
    if (this.initialized) return;
    this.onBeforeQuit = opts?.onBeforeQuit ?? null;
    this.allowPrerelease = opts?.allowPrerelease ?? false;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = this.allowPrerelease;

    // Per-platform/arch update channels so each build gets its own yml file.
    // Mac: latest-arm64-mac.yml / latest-x64-mac.yml
    // Win: latest-win.yml
    if (process.platform === "darwin") {
      autoUpdater.channel = `latest-${process.arch}`;
    } else if (process.platform === "win32") {
      autoUpdater.channel = "latest-win";
    }

    autoUpdater.logger = {
      info: (msg: string) => console.log(`[updater] ${msg}`),
      warn: (msg: string) => console.warn(`[updater] ${msg}`),
      error: (msg: string) => {
        if (isMissingReleaseMetadataError(msg)) {
          console.warn("[updater] Release metadata missing; skipping update check");
          return;
        }
        console.error(`[updater] ${msg}`);
      },
      debug: (msg: string) => console.debug(`[updater] ${msg}`),
    };

    autoUpdater.on("checking-for-update", () => {
      this.setState({ status: "checking" });
    });

    autoUpdater.on("update-available", (info) => {
      // Guard against downgrades: a pre-release build (e.g. 0.7.0-beta.1)
      // may see a stable release with a lower version (e.g. 0.6.1) in the
      // update YAML and incorrectly offer it as an update.
      const current = app.getVersion();
      if (!isNewer(info.version, current)) {
        console.log(
          `[updater] Ignoring ${info.version} — not newer than ${current}`,
        );
        this.setState({ status: "idle" });
        return;
      }

      const releaseNotes =
        typeof info.releaseNotes === "string"
          ? info.releaseNotes
          : undefined;
      this.setState({
        status: "available",
        version: info.version,
        releaseNotes,
      });
      trackEvent("update_available", { version: info.version });
    });

    autoUpdater.on("update-not-available", () => {
      this.setState({ status: "idle" });
    });

    autoUpdater.on("download-progress", (progress) => {
      this.setState({
        status: "downloading",
        progress: Math.round(progress.percent),
      });
    });

    autoUpdater.on("update-downloaded", (info) => {
      const releaseNotes =
        typeof info.releaseNotes === "string"
          ? info.releaseNotes
          : undefined;
      this.setState({
        status: "ready",
        version: info.version,
        releaseNotes,
      });
      trackEvent("update_downloaded", { version: info.version });
    });

    autoUpdater.on("error", (err) => {
      if (this.shouldIgnoreMissingReleaseMetadataError(err.message)) {
        return;
      }
      trackEvent("update_download_failed", { error: err.message });
      this.handleError(err.message);
    });

    if (app.isPackaged) {
      setTimeout(() => this.checkForUpdates(), INITIAL_CHECK_DELAY_MS);
      this.checkInterval = setInterval(
        () => this.checkForUpdates(),
        CHECK_INTERVAL_MS,
      );
      powerMonitor.on("resume", () => this.checkForUpdates());
    } else {
      autoUpdater.forceDevUpdateConfig = true;
    }

    this.initialized = true;
  }

  async checkForUpdates(): Promise<void> {
    const s = this.state.status;
    if (s === "checking" || s === "downloading") return;
    if (s === "available" || s === "ready") return;

    if (s === "error") this.clearErrorTimeout();

    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      const message = (err as Error).message;
      if (this.shouldIgnoreMissingReleaseMetadataError(message)) {
        return;
      }
      this.handleError(message);
    }
  }

  async downloadAvailableUpdate(): Promise<void> {
    if (this.state.status !== "available") return;

    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      this.handleError((err as Error).message);
    }
  }

  async install(): Promise<void> {
    if (this.state.status !== "ready") return;

    this.setState({ status: "installing", version: this.state.version });
    trackEvent("update_installing", { version: this.state.version });

    if (!app.isPackaged) return;

    // MacUpdater.quitAndInstall() uses the native Squirrel updater,
    // which terminates the process without firing before-quit. Run
    // cleanup explicitly so PTY sessions, watchers, and servers are
    // shut down on every platform.
    if (this.onBeforeQuit) {
      await this.onBeforeQuit();
    }

    autoUpdater.quitAndInstall();
  }

  setAllowPrerelease(allow: boolean): void {
    this.allowPrerelease = allow;
    autoUpdater.allowPrerelease = allow;
    // Reset stale update state so the new channel is evaluated fresh.
    if (this.state.status === "available" || this.state.status === "error") {
      this.setState({ status: "idle", error: undefined, version: undefined });
    }
    void this.checkForUpdates();
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  destroy(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.clearErrorTimeout();
  }

  private handleError(message: string): void {
    this.setState({ status: "error", error: message });
    this.scheduleErrorReset();
  }

  private clearErrorTimeout(): void {
    if (this.errorResetTimeout) {
      clearTimeout(this.errorResetTimeout);
      this.errorResetTimeout = null;
    }
  }

  private scheduleErrorReset(): void {
    this.clearErrorTimeout();
    this.errorResetTimeout = setTimeout(() => {
      if (this.state.status === "error") {
        this.setState({ status: "idle", error: undefined });
      }
      this.errorResetTimeout = null;
    }, ERROR_RESET_DELAY_MS);
  }

  private setState(newState: Partial<UpdateState>): void {
    this.state = { ...this.state, ...newState };
    this.broadcast();
  }

  private broadcast(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("update:status", this.state);
      }
    }
  }
}

export const updateManager = new UpdateManager();

export function setupUpdateIPC(): void {
  ipcMain.handle("update:getStatus", () => updateManager.getState());

  ipcMain.handle("update:check", async () => {
    await updateManager.checkForUpdates();
    return updateManager.getState();
  });

  ipcMain.handle("update:download", async () => {
    await updateManager.downloadAvailableUpdate();
    return updateManager.getState();
  });

  ipcMain.on("update:install", async () => {
    await updateManager.install();
  });

  ipcMain.handle("update:setChannel", (_event, channel: string) => {
    updateManager.setAllowPrerelease(channel === "early-access");
    return updateManager.getState();
  });
}
