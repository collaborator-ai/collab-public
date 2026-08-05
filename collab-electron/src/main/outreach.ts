import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getFlagPayload, trackEvent } from "./analytics";
import {
  parseOutreachState,
  shouldShowOutreach,
  type OutreachState,
} from "./outreach-state";

const OUTREACH_FLAG = "power-user-outreach";
const OUTREACH_DELAY_MS = 15_000;

let calUrl: string | null = null;

function statePath(): string {
  return join(app.getPath("userData"), "outreach.json");
}

function readState(): OutreachState | null {
  try {
    return parseOutreachState(readFileSync(statePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state: OutreachState): void {
  const filePath = statePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state));
}

async function maybeShowOutreach(
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (!shouldShowOutreach(readState(), new Date())) return;

  let payload: unknown;
  try {
    payload = await getFlagPayload(OUTREACH_FLAG);
  } catch (err) {
    console.warn("[outreach] flag evaluation failed:", err);
    return;
  }
  if (typeof payload !== "object" || payload === null) return;
  const url = (payload as Record<string, unknown>).calUrl;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    console.warn("[outreach] flag payload has no valid calUrl");
    return;
  }

  const win = getWindow();
  if (!win || win.isDestroyed()) return;

  calUrl = url;
  win.webContents.send("outreach:show");
  trackEvent("outreach_modal_shown");
}

export function initOutreach(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("outreach:schedule", async () => {
    try {
      if (!calUrl) return;
      await shell.openExternal(calUrl);
      writeState({ status: "done" });
      trackEvent("outreach_scheduled");
    } catch (err) {
      console.warn("[outreach] schedule failed:", err);
    }
  });

  ipcMain.handle("outreach:snooze", () => {
    try {
      writeState({
        status: "snoozed",
        snoozedAt: new Date().toISOString(),
      });
      trackEvent("outreach_snoozed");
    } catch (err) {
      console.warn("[outreach] snooze failed:", err);
    }
  });

  setTimeout(() => {
    void maybeShowOutreach(getWindow);
  }, OUTREACH_DELAY_MS);
}
