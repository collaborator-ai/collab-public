import {
  CaretDown,
  CaretRight,
  FolderSimple,
  Plus,
  Terminal,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { displayBasename } from "@collab/shared/path-utils";
import { groupTerminals } from "./group-terminals";
import type { TileEntry } from "./group-terminals";
import "./App.css";

const TERM_COLOR = "#7aab6e";
const COLLAPSED_PREF_KEY = "terminal_tree_collapsed";

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

function TerminalRow({
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
      className={`tile-entry term-row${focused ? " focused" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="tile-icon">
        <Terminal size={14} weight="regular" style={{ color: TERM_COLOR }} />
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

function FolderRow({
  folder,
  collapsed,
  onToggle,
  onNewTerminal,
  onContextMenu,
}: {
  folder: string;
  collapsed: boolean;
  onToggle: () => void;
  onNewTerminal: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="folder-row" onClick={onToggle} onContextMenu={onContextMenu}>
      <div className="folder-caret">
        {collapsed ? (
          <CaretRight size={12} weight="bold" />
        ) : (
          <CaretDown size={12} weight="bold" />
        )}
      </div>
      <div className="tile-icon">
        <FolderSimple size={14} weight="regular" />
      </div>
      <div className="folder-name">{displayBasename(folder)}</div>
      <button
        type="button"
        className="folder-add"
        aria-label="New terminal here"
        title="New terminal here"
        onClick={(e) => {
          e.stopPropagation();
          onNewTerminal();
        }}
      >
        <Plus size={12} weight="bold" />
      </button>
    </div>
  );
}

function App() {
  const [entries, setEntries] = useState<TileEntry[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    window.api
      .getPref(COLLAPSED_PREF_KEY)
      .then((value: unknown) => {
        if (Array.isArray(value)) {
          setCollapsed(new Set(value.filter((p): p is string => typeof p === "string")));
        }
      })
      .catch(() => {});
  }, []);

  const persistCollapsed = useCallback((next: Set<string>) => {
    window.api.setPref(COLLAPSED_PREF_KEY, [...next]);
  }, []);

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
          setEntries((prev) => [...prev.filter((e) => e.id !== tile.id), tile]);
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
        } else if (channel === "workspace-init") {
          const list = Array.isArray(args[0])
            ? args[0].filter((p): p is string => typeof p === "string")
            : [];
          setFolders(list);
        } else if (channel === "workspace-added") {
          const path = args[0];
          if (typeof path !== "string") return;
          setFolders((prev) =>
            prev.includes(path) ? prev : [...prev, path],
          );
        } else if (channel === "workspace-removed") {
          const path = args[0];
          if (typeof path !== "string") return;
          setFolders((prev) => prev.filter((p) => p !== path));
        }
      },
    );

    return () => {
      cleanup();
    };
  }, []);

  const groups = useMemo(
    () => groupTerminals(folders, entries),
    [folders, entries],
  );

  const visibleTerminals = useMemo(
    () =>
      groups
        .filter((g) => !collapsed.has(g.folder))
        .flatMap((g) => g.terminals),
    [groups, collapsed],
  );

  const handleClick = useCallback((id: string) => {
    setFocusedId(id);
    window.api.sendToHost("tile-list:peek-tile", id);
  }, []);

  const handleDoubleClick = useCallback((id: string) => {
    setFocusedId(id);
    window.api.sendToHost("tile-list:focus-tile", id);
  }, []);

  const toggleFolder = useCallback(
    (folder: string) => {
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(folder)) {
          next.delete(folder);
        } else {
          next.add(folder);
        }
        persistCollapsed(next);
        return next;
      });
    },
    [persistCollapsed],
  );

  const handleTerminalContextMenu = useCallback(
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

  const handleNewTerminal = useCallback((folder: string) => {
    window.api.sendToHost("terminal-tree:new-terminal", folder);
  }, []);

  const handleFolderContextMenu = useCallback(
    async (folder: string, e: React.MouseEvent) => {
      e.preventDefault();
      const selected = await window.api.showContextMenu([
        { id: "new-terminal", label: "New terminal here" },
        { id: "remove", label: "Remove folder" },
      ]);
      if (selected === "new-terminal") {
        handleNewTerminal(folder);
      } else if (selected === "remove") {
        window.api.sendToHost("terminal-tree:remove-folder", folder);
      }
    },
    [handleNewTerminal],
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
      if (visibleTerminals.length === 0) return;
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? -1 : 1;
      const currentIdx = visibleTerminals.findIndex(
        (entry) => entry.id === focusedId,
      );
      const nextIdx =
        currentIdx < 0
          ? 0
          : (currentIdx + dir + visibleTerminals.length) %
            visibleTerminals.length;
      const next = visibleTerminals[nextIdx];
      if (next) handleClick(next.id);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visibleTerminals, focusedId, handleClick, renamingId]);

  return (
    <div className="terminal-tree">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.folder);
        return (
          <div key={group.folder} className="folder-group">
            <FolderRow
              folder={group.folder}
              collapsed={isCollapsed}
              onToggle={() => toggleFolder(group.folder)}
              onNewTerminal={() => handleNewTerminal(group.folder)}
              onContextMenu={(e) => handleFolderContextMenu(group.folder, e)}
            />
            {!isCollapsed &&
              group.terminals.map((entry) => (
                <TerminalRow
                  key={entry.id}
                  entry={entry}
                  focused={entry.id === focusedId}
                  isRenaming={entry.id === renamingId}
                  renameValue={entry.id === renamingId ? renameValue : ""}
                  onClick={() => handleClick(entry.id)}
                  onDoubleClick={() => handleDoubleClick(entry.id)}
                  onContextMenu={(e) => handleTerminalContextMenu(entry.id, e)}
                  onRenameChange={setRenameValue}
                  onRenameConfirm={() => commitRename(entry.id)}
                  onRenameCancel={cancelRename}
                />
              ))}
          </div>
        );
      })}
      {folders.length === 0 && (
        <button
          type="button"
          className="tree-add-folder"
          onClick={() => window.api.sendToHost("terminal-tree:add-folder")}
        >
          <Plus size={13} weight="bold" />
          Add a folder
        </button>
      )}
      {folders.length > 0 && (
        <button
          type="button"
          className="tree-add-folder subtle"
          onClick={() => window.api.sendToHost("terminal-tree:add-folder")}
        >
          <Plus size={13} weight="bold" />
          Add folder
        </button>
      )}
    </div>
  );
}

export default App;
