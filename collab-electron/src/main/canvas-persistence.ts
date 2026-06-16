import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";
import { COLLAB_DIR } from "./paths";

const STATE_DIR = COLLAB_DIR;
const STATE_FILE = join(STATE_DIR, "canvas-state.json");

interface TileState {
  id: string;
  type: "term" | "note" | "code" | "image" | "graph" | "browser";
  x: number;
  y: number;
  width: number;
  height: number;
  filePath?: string;
  folderPath?: string;
  url?: string | null;
  workspacePath?: string;
  ptySessionId?: string;
  userTitle?: string;
  autoTitle?: string;
  zIndex: number;
}

type AnnotationState =
  | { id: string; type: "rect"; x: number; y: number; width: number; height: number; color: string }
  | { id: string; type: "text"; x: number; y: number; content: string; fontSize: number; color: string }
  | { id: string; type: "line"; mode: "free"; x1: number; y1: number; x2: number; y2: number; color: string }
  | { id: string; type: "line"; mode: "connected"; fromTileId: string; toTileId: string; color: string };

interface CanvasState {
  version: 1;
  tiles: TileState[];
  annotations?: AnnotationState[];
  viewport: {
    centerX: number;
    centerY: number;
    zoom: number;
  };
}

function sanitizeCoord(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function loadState(): Promise<CanvasState | null> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as CanvasState;
    if (state.version !== 1) return null;
    for (const tile of state.tiles) {
      tile.x = sanitizeCoord(tile.x);
      tile.y = sanitizeCoord(tile.y);
    }
    return state;
  } catch {
    return null;
  }
}

export async function saveState(state: CanvasState): Promise<void> {
  if (!existsSync(STATE_DIR)) {
    await mkdir(STATE_DIR, { recursive: true });
  }
  const tmp = join(
    tmpdir(),
    `canvas-state-${crypto.randomUUID()}.json`,
  );
  const json = JSON.stringify(state, null, 2);
  await writeFile(tmp, json, "utf-8");
  await rename(tmp, STATE_FILE);
}
