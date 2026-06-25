import * as fs from "node:fs";
import * as path from "node:path";
import { COLLAB_DIR } from "./paths";

export interface SessionMeta {
  shell: string;
  cwd: string;
  createdAt: string;
  target?: string;
  displayName?: string;
  command?: string;
  args?: string[];
  claudeSessionId?: string;
  cwdHostPath?: string;
  cwdGuestPath?: string;
}

export const SESSION_DIR = path.join(COLLAB_DIR, "terminal-sessions");

function ensureSessionDir(): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function metaPath(sessionId: string): string {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

export function writeSessionMeta(
  sessionId: string,
  meta: SessionMeta,
): void {
  ensureSessionDir();
  fs.writeFileSync(metaPath(sessionId), JSON.stringify(meta));
}

export function readSessionMeta(
  sessionId: string,
): SessionMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(sessionId), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }
}

export function deleteSessionMeta(sessionId: string): void {
  try {
    fs.unlinkSync(metaPath(sessionId));
  } catch {
    // no-op if file doesn't exist
  }
}
