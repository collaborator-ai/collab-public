import * as fs from "node:fs";
import * as path from "node:path";

// Electron app module — unavailable in unit tests.
// Lazy-loaded to avoid crashing bun test.
function getApp(): typeof import("electron").app | null {
  try {
    return require("electron").app;
  } catch {
    return null;
  }
}

function packagedResourcePath(...segments: string[]): string | null {
  const app = getApp();
  if (!app?.isPackaged) return null;
  const candidate = path.join(process.resourcesPath, ...segments);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Directory holding the bundled terminfo database (xterm-256color), or
 * undefined in dev where the system terminfo is used. Spawned shells receive
 * this as TERMINFO so packaged builds render true color without relying on the
 * host's terminfo entries.
 */
export function getTerminfoDir(): string | undefined {
  return packagedResourcePath("terminfo") ?? undefined;
}
