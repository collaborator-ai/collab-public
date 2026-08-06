import { ipcMain, shell, type BrowserWindow } from "electron";
import { getDeviceId, getFlagPayload, trackEvent } from "./analytics";

const OUTREACH_FLAG = "power-user-outreach";

let calUrl: string | null = null;

// All outreach state lives in PostHog: the flag's release conditions
// exclude persons whose outreach_status / outreach_snoozed_at properties
// (written via $set below) say done or recently snoozed. The app just
// evaluates the flag.
async function maybeShowOutreach(
  getWindow: () => BrowserWindow | null,
): Promise<void> {
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
  // The renderer registers its outreach listener while the page loads;
  // sending before that silently drops the message.
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.webContents.send("outreach:show");
      trackEvent("outreach_modal_shown");
    });
    return;
  }
  win.webContents.send("outreach:show");
  trackEvent("outreach_modal_shown");
}

export function initOutreach(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("outreach:schedule", async () => {
    try {
      if (!calUrl) return;
      // Attach the PostHog device ID so cal.com's webhook payload can
      // join the booking back to product usage.
      const bookingUrl = new URL(calUrl);
      bookingUrl.searchParams.set("metadata[posthogId]", getDeviceId());
      await shell.openExternal(bookingUrl.toString());
      trackEvent("outreach_scheduled", {
        $set: { outreach_status: "done" },
      });
    } catch (err) {
      console.warn("[outreach] schedule failed:", err);
    }
  });

  ipcMain.handle("outreach:snooze", () => {
    try {
      trackEvent("outreach_snoozed", {
        $set: { outreach_snoozed_at: new Date().toISOString() },
      });
    } catch (err) {
      console.warn("[outreach] snooze failed:", err);
    }
  });

  void maybeShowOutreach(getWindow);
}
