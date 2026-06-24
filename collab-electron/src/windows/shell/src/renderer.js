import "./shell.css";
import "./tooltip.js";
import {
	tiles, getTile, defaultSize, inferTileType, tileAtPoint,
	selectTile, clearSelection, getSelectedTiles, getNearestTileInDirection,
} from "./canvas-state.js";
import { attachMarquee } from "./tile-interactions.js";
import { initDarkMode, applyCanvasOpacity } from "./dark-mode.js";
import { createWebview, isFocusSearchShortcut } from "./webview-factory.js";
import { createViewport } from "./canvas-viewport.js";
import { createEdgeIndicators } from "./edge-indicators.js";
import { createMinimap } from "./canvas-minimap.js";
import { createPanel } from "./panel-manager.js";
import { createWorkspaceManager } from "./workspace-manager.js";
import { createCanvasRpc } from "./canvas-rpc.js";
import { createTileManager } from "./tile-manager.js";
import { updateTileTitle, getTileLabel } from "./tile-renderer.js";

const CANVAS_DBLCLICK_SUPPRESS_MS = 500;
const IS_WINDOWS = window.shellApi.getPlatform() === "win32";

const viewportState = { panX: 0, panY: 0, zoom: 1 };

const canvasEl = document.getElementById("panel-viewer");
const gridCanvas = document.getElementById("grid-canvas");
canvasEl.tabIndex = -1;

document.documentElement.classList.toggle("platform-win", IS_WINDOWS);
document.body.classList.toggle("platform-win", IS_WINDOWS);

// -- Alpha banner dismiss --

document.getElementById("alpha-dismiss").addEventListener("click", (e) => {
	e.preventDefault();
	document.getElementById("alpha-label").hidden = true;
});

// -- Dark mode --

initDarkMode(() => viewport.updateCanvas());

let broadcastCanvasOpacity = () => {};
const DEFAULT_CANVAS_OPACITY = 50;
let lastCanvasOpacity = DEFAULT_CANVAS_OPACITY;

window.shellApi.getPref("canvasOpacity").then((v) => {
	lastCanvasOpacity = v != null ? v : DEFAULT_CANVAS_OPACITY;
	applyCanvasOpacity(lastCanvasOpacity);
	broadcastCanvasOpacity();
});

window.shellApi.onPrefChanged((key, value) => {
	if (key === "canvasOpacity") {
		lastCanvasOpacity = value;
		applyCanvasOpacity(value);
		broadcastCanvasOpacity();
	}
});

// -- Viewport --

const viewport = createViewport(canvasEl, gridCanvas, tiles);

/** Convert in-memory panX/panY state to a center-point for persistence. */
function toCenterPointState(state) {
	const { panX, panY, zoom } = state.viewport;
	const w = canvasEl.clientWidth;
	const h = canvasEl.clientHeight;
	return {
		...state,
		viewport: {
			centerX: (w / 2 - panX) / zoom,
			centerY: (h / 2 - panY) / zoom,
			zoom,
		},
	};
}

// -- Init --

async function init() {
	const [
		configs, workspaceData,
		prefNavWidth, prefSidebarMode,
		prefAgentWidth, prefAgentMode,
		prefAgentPty, prefSidebarAgentGui,
		prefLastTerminalCwd,
		prefLastTerminalSize,
	] = await Promise.all([
		window.shellApi.getViewConfig(),
		window.shellApi.workspaceList(),
		window.shellApi.getPref("panel-width-nav"),
		window.shellApi.getPref("sidebar-mode"),
		window.shellApi.getPref("panel-width-agent"),
		window.shellApi.getPref("sidebar-mode-agent"),
		window.shellApi.getPref("agent-pty-session"),
		window.shellApi.getPref("sidebar-agent-gui"),
		window.shellApi.getPref("lastTerminalCwd"),
		window.shellApi.getPref("lastTerminalSize"),
	]);

	let lastTerminalCwd = prefLastTerminalCwd || null;
	let lastTerminalSize = prefLastTerminalSize || null;

	function getTerminalCwd() {
		return lastTerminalCwd || workspaceData.workspaces[0];
	}

	function setLastTerminalCwd(cwd) {
		lastTerminalCwd = cwd;
		window.shellApi.setPref("lastTerminalCwd", cwd);
	}

	function getTerminalSize() {
		if (lastTerminalSize) return { ...lastTerminalSize };
		return defaultSize("term");
	}

	function setLastTerminalSize(width, height) {
		lastTerminalSize = { width, height };
		window.shellApi.setPref("lastTerminalSize", lastTerminalSize);
	}

	// DOM elements
	const panelNav = document.getElementById("panel-nav");
	const panelViewer = document.getElementById("panel-viewer");
	const navResizeHandle = document.getElementById("nav-resize");
	const navToggle = document.getElementById("nav-toggle");
	const settingsOverlay =
		document.getElementById("settings-overlay");
	const settingsBackdrop =
		document.getElementById("settings-backdrop");
	const settingsModal = document.getElementById("settings-modal");
	const newTileBtn = document.getElementById("new-tile-btn");
	const settingsBtn = document.getElementById("settings-btn");
	const updatePill = document.getElementById("update-pill");
	const dragDropOverlay =
		document.getElementById("drag-drop-overlay");
	const loadingOverlay =
		document.getElementById("loading-overlay");
	const loadingStatusEl =
		document.getElementById("loading-status");
	const tileLayer = document.getElementById("tile-layer");
	const panelAgent = document.getElementById("panel-agent");
	const agentResizeHandle = document.getElementById("agent-resize");
	const agentToggle = document.getElementById("agent-toggle");

	// -- State --

	let dragCounter = 0;
	let settingsModalOpen = false;
	let activeSurface = "canvas";
	let lastNonModalSurface = "canvas";
	let shiftHeld = false;
	let spaceHeld = false;
	let isPanning = false;
	let suppressCanvasDblClickUntil = 0;

	// -- Drag-and-drop handler (shared with webviews) --

	function handleDndMessage(channel) {
		if (channel === "dnd:dragenter") {
			dragCounter++;
			if (dragCounter === 1 && dragDropOverlay) {
				dragDropOverlay.classList.add("visible");
				for (const h of getAllWebviews()) {
					h.webview.style.pointerEvents = "none";
				}
			}
		} else if (channel === "dnd:dragleave") {
			dragCounter = Math.max(0, dragCounter - 1);
			if (dragCounter === 0 && dragDropOverlay) {
				dragDropOverlay.classList.remove("visible");
			}
		} else if (channel === "dnd:drop") {
			dragCounter = 0;
			if (dragDropOverlay) {
				dragDropOverlay.classList.remove("visible");
			}
			for (const h of getAllWebviews()) {
				h.webview.style.pointerEvents = "";
			}
		}
	}

	// -- Singleton webviews --

	const singletonViewer = createWebview(
		"viewer", configs.viewer, panelViewer, handleDndMessage,
	);
	singletonViewer.webview.style.display = "none";
	singletonViewer.webview.addEventListener("focus", () => {
		noteSurfaceFocus("viewer");
	});
	singletonViewer.setBeforeInput((event, detail) => {
		if (!isFocusSearchShortcut(detail)) return;
		event.preventDefault();
		handleShortcut("focus-file-search");
	});

	const singletonWebviews = {
		settings: createWebview(
			"settings", configs.settings,
			settingsModal, handleDndMessage,
		),
	};
	singletonWebviews.settings.webview.addEventListener("focus", () => {
		noteSurfaceFocus("settings");
	});

	// -- Panel manager --

	const panelManager = createPanel("nav", {
		panel: panelNav,
		resizeHandle: navResizeHandle, toggle: navToggle,
		label: "Navigator",
		defaultWidth: 280,
		direction: 1,
		validModes: ["closed", "open"],
		prefKey: "sidebar-mode",
		getAllWebviews,
		onVisibilityChanged(visible) {
			panelViewer.classList.toggle("nav-open", visible);
			if (visible) {
				requestAnimationFrame(() => {
					singletonViewer.send("nav-visibility", true);
				});
			} else {
				singletonViewer.send("nav-visibility", false);
				canvasEl.focus();
			}
		},
	});
	panelManager.initPrefs(prefNavWidth, prefSidebarMode);

	const useAgentGui = prefSidebarAgentGui === true;
	let agentWebview = null;

	let agentPtySessionId = prefAgentPty || null;

	function ensureAgentTerminal() {
		if (agentWebview) return;

		const termConfig = configs.terminalTile;
		const params = new URLSearchParams();
		params.set("tileId", "agent");

		if (agentPtySessionId) {
			params.set("sessionId", agentPtySessionId);
			params.set("restored", "1");
		} else {
			const homeDir = window.shellApi.getHomePath?.() || "~";
			params.set("cwd", `${homeDir}/.collaborator`);
		}

		const qs = params.toString();
		const wv = document.createElement("webview");
		wv.setAttribute(
			"src", `${termConfig.src}?${qs}`,
		);
		wv.setAttribute("preload", termConfig.preload);
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.classList.add("agent-terminal");
		wv.style.flex = "1";
		wv.style.border = "none";

		wv.addEventListener("dom-ready", () => {
			if (agentPanel.isVisible()) {
				wv.focus();
				noteSurfaceFocus("agent");
			}
		});

		wv.addEventListener("ipc-message", (event) => {
			if (event.channel === "pty-session-id") {
				agentPtySessionId = event.args[0];
				window.shellApi.setPref(
					"agent-pty-session", agentPtySessionId,
				);
			}
		});

		wv.addEventListener("console-message", (event) => {
			window.shellApi.logFromWebview(
				"agent-term", event.level,
				event.message, event.sourceId,
			);
		});

		wv.addEventListener("focus", () => {
			noteSurfaceFocus("agent");
		});

		panelAgent.appendChild(wv);
		agentWebview = {
			webview: wv,
			send(ch, ...args) { wv.send(ch, ...args); },
		};
	}

	function ensureAgentChat() {
		if (agentWebview) return;

		const chatConfig = configs.agentChat;
		const homeDir = window.shellApi.getHomePath?.() || "~";
		const cwd = `${homeDir}/.collaborator`;
		const src = `${chatConfig.src}?cwd=${encodeURIComponent(cwd)}`;
		const wv = document.createElement("webview");
		wv.setAttribute("src", src);
		wv.setAttribute("preload", chatConfig.preload);
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.style.flex = "1";
		wv.style.border = "none";

		let ready = false;
		const pendingMessages = [];

		wv.addEventListener("dom-ready", () => {
			ready = true;
			for (const [ch, args] of pendingMessages) {
				wv.send(ch, ...args);
			}
			pendingMessages.length = 0;
			if (agentPanel.isVisible()) {
				wv.focus();
				noteSurfaceFocus("agent");
			}
		});

		wv.addEventListener("console-message", (event) => {
			window.shellApi.logFromWebview(
				"agent-chat", event.level,
				event.message, event.sourceId,
			);
		});

		wv.addEventListener("focus", () => {
			noteSurfaceFocus("agent");
		});

		panelAgent.appendChild(wv);
		agentWebview = {
			webview: wv,
			send(ch, ...args) {
				if (ready) wv.send(ch, ...args);
				else pendingMessages.push([ch, args]);
			},
		};

		// Forward agent IPC from shell to the chat webview
		window.shellApi.onAgentUpdate((data) => {
			agentWebview.send("agent:update", data);
		});
		window.shellApi.onAgentPromptComplete((data) => {
			agentWebview.send(
				"agent:prompt-complete", data,
			);
		});
		window.shellApi.onAgentPromptError((data) => {
			agentWebview.send(
				"agent:prompt-error", data,
			);
		});
		window.shellApi.onAgentExit((data) => {
			agentWebview.send("agent:exit", data);
		});
		window.shellApi.onAgentSessionReady((data) => {
			agentWebview.send(
				"agent:session-ready", data,
			);
		});
		window.shellApi.onAgentSessionFailed((data) => {
			agentWebview.send(
				"agent:session-failed", data,
			);
		});
	}

	const agentPanel = createPanel("agent", {
		panel: panelAgent,
		resizeHandle: agentResizeHandle,
		toggle: agentToggle,
		label: "Agent",
		defaultWidth: 400,
		direction: -1,
		validModes: ["closed", "open"],
		defaultMode: "closed",
		prefKey: "sidebar-mode-agent",
		getAllWebviews,
		onVisibilityChanged(visible) {
			panelViewer.classList.toggle("agent-open", visible);
			if (visible) {
				if (useAgentGui) ensureAgentChat();
				else ensureAgentTerminal();
				if (agentWebview) {
					agentWebview.webview.focus();
					noteSurfaceFocus("agent");
				}
			} else {
				canvasEl.focus();
			}
		},
	});
	// agentPanel.initPrefs deferred until after tileManager (getAllWebviews references it)

	function syncTerminalTileMeta(tile, meta) {
		if (!meta) return;
		tile.cwd = meta.cwdHostPath || meta.cwd || tile.cwd;
		tile.autoTitle = meta.cwdHostPath || meta.cwd || tile.autoTitle;
		const dom = tileManager.getTileDOMs().get(tile.id);
		if (dom) {
			updateTileTitle(dom, tile);
		}
	}

	function buildTileListEntry(tile) {
		let title = tile.id;
		let description = "";
		let status = null;

		if (tile.type === "term") {
			const label = getTileLabel(tile);
			title = label.parent
				? label.parent + label.name
				: label.name;
			description = tile.cwd || tile.autoTitle || "~";
			status = tile.ptySessionId ? "running" : "idle";
		} else if (tile.type === "browser") {
			title = tile.url || "Browser";
			description = "Browser";
		} else if (tile.type === "graph") {
			title = "Graph";
			description = tile.folderPath || "Graph";
		} else if (tile.type === "note") {
			title = tile.filePath
				? tile.filePath.split("/").pop() || "Note"
				: "Note";
			description = "Note";
		} else if (tile.type === "code") {
			title = tile.filePath
				? tile.filePath.split("/").pop() || "Code"
				: "Code";
			description = "Code";
		} else if (tile.type === "image") {
			title = tile.filePath
				? tile.filePath.split("/").pop() || "Image"
				: "Image";
			description = "Image";
		}

		return {
			id: tile.id, type: tile.type,
			title, description, status,
		};
	}

	// -- File tree webview --

	const fileTreeContainer = document.createElement("div");
	fileTreeContainer.id = "file-tree-container";
	fileTreeContainer.style.display = "flex";
	fileTreeContainer.style.flex = "1";
	fileTreeContainer.style.minHeight = "0";
	panelNav.appendChild(fileTreeContainer);
	const navWebview = createWebview(
		"nav", configs.nav, fileTreeContainer, handleDndMessage,
	);
	navWebview.webview.addEventListener("focus", () => {
		noteSurfaceFocus("nav");
	});

	const tileListContainer = document.createElement("div");
	tileListContainer.id = "tile-list-container";
	tileListContainer.style.display = "none";
	tileListContainer.style.flex = "1";
	tileListContainer.style.minHeight = "0";
	panelNav.appendChild(tileListContainer);

	const tileListWebview = createWebview(
		"tile-list", configs.tileList,
		tileListContainer, handleDndMessage,
	);

	// The sidebar shows the folder-grouped terminal tree. The file tree
	// webview stays mounted (hidden) so its forwarding paths keep working,
	// but it is no longer surfaced in the sidebar.
	fileTreeContainer.style.display = "none";
	tileListContainer.style.display = "flex";

	const workspaceManager = createWorkspaceManager({
		navWebview,
	});

	// Forward canvas opacity to nav webview
	broadcastCanvasOpacity = () => {
		if (lastCanvasOpacity == null) return;
		const opacity = Math.max(
			0, Math.min(
				100, Number(lastCanvasOpacity) || 0,
			),
		) / 100;
		workspaceManager.getNavWebview().send(
			"canvas-opacity", opacity,
		);
		tileListWebview.send("canvas-opacity", opacity);
		if (agentWebview) {
			agentWebview.send("canvas-opacity", opacity);
		}
	};
	broadcastCanvasOpacity();

	// -- Tile list sync --

	let lastTileSnapshot = new Map();

	function syncTileList() {
		const currentIds = new Set();
		for (const [id] of tileManager.getTileDOMs()) {
			const tile = getTile(id);
			if (!tile) continue;
			currentIds.add(id);
			const entry = buildTileListEntry(tile);
			const prev = lastTileSnapshot.get(id);
			if (!prev || prev.title !== entry.title ||
				prev.description !== entry.description ||
				prev.status !== entry.status) {
				tileListWebview.send(
					prev ? "tile-list:update" : "tile-list:add",
					entry,
				);
			}
			lastTileSnapshot.set(id, entry);
		}
		for (const id of lastTileSnapshot.keys()) {
			if (!currentIds.has(id)) {
				tileListWebview.send("tile-list:remove", id);
				lastTileSnapshot.delete(id);
			}
		}
	}

	// -- Tile manager --

	let minimapRef = null;
	const tileManager = createTileManager({
		tileLayer, viewportState, configs,
		getAllWebviews,
		isSpaceHeld: () => spaceHeld,
		onReposition: () => { viewport.redrawGrid(); minimapRef?.update(); },
		onSaveDebounced(state) {
			window.shellApi.canvasSaveState(
				toCenterPointState(state),
			);
			syncTileList();
		},
		onSaveImmediate(state) {
			window.shellApi.canvasSaveState(
				toCenterPointState(state),
			);
			syncTileList();
		},
		onNoteSurfaceFocus: noteSurfaceFocus,
		onFocusSurface: focusSurface,
		async onTerminalSessionCreated(tile) {
			const discovered =
				await window.shellApi.ptyDiscover?.() ?? [];
			const session = discovered.find(
				(entry) => entry.sessionId === tile.ptySessionId,
			);
			syncTerminalTileMeta(tile, session?.meta);
			tileManager.saveCanvasDebounced();
			syncTileList();
		},
		onTerminalCwdChanged(cwd) {
			setLastTerminalCwd(cwd);
		},
		onTerminalTileResized(width, height) {
			setLastTerminalSize(width, height);
		},
		onTerminalTileClosed() {
			syncTileList();
		},
		onTileFocused(tile) {
			tileListWebview.send(
				"tile-list:focus", tile?.id || null,
			);
		},
		onTileDblClick(tile) {
			edgeIndicators.panToTile(tile);
		},
	});

	// -- Edge indicators --

	const edgeIndicators = createEdgeIndicators({
		canvasEl,
		edgeIndicatorsEl: document.getElementById("edge-indicators"),
		viewportState,
		getTiles: () => tiles,
		getTileDOMs: () => tileManager.getTileDOMs(),
		onViewportUpdate() {
			viewport.updateCanvas();
		},
	});

	// -- Minimap --

	const minimap = createMinimap({
		viewportEl: canvasEl,
		wrapperEl: document.getElementById("minimap-wrapper"),
		viewportState,
		getTiles: () => tiles,
		viewport,
	});
	minimapRef = minimap;

	// -- Canvas RPC --

	const handleCanvasRpc = createCanvasRpc({
		tileManager, viewportState, viewport, edgeIndicators,
	});

	// -- Wire viewport updates --

	viewport.init(viewportState, () => {
		tileManager.repositionAllTiles();
		edgeIndicators.update();
		minimap.wake();
		tileManager.saveCanvasDebounced();
	});

	viewport.setOnResize(() => {
		tileManager.repositionAllTiles();
		edgeIndicators.update();
		minimap.update();
	});

	edgeIndicators.update();
	minimap.update();

	// -- Agent panel init (after tileManager, since getAllWebviews references it) --

	agentPanel.initPrefs(prefAgentWidth, prefAgentMode);
	agentPanel.setupResize(() => {
		agentPanel.updateTogglePosition();
	});

	// -- Surface focus management --

	function noteSurfaceFocus(surface) {
		if (settingsModalOpen && surface !== "settings") {
			focusSurface("settings");
			return;
		}
		if (
			activeSurface === "canvas-tile" &&
			surface !== "canvas-tile"
		) {
			tileManager.blurCanvasTileGuest();
		}
		activeSurface = surface;
		if (surface !== "settings") {
			lastNonModalSurface = surface;
		}
		const canvasOwned =
			surface === "canvas" || surface === "canvas-tile";
		canvasEl.classList.toggle("canvas-focused", canvasOwned);
		if (surface !== "canvas-tile") {
			tileManager.clearTileFocusRing();
		}
	}

	function isViewerVisible() {
		return singletonViewer.webview.style.display !== "none";
	}

	function resolveSurface(surface = lastNonModalSurface) {
		if (surface === "canvas-tile" && tileManager.getFocusedTileId()) {
			const dom = tileManager.getTileDOMs()
				.get(tileManager.getFocusedTileId());
			if (dom && dom.webview) return "canvas-tile";
		}
		if (surface === "viewer" && !isViewerVisible()) {
			surface = null;
		}
		if (
			surface === "nav" &&
			!panelManager.isVisible()
		) {
			surface = null;
		}
		if (surface === "agent" && !agentPanel.isVisible()) {
			surface = null;
		}
		if (surface === "agent") return "agent";
		if (surface === "viewer") return "viewer";
		if (surface === "nav") return "nav";
		if (panelManager.isVisible()) return "nav";
		if (isViewerVisible()) return "viewer";
		return "canvas";
	}

	function focusSurface(surface = lastNonModalSurface) {
		if (
			surface === "canvas-tile" &&
			tileManager.getFocusedTileId()
		) {
			const dom = tileManager.getTileDOMs()
				.get(tileManager.getFocusedTileId());
			if (dom && dom.webview) {
				dom.webview.focus();
				noteSurfaceFocus("canvas-tile");
				return;
			}
		}

		if (surface === "agent" && agentWebview && agentPanel.isVisible()) {
			agentWebview.webview.focus();
			noteSurfaceFocus("agent");
			return;
		}

		requestAnimationFrame(() => {
			window.focus();
			if (surface === "settings") {
				singletonWebviews.settings.webview.focus();
				noteSurfaceFocus("settings");
				return;
			}
			const resolved = resolveSurface(surface);
			if (resolved === "nav") {
				workspaceManager.getNavWebview().webview.focus();
				noteSurfaceFocus("nav");
				return;
			}
			if (resolved === "viewer" && isViewerVisible()) {
				singletonViewer.webview.focus();
				noteSurfaceFocus("viewer");
				return;
			}
			canvasEl.focus();
			noteSurfaceFocus("canvas");
		});
	}

	function setUnderlyingShellInert(inert) {
		const panelsEl = document.getElementById("panels");
		panelsEl.inert = inert;
		navToggle.inert = inert;
		agentToggle.inert = inert;
	}

	function blurNonModalSurfaces() {
		canvasEl.blur();
		navToggle.blur();
		agentToggle.blur();
		singletonViewer.webview.blur();
		workspaceManager.getNavWebview().webview.blur();
		if (agentWebview) agentWebview.webview.blur();
	}

	// -- getAllWebviews aggregator --

	function getAllWebviews() {
		const all = [workspaceManager.getNavWebview()];
		all.push(singletonViewer);
		all.push(tileListWebview);
		all.push(singletonWebviews.settings);
		if (agentWebview) all.push(agentWebview);
		for (const [, dom] of tileManager.getTileDOMs()) {
			if (dom.webview) {
				all.push({
					webview: dom.webview,
					send: (ch, ...args) => {
						if (dom.webview) dom.webview.send(ch, ...args);
					},
				});
			}
		}
		return all;
	}

	// -- Window + canvas focus listeners --

	window.addEventListener("focus", () => {
		noteSurfaceFocus("shell");
	});
	canvasEl.addEventListener("focus", () => {
		noteSurfaceFocus("canvas");
	});
	canvasEl.classList.add("canvas-focused");

	// -- Double-click to create terminal tile --

	canvasEl.addEventListener("dblclick", (e) => {
		if (
			spaceHeld || isPanning ||
			Date.now() < suppressCanvasDblClickUntil
		) return;
		if (
			e.target !== canvasEl && e.target !== gridCanvas &&
			e.target !== tileLayer
		) return;

		const rect = canvasEl.getBoundingClientRect();
		const screenX = e.clientX - rect.left;
		const screenY = e.clientY - rect.top;
		const cx = (screenX - viewportState.panX) / viewportState.zoom;
		const cy = (screenY - viewportState.panY) / viewportState.zoom;

		const cwd = getTerminalCwd();
		const size = getTerminalSize();
		const tile = tileManager.createCanvasTile(
			"term", cx, cy, { cwd, target: "claude", ...size },
		);
		tileManager.spawnTerminal(tile, true);
		tileManager.saveCanvasImmediate();
		minimap.update();
	});

	// -- Right-click context menu --

	canvasEl.addEventListener("contextmenu", async (e) => {
		if (
			e.target !== canvasEl && e.target !== gridCanvas &&
			e.target !== tileLayer
		) return;
		e.preventDefault();

		const rect = canvasEl.getBoundingClientRect();
		const screenX = e.clientX - rect.left;
		const screenY = e.clientY - rect.top;
		const cx = (screenX - viewportState.panX) / viewportState.zoom;
		const cy = (screenY - viewportState.panY) / viewportState.zoom;

		const selected = await window.shellApi.showContextMenu([
			{ id: "new-claude", label: "New Claude terminal tile" },
			{ id: "new-codex", label: "New Codex terminal tile" },
			{ id: "new-opencode", label: "New opencode terminal tile" },
			{ id: "new-terminal", label: "New terminal tile" },
			{ id: "new-browser", label: "New browser tile" },
		]);

		if (
			selected === "new-terminal" || selected === "new-claude"
			|| selected === "new-codex" || selected === "new-opencode"
		) {
			const cwd = getTerminalCwd();
			const size = getTerminalSize();
			const target = selected === "new-claude" ? "claude"
				: selected === "new-codex" ? "codex"
				: selected === "new-opencode" ? "opencode" : undefined;
			const tile = tileManager.createCanvasTile(
				"term", cx, cy, { cwd, target, ...size },
			);
			tileManager.spawnTerminal(tile, true);
			tileManager.saveCanvasImmediate();
			minimap.update();
		} else if (selected === "new-browser") {
			const tile = tileManager.createCanvasTile(
				"browser", cx, cy,
			);
			tileManager.spawnBrowserWebview(tile, true);
			tileManager.saveCanvasImmediate();
			minimap.update();
		}
	});

	document.addEventListener("focusin", (event) => {
		if (!settingsModalOpen) return;
		if (settingsOverlay.contains(event.target)) return;
		focusSurface("settings");
	});

	// -- Marquee selection --

	attachMarquee(canvasEl, {
		viewport: {
			get panX() { return viewportState.panX; },
			get panY() { return viewportState.panY; },
			get zoom() { return viewportState.zoom; },
		},
		tiles: () => tiles,
		onSelectionChange: (ids) => {
			if (shiftHeld) {
				for (const id of ids) selectTile(id);
			} else {
				clearSelection();
				for (const id of ids) selectTile(id);
			}
			tileManager.syncSelectionVisuals();
			tileManager.blurCanvasTileGuest();
			tileManager.clearTileFocusRing();
			tileManager.setFocusedTileId(null);
			canvasEl.focus();
			noteSurfaceFocus("canvas");
		},
		isShiftHeld: () => shiftHeld,
		isSpaceHeld: () => spaceHeld,
		getAllWebviews,
	});

	// -- Selection keyboard handlers --

	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && tileManager.getFullscreenTileId()) {
			tileManager.toggleTileFullscreen(
				tileManager.getFullscreenTileId(),
			);
			return;
		}

		if (e.key === "Escape" && getSelectedTiles().length > 0) {
			clearSelection();
			tileManager.syncSelectionVisuals();
			return;
		}

		if (
			(e.key === "Backspace" || e.key === "Delete") &&
			(activeSurface === "canvas" ||
				activeSurface === "canvas-tile")
		) {
			const selected = getSelectedTiles();
			if (selected.length === 0) return;

			const count = selected.length;
			window.shellApi.showConfirmDialog({
				message: count === 1
					? "Delete this tile?"
					: `Delete ${count} tiles?`,
				detail: "This cannot be undone.",
				buttons: ["Cancel", "Delete"],
			}).then((response) => {
				if (response !== 1) return;
				for (const t of selected) {
					tileManager.closeCanvasTile(t.id);
				}
				clearSelection();
				tileManager.syncSelectionVisuals();
				minimap.update();
			});
		}
	});

	// -- Shift scroll passthrough --

	window.addEventListener("keydown", (e) => {
		if (e.key === "Shift" && !shiftHeld) {
			shiftHeld = true;
			canvasEl.classList.add("shift-held");
		}
	});

	window.addEventListener("keyup", (e) => {
		if (e.key === "Shift") {
			shiftHeld = false;
			canvasEl.classList.remove("shift-held");
		}
	});

	window.addEventListener("blur", () => {
		if (shiftHeld) {
			shiftHeld = false;
			canvasEl.classList.remove("shift-held");
		}
	});

	// -- Space+click and middle-click pan --

	window.addEventListener("keydown", (e) => {
		if (e.code === "Space" && !e.target.closest?.("webview") && !e.target.closest?.(".terminal-embed-container") && !e.target.matches?.("input, textarea")) {
			e.preventDefault();
			if (!e.repeat && !spaceHeld) {
				spaceHeld = true;
				canvasEl.classList.add("space-held");
				for (const h of getAllWebviews()) {
					h.webview.blur();
				}
			}
		}
	});

	window.addEventListener("keyup", (e) => {
		if (e.code === "Space") {
			spaceHeld = false;
			if (!isPanning) {
				canvasEl.classList.remove("space-held");
			}
		}
	});

	window.addEventListener("blur", () => {
		if (spaceHeld) {
			spaceHeld = false;
			canvasEl.classList.remove("space-held", "panning");
		}
	});

	canvasEl.addEventListener("mousedown", (e) => {
		const shouldPan =
			e.button === 1 || (e.button === 0 && spaceHeld);
		if (!shouldPan) return;

		e.preventDefault();
		suppressCanvasDblClickUntil =
			Date.now() + CANVAS_DBLCLICK_SUPPRESS_MS;
		isPanning = true;
		canvasEl.classList.add("panning");

		const startMX = e.clientX;
		const startMY = e.clientY;
		const startPanX = viewportState.panX;
		const startPanY = viewportState.panY;

		for (const h of getAllWebviews()) {
			h.webview.style.pointerEvents = "none";
		}

		function onMove(ev) {
			viewportState.panX = startPanX + (ev.clientX - startMX);
			viewportState.panY = startPanY + (ev.clientY - startMY);
			viewport.updateCanvas();
		}

		function onUp() {
			isPanning = false;
			canvasEl.classList.remove("panning");
			if (!spaceHeld) {
				canvasEl.classList.remove("space-held");
			}
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			for (const h of getAllWebviews()) {
				h.webview.style.pointerEvents = "";
			}
		}

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	});

	// -- Shortcuts --

	function handleShortcut(action) {
		if (settingsModalOpen && action !== "toggle-settings") {
			focusSurface("settings");
			return;
		}
		if (action === "toggle-settings") {
			window.shellApi.toggleSettings();
		} else if (action === "sidebar-files" || action === "sidebar-tiles") {
			panelManager.toggle();
		} else if (action === "toggle-agent") {
			agentPanel.toggle();
		} else if (action === "focus-file-search") {
			panelManager.setMode("open");
		} else if (action === "add-workspace") {
			window.shellApi.workspaceAdd();
		} else if (action === "new-tile") {
			const rect = canvasEl.getBoundingClientRect();
			const size = getTerminalSize();
			const cx =
				(rect.width / 2 - viewportState.panX) /
				viewportState.zoom - size.width / 2;
			const cy =
				(rect.height / 2 - viewportState.panY) /
				viewportState.zoom - size.height / 2;
			const cwd = getTerminalCwd();
			const tile = tileManager.createCanvasTile(
				"term", cx, cy, { cwd, ...size },
			);
			tileManager.spawnTerminal(tile, true);
			tileManager.saveCanvasImmediate();
			minimap.update();
		} else if (action === "close-tile") {
			const focusedId = tileManager.getFocusedTileId();
			if (focusedId) {
				tileManager.closeCanvasTile(focusedId);
				tileManager.setFocusedTileId(null);
				canvasEl.focus();
				noteSurfaceFocus("canvas");
				minimap.update();
			}
		} else if (action === "toggle-fullscreen-tile") {
			const fsId = tileManager.getFullscreenTileId();
			if (fsId) {
				tileManager.toggleTileFullscreen(fsId);
			} else {
				const focused = tileManager.getFocusedTile();
				if (focused) {
					tileManager.toggleTileFullscreen(focused.id);
				}
			}
		} else if (
			action === "focus-tile-right" || action === "focus-tile-left" ||
			action === "focus-tile-up" || action === "focus-tile-down"
		) {
			const direction = action.replace("focus-tile-", "");
			const currentId = tileManager.getFocusedTileId();
			let target;
			if (!currentId) {
				const rect = canvasEl.getBoundingClientRect();
				const cx = (rect.width / 2 - viewportState.panX) / viewportState.zoom;
				const cy = (rect.height / 2 - viewportState.panY) / viewportState.zoom;
				target = getNearestTileInDirection(null, direction, cx, cy);
			} else {
				target = getNearestTileInDirection(currentId, direction);
			}
			if (target) {
				tileManager.focusCanvasTile(target.id, null);
				edgeIndicators.panToTile(target);
			}
		}
	}

	window.shellApi.onShortcut(handleShortcut);

	window.addEventListener("keydown", (event) => {
		if (!isFocusSearchShortcut(event)) return;
		event.preventDefault();
		handleShortcut("focus-file-search");
	});

	window.addEventListener("keydown", (event) => {
		if (!event.metaKey || event.shiftKey || event.altKey) return;
		if (event.key === "n") {
			event.preventDefault();
			handleShortcut("new-tile");
		} else if (event.key === "w") {
			event.preventDefault();
			handleShortcut("close-tile");
		}
	});

	// -- Browser tile Cmd+L focus URL --

	window.shellApi.onBrowserTileFocusUrl((webContentsId) => {
		for (const [, dom] of tileManager.getTileDOMs()) {
			if (!dom.webview || !dom.urlInput) continue;
			if (dom.webview.getWebContentsId() === webContentsId) {
				dom.urlInput.readOnly = false;
				dom.urlInput.focus();
				dom.urlInput.select();
				break;
			}
		}
	});

	// -- IPC forwarding --

	window.shellApi.onForwardToWebview(
		(target, channel, ...args) => {
			if (target === "settings") {
				singletonWebviews.settings.send(channel, ...args);
			} else if (target === "nav") {
				workspaceManager.getNavWebview().send(channel, ...args);
				if (
					channel === "workspace-added" ||
					channel === "workspace-removed"
				) {
					tileListWebview.send(channel, ...args);
				}
			} else if (
				target === "viewer" ||
				target.startsWith("viewer:")
			) {
				if (channel === "file-selected") {
					const hasSelectedFile = !!args[0];
					if (!hasSelectedFile) {
						singletonViewer.webview.blur();
					}
					singletonViewer.webview.style.display =
						hasSelectedFile ? "" : "none";
					if (!hasSelectedFile) {
						focusSurface(lastNonModalSurface);
					}
				}
				if (channel === "file-renamed") {
					tileManager.updateTileForRename(
						args[0], args[1],
					);
				}
				if (channel === "files-deleted") {
					tileManager.closeTilesForDeletedPaths(args[0]);
					minimap.update();
				}
				if (channel !== "workspace-changed") {
					singletonViewer.send(channel, ...args);
				}
				if (
					channel === "fs-changed" ||
					channel === "file-renamed" ||
					channel === "wikilinks-updated" ||
					channel.startsWith("agent:") ||
					channel === "replay:data"
				) {
					tileManager.broadcastToTileWebviews(
						channel, ...args,
					);
				}
			} else if (target === "canvas") {
				if (channel === "open-terminal") {
					const cwd = args[0];
					setLastTerminalCwd(cwd);
					const size = getTerminalSize();
					const rect = canvasEl.getBoundingClientRect();
					const cx =
						(rect.width / 2 - viewportState.panX) /
						viewportState.zoom - size.width / 2;
					const cy =
						(rect.height / 2 - viewportState.panY) /
						viewportState.zoom - size.height / 2;
					const tile = tileManager.createCanvasTile(
						"term", cx, cy, { cwd, ...size },
					);
					tileManager.spawnTerminal(tile, true);
					tileManager.saveCanvasImmediate();
					minimap.update();
				}
				if (channel === "open-browser-tile") {
					const url = args[0];
					const sourceWcId = args[1];
					let srcTile = null;
					for (const [id, d] of tileManager.getTileDOMs()) {
						if (
							d.webview &&
							d.webview.getWebContentsId() === sourceWcId
						) {
							srcTile = getTile(id);
							break;
						}
					}
					const x = srcTile ? srcTile.x + 40 : 0;
					const y = srcTile ? srcTile.y + 40 : 0;
					const extra = { url };
					if (srcTile) {
						extra.width = srcTile.width;
						extra.height = srcTile.height;
					}
					const newTile = tileManager.createCanvasTile(
						"browser", x, y, extra,
					);
					tileManager.spawnBrowserWebview(newTile, true);
					tileManager.saveCanvasImmediate();
					minimap.update();
				}
				if (channel === "create-graph-tile") {
					const folderPath = args[0];
					const size = defaultSize("graph");
					const rect = canvasEl.getBoundingClientRect();
					const cx =
						(rect.width / 2 - viewportState.panX) /
						viewportState.zoom - size.width / 2;
					const cy =
						(rect.height / 2 - viewportState.panY) /
						viewportState.zoom - size.height / 2;
					const wsPath =
						workspaceData.workspaces[0] ?? "";
					tileManager.createGraphTile(
						cx, cy, folderPath, wsPath,
					);
					minimap.update();
				}
			}
		},
	);

	// -- Canvas pinch from tile webviews --

	window.shellApi.onCanvasPinch((deltaY) => {
		const rect = canvasEl.getBoundingClientRect();
		viewport.applyZoom(
			deltaY, rect.width / 2, rect.height / 2,
		);
	});

	// -- Canvas RPC --

	window.shellApi.onCanvasRpcRequest(handleCanvasRpc);

	// -- PTY lifecycle forwarding --

	window.shellApi.onPtyExit((payload) => {
		for (const [id] of tileManager.getTileDOMs()) {
			const tile = getTile(id);
			if (
				tile?.type === "term" &&
				tile.ptySessionId === payload.sessionId
			) {
				tileManager.closeCanvasTile(id);
				minimap.update();
				break;
			}
		}
	});

	// -- Tile list init + click-to-navigate --

	function createTerminalAtViewportCenter(cwd) {
		setLastTerminalCwd(cwd);
		const size = getTerminalSize();
		const rect = panelViewer.getBoundingClientRect();
		const cx =
			(rect.width / 2 - viewportState.panX) /
			viewportState.zoom - size.width / 2;
		const cy =
			(rect.height / 2 - viewportState.panY) /
			viewportState.zoom - size.height / 2;
		const tile = tileManager.createCanvasTile(
			"term", cx, cy, { cwd, ...size },
		);
		tileManager.spawnTerminal(tile, true);
		tileManager.saveCanvasImmediate();
		minimap.update();
	}

	tileListWebview.webview.addEventListener(
		"dom-ready", () => {
			lastTileSnapshot = new Map();
			const initEntries = [];
			for (const [id] of tileManager.getTileDOMs()) {
				const tile = getTile(id);
				if (tile) {
					const entry = buildTileListEntry(tile);
					initEntries.push(entry);
					lastTileSnapshot.set(id, entry);
				}
			}
			tileListWebview.send("tile-list:init", initEntries);
			tileListWebview.send(
				"workspace-init", workspaceData.workspaces,
			);

			const focusedId = tileManager.getFocusedTileId();
			if (focusedId) {
				tileListWebview.send(
					"tile-list:focus", focusedId,
				);
			}
		},
	);

	tileListWebview.webview.addEventListener(
		"ipc-message", (event) => {
			if (event.channel === "tile-list:peek-tile") {
				const tileId = event.args[0];
				const tile = getTile(tileId);
				if (tile) {
					edgeIndicators.panToTile(
						tile, { targetZoom: 1 },
					);
				}
			} else if (event.channel === "tile-list:focus-tile") {
				const tileId = event.args[0];
				const tile = getTile(tileId);
				if (tile) {
					edgeIndicators.panToTile(
						tile, { targetZoom: 1 },
					);
					tileManager.focusCanvasTile(tileId);
				}
			} else if (event.channel === "tile-list:rename-tile") {
				const tileId = event.args[0];
				const newTitle = event.args[1];
				tileManager.renameTile(tileId, newTitle);
			} else if (event.channel === "terminal-tree:add-folder") {
				window.shellApi.workspaceAdd();
			} else if (event.channel === "terminal-tree:remove-folder") {
				const folderPath = event.args[0];
				if (folderPath) {
					window.shellApi.workspaceRemoveByPath(folderPath);
				}
			} else if (event.channel === "terminal-tree:new-terminal") {
				const cwd = event.args[0];
				if (cwd) createTerminalAtViewportCenter(cwd);
			}
		},
	);

	// -- Nav resize --

	panelManager.setupResize(() => {
		panelManager.updateTogglePosition();
	});

	const panelsEl = document.getElementById("panels");
	new ResizeObserver(() => {
		panelManager.updateTogglePosition();
		agentPanel.updateTogglePosition();
	}).observe(panelsEl);

	// -- Nav toggle --

	navToggle.addEventListener("click", () => {
		panelManager.toggle();
	});

	agentToggle.addEventListener("click", () => {
		agentPanel.toggle();
	});

	// -- Settings --

	settingsBackdrop.addEventListener("click", () => {
		window.shellApi.closeSettings();
	});

	window.shellApi.onSettingsToggle((action) => {
		const open = action === "open";
		settingsModalOpen = open;
		if (open) {
			blurNonModalSurfaces();
		} else {
			singletonWebviews.settings.webview.blur();
		}
		setUnderlyingShellInert(open);
		settingsOverlay.classList.toggle("visible", open);
		if (open) {
			focusSurface("settings");
			return;
		}
		focusSurface(lastNonModalSurface);
	});

	// -- Update pill --

	let updateState = { status: "idle" };
	const isDevMode = import.meta.env.DEV;

	function renderUpdatePill() {
		if (updateState.status === "downloading") {
			updatePill.style.display = "inline-block";
			updatePill.classList.add("is-downloading");
			updatePill.classList.remove("is-error");
			updatePill.textContent =
				`Updating ${Math.round(updateState.progress ?? 0)}%`;
			updatePill.title = "Downloading update...";
		} else if (updateState.status === "installing") {
			updatePill.style.display = "inline-block";
			updatePill.classList.add("is-downloading");
			updatePill.classList.remove("is-error");
			updatePill.textContent = "Installing…";
			updatePill.title =
				"Extracting and verifying update...";
		} else if (updateState.status === "available") {
			updatePill.style.display = "inline-block";
			updatePill.classList.remove("is-downloading");
			updatePill.classList.remove("is-error");
			updatePill.textContent = "Download & Update";
			updatePill.title =
				`Click to download v${updateState.version}`;
		} else if (updateState.status === "ready") {
			updatePill.style.display = "inline-block";
			updatePill.classList.remove("is-downloading");
			updatePill.classList.remove("is-error");
			updatePill.textContent = "Update & Restart";
			updatePill.title =
				`Click to install v${updateState.version}`;
		} else if (updateState.status === "error") {
			updatePill.style.display = "inline-block";
			updatePill.classList.remove("is-downloading");
			updatePill.classList.add("is-error");
			updatePill.textContent = "Update failed — retry";
			updatePill.title =
				updateState.error || "Update failed";
		} else if (isDevMode) {
			updatePill.style.display = "inline-block";
			updatePill.classList.remove("is-downloading");
			updatePill.classList.remove("is-error");
			updatePill.textContent =
				updateState.status === "checking"
					? "Checking…"
					: "Check for Update";
			updatePill.title = "Click to check for updates";
		} else {
			updatePill.style.display = "none";
			updatePill.classList.remove("is-downloading");
			updatePill.classList.remove("is-error");
		}
	}

	window.shellApi.updateGetStatus().then((s) => {
		updateState = s;
		renderUpdatePill();
	}).catch(() => {});

	window.shellApi.onUpdateStatus((s) => {
		updateState = s;
		renderUpdatePill();
	});

	newTileBtn.addEventListener("click", async () => {
		const selected = await window.shellApi.showContextMenu([
			{ id: "new-terminal", label: "New terminal tile" },
			{ id: "new-claude", label: "New Claude terminal tile" },
			{ id: "new-codex", label: "New Codex terminal tile" },
			{ id: "new-opencode", label: "New opencode terminal tile" },
			{ id: "new-browser", label: "New browser tile" },
		]);
		const type = selected === "new-terminal" || selected === "new-claude"
			|| selected === "new-codex" || selected === "new-opencode"
			? "term"
			: selected === "new-browser" ? "browser" : null;
		if (!type) return;
		const rect = panelViewer.getBoundingClientRect();
		const size = defaultSize(type);
		const cx = (rect.width / 2 - viewportState.panX) / viewportState.zoom - size.width / 2;
		const cy = (rect.height / 2 - viewportState.panY) / viewportState.zoom - size.height / 2;
		if (type === "term") {
			const cwd = getTerminalCwd();
			const target = selected === "new-claude" ? "claude"
				: selected === "new-codex" ? "codex"
				: selected === "new-opencode" ? "opencode" : undefined;
			const tile = tileManager.createCanvasTile("term", cx, cy, { cwd, target });
			tileManager.spawnTerminal(tile, true);
		} else {
			const tile = tileManager.createCanvasTile("browser", cx, cy);
			tileManager.spawnBrowserWebview(tile, true);
		}
		tileManager.saveCanvasImmediate();
		minimap.update();
	});

	settingsBtn.addEventListener("click", () => {
		window.shellApi.toggleSettings();
	});

	updatePill.addEventListener("click", () => {
		if (
			updateState.status === "downloading" ||
			updateState.status === "installing"
		) return;
		if (updateState.status === "available") {
			window.shellApi.updateDownload();
		} else if (updateState.status === "ready") {
			window.shellApi.updateInstall();
		} else if (updateState.status === "error") {
			updateState = { status: "idle" };
			renderUpdatePill();
			window.shellApi.updateCheck();
		} else if (
			isDevMode &&
			(updateState.status === "idle" ||
				updateState.status === "checking")
		) {
			window.shellApi.updateCheck();
		}
	});

	// -- Loading --

	window.shellApi.onLoadingStatus((message) => {
		loadingStatusEl.textContent = message;
	});

	window.shellApi.onLoadingDone(() => {
		loadingOverlay.classList.add("fade-out");
		setTimeout(() => {
			loadingOverlay.remove();
		}, 350);
		checkFirstLaunchDialog();
	});

	// -- Drag-and-drop (window-level) --

	window.addEventListener("dragenter", (e) => {
		e.preventDefault();
		dragCounter++;
		if (dragCounter === 1 && dragDropOverlay) {
			dragDropOverlay.classList.add("visible");
		}
	});

	window.addEventListener("dragover", (e) => {
		e.preventDefault();
	});

	window.addEventListener("dragleave", (e) => {
		e.preventDefault();
		dragCounter = Math.max(0, dragCounter - 1);
		if (dragCounter === 0 && dragDropOverlay) {
			dragDropOverlay.classList.remove("visible");
		}
	});

	window.addEventListener("drop", async (e) => {
		e.preventDefault();
		dragCounter = 0;
		if (dragDropOverlay) {
			dragDropOverlay.classList.remove("visible");
		}

		const rect = canvasEl.getBoundingClientRect();
		const screenX = e.clientX - rect.left;
		const screenY = e.clientY - rect.top;
		const cx =
			(screenX - viewportState.panX) / viewportState.zoom;
		const cy =
			(screenY - viewportState.panY) / viewportState.zoom;

		// Extract Finder file paths synchronously — native file
		// handles on DataTransfer are invalidated after the first
		// await, so getPathForFile must run before getDragPaths.
		const finderPaths = [];
		if (e.dataTransfer?.files) {
			for (let i = 0; i < e.dataTransfer.files.length; i++) {
				let p = "";
				try {
					p = window.shellApi.getPathForFile(
						e.dataTransfer.files[i],
					);
				} catch { /* skip non-file items */ }
				if (p) finderPaths.push(p);
			}
		}

		let paths = [];
		if (window.shellApi.getDragPaths) {
			try {
				paths = await window.shellApi.getDragPaths();
			} catch { /* noop */ }
		}
		if (paths.length === 0) {
			paths = finderPaths;
		}
		if (paths.length === 0) return;

		const viewerRect = panelViewer.getBoundingClientRect();
		if (e.clientX < viewerRect.left) return;

		// Filter out directories in parallel (folder drops not supported)
		const checks = paths.map(async (p) => {
			const isDir = await window.shellApi.isDirectory(p);
			return isDir ? null : p;
		});
		const filePaths = (await Promise.all(checks)).filter(Boolean);
		if (filePaths.length === 0) return;

		// If drop landed on a terminal tile, paste paths into the PTY
		const targetTile = tileAtPoint(cx, cy);
		if (targetTile && targetTile.type === "term" && targetTile.ptySessionId) {
			const escaped = filePaths.map(
				(p) => "'" + p.replace(/'/g, "'\\''") + "'",
			);
			window.shellApi.ptyWrite(
				targetTile.ptySessionId,
				escaped.join(" "),
			);
			tileManager.focusCanvasTile(targetTile.id);
			return;
		}

		for (let i = 0; i < filePaths.length; i++) {
			const filePath = filePaths[i];
			const type = inferTileType(filePath);
			tileManager.createFileTile(
				type, cx + i * 30, cy + i * 30, filePath,
			);
		}
	});

	if (dragDropOverlay) {
		dragDropOverlay.addEventListener("transitionend", () => {
			if (!dragDropOverlay.classList.contains("visible")) {
				for (const h of getAllWebviews()) {
					h.webview.style.pointerEvents = "";
				}
			}
		});
	}

	// -- Initialize in-process terminal mode (before tile restore) --

	await tileManager.initInProcessTerminals();

	// -- Restore canvas state --

	const savedState = await window.shellApi.canvasLoadState();
	if (savedState) {
		const { centerX, centerY, zoom } = savedState.viewport;
		const w = canvasEl.clientWidth;
		const h = canvasEl.clientHeight;
		viewportState.zoom = zoom ?? 1;
		viewportState.panX = centerX != null
			? w / 2 - centerX * viewportState.zoom
			: 0;
		viewportState.panY = centerY != null
			? h / 2 - centerY * viewportState.zoom
			: 0;
		viewport.updateCanvas();
		tileManager.restoreCanvasState(savedState.tiles);
		viewport.redrawGrid();
		minimap.update();

		// Batch-sync metadata for restored terminal tiles
		const restoredTermTiles = tiles.filter(
			(t) => t.type === "term" && t.ptySessionId,
		);
		if (restoredTermTiles.length > 0) {
			const discovered =
				await window.shellApi.ptyDiscover?.() ?? [];
			for (const tile of restoredTermTiles) {
				const session = discovered.find(
					(entry) => entry.sessionId === tile.ptySessionId,
				);
				syncTerminalTileMeta(tile, session?.meta);
			}
			tileManager.saveCanvasDebounced();
		}
	}

	// -- Initialize workspaces --

	navWebview.send(
		"workspace-init", workspaceData.workspaces,
	);

	panelManager.applyVisibility();

	// -- beforeunload save --

	window.addEventListener("beforeunload", () => {
		tileManager.saveCanvasImmediate();
	});
}

async function checkFirstLaunchDialog() {
	const offered = await window.shellApi.hasOfferedPlugin();
	if (offered) return;

	const agents = await window.shellApi.getAgents();

	const dialog =
		document.getElementById("canvas-skill-dialog");
	const agentsContainer =
		document.getElementById("canvas-skill-agents");
	const skipBtn =
		document.getElementById("canvas-skill-skip");
	const installBtn =
		document.getElementById("canvas-skill-install");
	if (
		!dialog || !agentsContainer || !skipBtn || !installBtn
	) return;

	agentsContainer.innerHTML = "";
	const checkboxes = [];

	for (const agent of agents) {
		const row = document.createElement("label");
		row.className = "canvas-skill-agent-row";

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = agent.detected;
		checkbox.dataset.agentId = agent.id;
		checkboxes.push(checkbox);

		const name = document.createElement("span");
		name.className = "agent-name";
		name.textContent = agent.name;

		const badge = document.createElement("span");
		badge.className = agent.detected
			? "agent-badge detected"
			: "agent-badge not-found";
		badge.textContent =
			agent.detected ? "detected" : "not found";

		row.appendChild(checkbox);
		row.appendChild(name);
		row.appendChild(badge);
		agentsContainer.appendChild(row);
	}

	dialog.classList.remove("hidden");

	function closeDialog() {
		dialog.classList.add("hidden");
		window.shellApi.markPluginOffered();
	}

	skipBtn.addEventListener(
		"click", closeDialog, { once: true },
	);

	installBtn.addEventListener("click", async function onInstall() {
		installBtn.disabled = true;
		installBtn.textContent = "Installing…";
		// Clear previous error if retrying
		dialog.querySelector(".canvas-skill-error")?.remove();
		const errors = [];
		for (const cb of checkboxes) {
			if (cb.checked) {
				try {
					const result = await window.shellApi.installSkill(
						cb.dataset.agentId,
					);
					if (result && !result.ok) {
						errors.push(`${cb.dataset.agentId}: ${result.error}`);
					}
				} catch (err) {
					errors.push(`${cb.dataset.agentId}: ${err.message || err}`);
				}
			}
		}
		if (errors.length > 0) {
			installBtn.textContent = "Install";
			installBtn.disabled = false;
			const errEl = document.createElement("p");
			errEl.className = "canvas-skill-error";
			errEl.textContent =
				`Install failed: ${errors.join("; ")}`;
			dialog.querySelector("#canvas-skill-actions")
				?.insertAdjacentElement("beforebegin", errEl);
			return;
		}
		installBtn.removeEventListener("click", onInstall);
		closeDialog();
	});
}

init().catch((err) => {
	console.error("[shell] init() failed:", err);
	const el = document.getElementById("loading-status");
	if (el) el.textContent = `ERROR: ${err?.message || err}`;
});
