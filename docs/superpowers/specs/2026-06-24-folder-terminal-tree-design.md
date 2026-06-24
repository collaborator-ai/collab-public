# Folder-grouped terminal tree (sidebar)

## Summary

Replace the left sidebar's `Files` / `Tiles` segmented toggle with a single
tree view. The tree's roots are the user's workspace folders; the children of
each folder are the **terminal tiles** whose working directory lives inside that
folder. The tree shows nothing from the filesystem — no real files or
subdirectories — only folders the user has added and the terminals running
under them.

## Goals

- Single sidebar view: no `Files`/`Tiles` toggle.
- Roots = user-added workspace folders.
- Children = terminal tiles, grouped by `cwd` containment.
- Hide everything that doesn't fit: non-terminal tiles, and terminals whose
  `cwd` is outside every workspace folder.
- Folder and terminal actions: add/remove folder, new terminal under a folder,
  peek/focus/rename a terminal.

## Non-goals

- Drag-and-drop or reordering.
- Showing non-terminal tiles (note, code, image, graph, browser).
- Closing/deleting terminals from the tree (rename + create only).
- Any change to graph-tile or workspace-graph features.
- Removing the file-tree (`nav` window / `TreeView`) code — it stays in the
  codebase, used by other features, just unwired from the sidebar.

## Current state

- `src/windows/shell/index.html` — `#sidebar-mode-control` holds two buttons:
  `Files` (`data-mode="files"`) and `Tiles` (`data-mode="tiles"`).
- `src/windows/shell/src/renderer.js` — mounts two webviews in `#panel-nav`:
  the `nav` file-tree (Files mode) and the `tile-list` flat list (Tiles mode).
  `updateSidebarContent(mode)` toggles their visibility; the `.mode-btn` click
  handlers call `panelManager.setMode(...)`.
- `src/windows/shell/src/panel-manager.js` — `validModes = ["closed", "files",
  "tiles"]`, `prefKey = "sidebar-mode"`.
- `src/windows/tile-list/src/App.tsx` — flat list of all tiles. Receives
  `tile-list:init/add/update/remove/focus`. A term tile's `description` is its
  `cwd`. Click → `tile-list:peek-tile`, double-click → `tile-list:focus-tile`,
  right-click → rename → `tile-list:rename-tile`. Arrow keys move focus.
- Workspace plumbing (already exists):
  - Preload (`src/preload/shell.ts`): `workspaceAdd()` → `workspace:add`,
    `workspaceRemove(index)` → `workspace:remove`, `workspaceList()`,
    `onWorkspaceAdded`, `onWorkspaceRemoved`.
  - Shell forwards `workspace-init/added/removed` to the `nav` webview only.
- Terminal creation: shell renderer `createTile("term", cx, cy, { cwd, ...size })`.
- Shell handles `tile-list:*` host messages via the `tile-list` webview's
  `ipc-message` listener.
- `isSubpath(parent, child)` is available from `@collab/shared/path-utils`.

## Approach

Repurpose the `tile-list` window into the folder-grouped terminal tree. It
already owns the tile lifecycle stream and the peek/focus/rename interactions;
we layer folder grouping and workspace controls on top. The shell renderer
remains the hub.

### Window: `tile-list` → terminal tree

**Inputs**
- Existing tile stream: `tile-list:init/add/update/remove/focus`.
- New workspace stream: forward `workspace-init/added/removed` to this window
  (in addition to `nav`).

**Grouping (pure function, separately unit-tested)**

```
groupTerminals(folders: string[], tiles: TileEntry[]): FolderGroup[]
```

- Keep only tiles where `type === "term"`.
- A terminal's cwd comes from its `description`.
- Assign each terminal to the **deepest** folder `f` such that
  `f === cwd || isSubpath(f, cwd)`. Deepest = longest matching folder path, so
  nested folders don't double-list a terminal.
- Terminals matching no folder are dropped.
- Return one group per folder (in folder order), each with its child terminals.

**Rendering**
- Collapsible folder rows; expand state persisted via `getPref`/`setPref`
  under a key mirroring the existing `expanded_workspaces` pattern.
- Terminal child rows reuse the existing `TileEntryRow` (terminal icon, title,
  inline rename input).
- Empty folder: render the folder row with no children.
- Zero folders: an "Add a folder" empty state.

**Interactions**
- Terminal click → `tile-list:peek-tile` (existing).
- Terminal double-click → `tile-list:focus-tile` (existing).
- Terminal right-click → Rename → `tile-list:rename-tile` (existing).
- Folder `+` button → new host message `terminal-tree:new-terminal` with the
  folder path.
- Folder right-click → Remove → new host message `terminal-tree:remove-folder`
  with the folder path.
- Top-level "Add folder" button → new host message `terminal-tree:add-folder`.

Arrow-key navigation should walk visible terminal rows (folders are headers);
keep it simple — reuse the existing focus model over the flattened list of
visible terminals.

### Shell renderer (`renderer.js`)

- Forward `workspace-init/added/removed` to the `tile-list` webview as well as
  `nav`.
- Extend the `tile-list` webview `ipc-message` handler with three channels:
  - `terminal-tree:add-folder` → `window.shellApi.workspaceAdd()`.
  - `terminal-tree:remove-folder` (path) → resolve the path to its workspace
    index, then `window.shellApi.workspaceRemove(index)`.
  - `terminal-tree:new-terminal` (folderPath) → `createTile("term", cx, cy,
    { cwd: folderPath, ...size })` using the same placement logic as the
    existing new-terminal path.
- Remove the file-tree sidebar wiring: drop `updateSidebarContent`'s two-mode
  branching, stop mounting/toggling the `nav` file-tree webview in the sidebar,
  and make the terminal tree the sole sidebar view. The `nav` webview is no
  longer mounted in `#panel-nav`.

### Shell HTML (`index.html`)

- Remove `#sidebar-mode-control` (the `Files`/`Tiles` buttons).
- Add the top-level "Add folder" affordance to the nav toolbar (button that
  emits `terminal-tree:add-folder`, or routed through the window — final
  placement decided during implementation, keep it in the toolbar).

### Panel manager (`panel-manager.js`)

- Collapse sidebar modes to open/closed. `validModes` becomes
  `["closed", "open"]` (or equivalent); remove the `files`/`tiles` distinction
  and any now-dead mode-switch code. Preserve the open/closed persistence and
  the toggle shortcut behavior.

## Data flow

```
workspace add/remove ──┐
                       ▼
shell renderer (hub) ──► tile-list webview ──► groupTerminals() ──► tree UI
       ▲                      │
       │  ipc-message         │ tile-list:peek/focus/rename (existing)
       └── terminal-tree:add-folder / remove-folder / new-terminal
```

## Error handling

- `remove-folder` for a path with no matching workspace index: no-op (log).
- `new-terminal` for a folder that no longer exists: the existing terminal
  creation path already corrects an invalid cwd (notify-cwd-changed); rely on
  that, don't pre-validate.
- A term tile whose `description` isn't a path (e.g. transient state): it
  matches no folder and is simply not shown.

## Testing

- Unit test `groupTerminals()` as a pure function:
  - terminals nest under the containing folder;
  - nested folders → terminal lands under the deepest match (listed once);
  - non-term tiles excluded;
  - terminals outside all folders excluded;
  - cwd exactly equal to a folder path matches that folder;
  - empty folders return empty child lists.
- Manual: Playwright screenshot of the new sidebar (folders with terminal
  children, add-folder, +new-terminal, rename), saved under
  `collab-electron/screenshots/`.

## Files touched

- `src/windows/tile-list/src/App.tsx` — tree rendering + grouping + new actions.
- `src/windows/tile-list/src/` — new `groupTerminals` module + its test.
- `src/windows/shell/src/renderer.js` — workspace forwarding, new ipc channels,
  unwire file-tree from sidebar.
- `src/windows/shell/index.html` — remove segmented control, add-folder control.
- `src/windows/shell/src/panel-manager.js` — collapse modes to open/closed.
- Preload: reuse existing `workspaceAdd`/`workspaceRemove`/`createTile` paths;
  add the new host-message channels if any need preload exposure.
