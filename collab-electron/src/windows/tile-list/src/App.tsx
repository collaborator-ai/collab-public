import type { Icon } from "@phosphor-icons/react";
import {
  Terminal,
  Browser,
  ChartLineUp,
  Note,
  Code,
  Image,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

type TileType = "term" | "note" | "code" | "image" | "graph" | "browser";

interface TileEntry {
  id: string;
  type: TileType;
  title: string;
  description: string;
  status: "running" | "exited" | "idle" | null;
}

function isTileEntry(value: unknown): value is TileEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.type === "string" &&
    typeof e.title === "string" &&
    typeof e.description === "string"
  );
}

const TYPE_ICONS: Record<TileType, { icon: Icon; color: string }> = {
  term: { icon: Terminal, color: "#7aab6e" },
  browser: { icon: Browser, color: "#5c9bcf" },
  graph: { icon: ChartLineUp, color: "#c8a35a" },
  note: { icon: Note, color: "#8a7aab" },
  code: { icon: Code, color: "#7a8aab" },
  image: { icon: Image, color: "#c07a6e" },
};

function TileEntryRow({
  entry,
  focused,
  isRenaming,
  renameValue,
  onClick,
  onDoubleClick,
  onContextMenu,
  onRenameChange,
  onRenameConfirm,
  onRenameCancel,
}: {
  entry: TileEntry;
  focused: boolean;
  isRenaming: boolean;
  renameValue: string;
  onClick: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameChange: (value: string) => void;
  onRenameConfirm: () => void;
  onRenameCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.select();
    }
  }, [isRenaming]);

  return (
    <div
      className={`tile-entry${focused ? " focused" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="tile-icon">
        {(() => {
          const def = TYPE_ICONS[entry.type];
          const IconComp = def?.icon ?? Terminal;
          const color = def?.color ?? "#7a8aab";
          return <IconComp size={14} weight="regular" style={{ color }} />;
        })()}
      </div>
      {isRenaming ? (
        <input
          ref={inputRef}
          className="tile-rename-input"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRenameConfirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onRenameCancel();
            }
          }}
          onBlur={onRenameConfirm}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="tile-title">{entry.title}</div>
      )}
    </div>
  );
}

function App() {
  const [entries, setEntries] = useState<TileEntry[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    const cleanup = window.api.onTileListMessage(
      (channel: string, ...args: unknown[]) => {
        if (channel === "tile-list:init") {
          const tiles = Array.isArray(args[0])
            ? args[0].filter(isTileEntry)
            : [];
          setEntries(tiles);
        } else if (channel === "tile-list:add") {
          const tile = args[0];
          if (!isTileEntry(tile)) return;
          setEntries((prev) => [
            ...prev.filter((e) => e.id !== tile.id),
            tile,
          ]);
        } else if (channel === "tile-list:remove") {
          const id = args[0] as string;
          setEntries((prev) => prev.filter((e) => e.id !== id));
        } else if (channel === "tile-list:update") {
          const tile = args[0];
          if (!isTileEntry(tile)) return;
          setEntries((prev) =>
            prev.map((e) => (e.id === tile.id ? tile : e)),
          );
        } else if (channel === "tile-list:focus") {
          setFocusedId(args[0] as string | null);
        }
      },
    );

    return () => {
      cleanup();
    };
  }, []);

  const handleClick = useCallback((id: string) => {
    setFocusedId(id);
    window.api.sendToHost("tile-list:peek-tile", id);
  }, []);

  const handleDoubleClick = useCallback((id: string) => {
    setFocusedId(id);
    window.api.sendToHost("tile-list:focus-tile", id);
  }, []);

  const handleContextMenu = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.preventDefault();
      const selected = await window.api.showContextMenu([
        { id: "rename", label: "Rename" },
      ]);
      if (selected === "rename") {
        const entry = entries.find((en) => en.id === id);
        if (entry) {
          setRenameValue(entry.title);
          setRenamingId(id);
        }
      }
    },
    [entries],
  );

  const commitRename = useCallback(
    (id: string) => {
      const trimmed = renameValue.trim();
      window.api.sendToHost("tile-list:rename-tile", id, trimmed);
      setRenamingId(null);
      setRenameValue("");
    },
    [renameValue],
  );

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue("");
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (renamingId) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (entries.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const currentIdx = entries.findIndex((entry) => entry.id === focusedId);
      const nextIdx =
        currentIdx < 0
          ? 0
          : (currentIdx + dir + entries.length) % entries.length;
      handleClick(entries[nextIdx].id);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [entries, focusedId, handleClick, renamingId]);

  return (
    <div className="tile-list">
      {entries.map((entry) => (
        <TileEntryRow
          key={entry.id}
          entry={entry}
          focused={entry.id === focusedId}
          isRenaming={entry.id === renamingId}
          renameValue={entry.id === renamingId ? renameValue : ""}
          onClick={() => handleClick(entry.id)}
          onDoubleClick={() => handleDoubleClick(entry.id)}
          onContextMenu={(e) => handleContextMenu(entry.id, e)}
          onRenameChange={setRenameValue}
          onRenameConfirm={() => commitRename(entry.id)}
          onRenameCancel={cancelRename}
        />
      ))}
      {entries.length === 0 && (
        <div className="tile-empty">
          No tiles on canvas
        </div>
      )}
    </div>
  );
}

export default App;
