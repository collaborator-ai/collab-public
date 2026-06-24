import { isSubpath, normalizePathForComparison } from "@collab/shared/path-utils";

export type TileType =
  | "term"
  | "note"
  | "code"
  | "image"
  | "graph"
  | "browser";

export interface TileEntry {
  id: string;
  type: TileType | string;
  title: string;
  /** For terminal tiles this is the working directory (cwd). */
  description: string;
  status: "running" | "exited" | "idle" | null;
}

export interface FolderGroup {
  folder: string;
  terminals: TileEntry[];
}

/**
 * Group terminal tiles under the workspace folders that contain them.
 *
 * Only `term` tiles are considered; their cwd comes from `description`. Each
 * terminal is assigned to the deepest folder that contains its cwd, so nested
 * folders never list the same terminal twice. Terminals whose cwd falls outside
 * every folder are dropped. Folders are returned in input order, including any
 * with no terminals.
 */
export function groupTerminals(
  folders: string[],
  tiles: TileEntry[],
): FolderGroup[] {
  const groups: FolderGroup[] = folders.map((folder) => ({
    folder,
    terminals: [],
  }));

  for (const tile of tiles) {
    if (tile.type !== "term") continue;
    const cwd = tile.description;
    if (!cwd) continue;

    let best: FolderGroup | null = null;
    let bestLength = -1;
    for (const group of groups) {
      if (!isSubpath(group.folder, cwd)) continue;
      const length = normalizePathForComparison(group.folder).length;
      if (length > bestLength) {
        bestLength = length;
        best = group;
      }
    }

    if (best) {
      best.terminals.push(tile);
    }
  }

  return groups;
}
