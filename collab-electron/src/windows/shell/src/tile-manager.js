import {
	tiles, addTile, removeTile, getTile, bringToFront,
	generateId, defaultSize, inferTileType, snapToGrid,
	selectTile, deselectTile, toggleTileSelection,
	clearSelection, isSelected, getSelectedTiles,
} from "./canvas-state.js";
import {
	createTileDOM, positionTile, updateTileTitle, getTileLabel,
	startInlineRename,
} from "./tile-renderer.js";
import { toCollabFileUrl } from "@collab/shared/collab-file-url";
import { workspaceRootMatch } from "@collab/shared/path-utils";
import { attachDrag, attachResize } from "./tile-interactions.js";
import { findAutoPlacement } from "./canvas-rpc.js";
import {
	createTerminal, getTerminal, disposeTerminal, initPtyDataDispatch,
} from "./terminal-embed.js";

let inProcessTerminals = false;

/**
 * Tile lifecycle manager: creation, deletion, persistence, webview
 * spawning, focus, selection visuals, and canvas save/restore.
 */
export function createTileManager({
	tileLayer, viewportState, configs,
	getAllWebviews, isSpaceHeld,
	onSaveDebounced, onSaveImmediate,
	onNoteSurfaceFocus, onFocusSurface,
	onTerminalSessionCreated,
	onTerminalCwdChanged,
	onTerminalTileClosed,
	onTerminalTileResized,
	onTileFocused,
	onTileDblClick,
	onReposition,
}) {
	/** @type {Map<string, {container: HTMLElement, contentArea: HTMLElement, titleText: HTMLElement, webview?: HTMLElement}>} */
	const tileDOMs = new Map();
	let saveTimer = null;
	let focusedTileId = null;

	// Viewport read-only accessor for tile-interactions
	const viewport = {
		get panX() { return viewportState.panX; },
		get panY() { return viewportState.panY; },
		get zoom() { return viewportState.zoom; },
	};

	// -- Coordinate validation --

	function safeCoord(v) {
		return Number.isFinite(v) ? v : 0;
	}

	// -- Canvas persistence --

	function getCanvasStateForSave() {
		return {
			version: 1,
			tiles: tiles.map((t) => ({
				id: t.id,
				type: t.type,
				x: safeCoord(t.x),
				y: safeCoord(t.y),
				width: t.width,
				height: t.height,
				filePath: t.filePath,
				folderPath: t.folderPath,
				workspacePath: t.workspacePath,
				ptySessionId: t.ptySessionId,
				target: t.target,
				url: t.url,
				zIndex: t.zIndex,
				userTitle: t.userTitle,
				autoTitle: t.autoTitle,
			})),
			viewport: {
				panX: viewportState.panX,
				panY: viewportState.panY,
				zoom: viewportState.zoom,
			},
		};
	}

	function saveCanvasDebounced() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			onSaveDebounced(getCanvasStateForSave());
		}, 500);
	}

	function saveCanvasImmediate() {
		clearTimeout(saveTimer);
		onSaveImmediate(getCanvasStateForSave());
	}

	// -- Tile positioning --

	function repositionAllTiles() {
		for (const tile of tiles) {
			const dom = tileDOMs.get(tile.id);
			if (!dom) continue;
			positionTile(
				dom.container, tile,
				viewportState.panX, viewportState.panY,
				viewportState.zoom,
			);
		}
		onReposition?.();
	}

	// -- Selection visuals --

	function syncSelectionVisuals() {
		for (const [id, dom] of tileDOMs) {
			dom.container.classList.toggle(
				"tile-selected", isSelected(id),
			);
		}
	}

	// -- Focus management --

	function clearTileFocusRing() {
		for (const [, d] of tileDOMs) {
			d.container.classList.remove("tile-focused");
		}
	}

	function blurCanvasTileGuest(id = focusedTileId) {
		if (!id) return;
		const dom = tileDOMs.get(id);
		if (!dom) return;
		if (dom.terminalContainer) {
			const tile = getTile(id);
			const handle = tile?.ptySessionId ? getTerminal(tile.ptySessionId) : null;
			if (handle) handle.blur();
		} else if (dom.webview) {
			try { dom.webview.send("shell-blur"); } catch { /* noop */ }
			try { dom.webview.blur(); } catch { /* noop */ }
		}
	}

	function forwardClickToWebview(webview, mouseEvent) {
		if (!webview.isConnected) return;
		if (
			typeof webview.isLoading === "function" &&
			webview.isLoading()
		) {
			return;
		}
		const rect = webview.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;
		const x = Math.round(
			(mouseEvent.clientX - rect.left)
			* (webview.offsetWidth / rect.width),
		);
		const y = Math.round(
			(mouseEvent.clientY - rect.top)
			* (webview.offsetHeight / rect.height),
		);
		if (x < 0 || y < 0) return;
		if (x > webview.offsetWidth || y > webview.offsetHeight) return;
		webview.sendInputEvent({
			type: "mouseDown", x, y, button: "left", clickCount: 1,
		});
		webview.sendInputEvent({
			type: "mouseUp", x, y, button: "left", clickCount: 1,
		});
	}

	function focusCanvasTile(id, mouseEvent) {
		const tile = getTile(id);
		if (tile) {
			bringToFront(tile);
			repositionAllTiles();
		}
		const dom = tileDOMs.get(id);
		if (dom && dom.terminalContainer) {
			if (focusedTileId && focusedTileId !== id) {
				blurCanvasTileGuest(focusedTileId);
			}
			focusedTileId = id;
			if (onTileFocused) {
				onTileFocused(tile);
			}
			clearTileFocusRing();
			dom.container.classList.add("tile-focused");
			const handle = tile?.ptySessionId ? getTerminal(tile.ptySessionId) : null;
			if (handle) handle.focus();
			onNoteSurfaceFocus("canvas-tile");
		} else if (dom && dom.webview) {
			if (focusedTileId && focusedTileId !== id) {
				blurCanvasTileGuest(focusedTileId);
			}
			focusedTileId = id;
			if (onTileFocused) {
				onTileFocused(tile);
			}
			clearTileFocusRing();
			dom.container.classList.add("tile-focused");
			dom.webview.focus();
			onNoteSurfaceFocus("canvas-tile");

			if (
				mouseEvent && mouseEvent.button === 0 &&
				tile.type !== "browser"
			) {
				forwardClickToWebview(dom.webview, mouseEvent);
			}
		}
	}

	let fullscreenTileId = null;
	const panelViewer = tileLayer.parentElement;

	function toggleTileFullscreen(id) {
		const dom = tileDOMs.get(id);
		if (!dom) return;

		if (fullscreenTileId === id) {
			dom.container.classList.remove("tile-fullscreen");
			dom.container.style.cssText = "";
			panelViewer.classList.remove("has-fullscreen-tile");
			fullscreenTileId = null;
			repositionAllTiles();
		} else {
			if (fullscreenTileId) {
				const prev = tileDOMs.get(fullscreenTileId);
				if (prev) {
					prev.container.classList.remove("tile-fullscreen");
					prev.container.style.cssText = "";
				}
			}
			fullscreenTileId = id;
			dom.container.classList.add("tile-fullscreen");
			dom.container.style.cssText = "";
			panelViewer.classList.add("has-fullscreen-tile");
			focusCanvasTile(id);
			repositionAllTiles();
		}
	}

	// -- Webview spawning --

	function spawnTerminalWebview(tile, autoFocus = false) {
		const dom = tileDOMs.get(tile.id);
		if (!dom) return;

		const wv = document.createElement("webview");
		const termConfig = configs.terminalTile;
		const params = new URLSearchParams();
		params.set("tileId", tile.id);
		if (tile.ptySessionId) {
			params.set("sessionId", tile.ptySessionId);
			params.set("restored", "1");
		} else {
			if (tile.cwd) params.set("cwd", tile.cwd);
			if (tile.target) params.set("target", tile.target);
		}
		const qs = params.toString();
		wv.setAttribute(
			"src",
			qs ? `${termConfig.src}?${qs}` : termConfig.src,
		);
		wv.setAttribute("preload", termConfig.preload);
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.style.width = "100%";
		wv.style.height = "100%";
		wv.style.border = "none";

		dom.contentArea.appendChild(wv);
		dom.webview = wv;

		wv.addEventListener("dom-ready", () => {
			if (autoFocus) focusCanvasTile(tile.id);
			wv.addEventListener("before-input-event", () => {});
		});

		wv.addEventListener("ipc-message", (event) => {
			if (event.channel === "pty-session-id") {
				tile.ptySessionId = event.args[0];
				saveCanvasDebounced();
				if (onTerminalSessionCreated) {
					onTerminalSessionCreated(tile);
				}
			}
			if (event.channel === "pty-cwd-changed") {
				const cwd = event.args[1];
				if (cwd && cwd !== tile.autoTitle) {
					tile.cwd = cwd;
					tile.autoTitle = cwd;
					updateTileTitle(tileDOMs.get(tile.id), tile);
					saveCanvasDebounced();
					if (onTerminalCwdChanged) {
						onTerminalCwdChanged(cwd);
					}
				}
			}
		});
	}

	async function spawnTerminalDiv(tile, autoFocus = false) {
		const dom = tileDOMs.get(tile.id);
		if (!dom) return;

		const container = document.createElement("div");
		container.className = "terminal-embed-container";
		container.style.width = "100%";
		container.style.height = "100%";
		dom.contentArea.appendChild(container);
		dom.terminalContainer = container;

		let sessionId = tile.ptySessionId;
		let scrollbackData = null;
		let mode = "direct";
		let restored = false;

		if (sessionId) {
			try {
				const result = await window.shellApi.ptyReconnect(sessionId, 80, 24);
				scrollbackData = result.scrollback;
				mode = result.mode || "direct";
				restored = true;
			} catch {
				sessionId = null;
			}
		}

		if (!sessionId) {
			const result = await window.shellApi.ptyCreate(tile.cwd);
			sessionId = result.sessionId;
			tile.ptySessionId = sessionId;
			saveCanvasDebounced();
		}

		const handle = await createTerminal(container, sessionId, {
			scrollbackData, mode, restored,
		});

		if (onTerminalSessionCreated) {
			onTerminalSessionCreated(tile);
		}

		if (autoFocus) {
			handle.focus();
		}
	}

	function spawnTerminal(tile, autoFocus = false) {
		if (inProcessTerminals) {
			spawnTerminalDiv(tile, autoFocus).catch((err) => {
				console.error(
					"[tile-manager] Failed to spawn in-process terminal:", err,
				);
			});
		} else {
			spawnTerminalWebview(tile, autoFocus);
		}
	}

	function spawnGraphWebview(tile) {
		const dom = tileDOMs.get(tile.id);
		if (!dom) return;

		const wv = document.createElement("webview");
		const graphConfig = configs.graphTile;
		const params = new URLSearchParams();
		params.set("folder", tile.folderPath);
		params.set("workspace", tile.workspacePath ?? "");
		const qs = params.toString();
		wv.setAttribute("src", `${graphConfig.src}?${qs}`);
		wv.setAttribute("preload", graphConfig.preload);
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.style.width = "100%";
		wv.style.height = "100%";
		wv.style.border = "none";

		dom.contentArea.appendChild(wv);
		dom.webview = wv;
	}

	function spawnBrowserWebview(tile, autoFocus = false) {
		const dom = tileDOMs.get(tile.id);
		if (!dom) return;

		if (!tile.url) {
			if (autoFocus && dom.urlInput) {
				dom.urlInput.focus();
			}
			return;
		}

		let url = tile.url;
		if (!/^https?:\/\//i.test(url)) {
			const isLocal = /^localhost(:|$)/i.test(url) ||
				/^127\.0\.0\.1(:|$)/.test(url);
			url = (isLocal ? "http://" : "https://") + url;
			tile.url = url;
		}
		const blocked = /^(javascript|file|data):/i;
		if (blocked.test(url)) return;

		const wv = document.createElement("webview");
		wv.setAttribute("src", url);
		wv.setAttribute("allowpopups", "");
		wv.setAttribute("partition", "persist:browser");
		wv.setAttribute(
			"webpreferences", "contextIsolation=yes, sandbox=yes",
		);
		wv.style.width = "100%";
		wv.style.height = "100%";
		wv.style.border = "none";

		dom.contentArea.appendChild(wv);
		dom.webview = wv;

		const stopSvg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
		const reloadSvg = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3v4h-4"/><path d="M12.36 10a5 5 0 1 1-.96-5.36L13 7"/></svg>`;

		function updateNavState() {
			if (dom.navBack) {
				dom.navBack.disabled = !wv.canGoBack();
			}
			if (dom.navForward) {
				dom.navForward.disabled = !wv.canGoForward();
			}
		}

		// Replace buttons with clones to strip stale listeners
		for (const key of ["navBack", "navForward", "navReload"]) {
			if (dom[key]) {
				const fresh = dom[key].cloneNode(true);
				dom[key].replaceWith(fresh);
				dom[key] = fresh;
			}
		}

		if (dom.navBack) {
			dom.navBack.addEventListener("click", (e) => {
				e.stopPropagation();
				if (wv.canGoBack()) wv.goBack();
			});
		}
		if (dom.navForward) {
			dom.navForward.addEventListener("click", (e) => {
				e.stopPropagation();
				if (wv.canGoForward()) wv.goForward();
			});
		}
		if (dom.navReload) {
			dom.navReload.addEventListener("click", (e) => {
				e.stopPropagation();
				if (wv.isLoading()) {
					wv.stop();
				} else {
					wv.reload();
				}
			});
		}

		wv.addEventListener("dom-ready", () => {
			wv.setZoomFactor(0.95);
		});

		function clearErrors() {
			for (const el of [
				...dom.contentArea.querySelectorAll(".tile-load-error"),
			]) {
				el.remove();
			}
		}

		wv.addEventListener("did-start-loading", () => {
			clearErrors();
			wv.style.display = "";
			if (dom.navReload) {
				dom.navReload.innerHTML = stopSvg;
				dom.navReload.title = "Stop";
			}
		});

		wv.addEventListener("did-stop-loading", () => {
			if (dom.navReload) {
				dom.navReload.innerHTML = reloadSvg;
				dom.navReload.title = "Reload";
			}
			updateNavState();
		});

		wv.addEventListener("did-navigate", (e) => {
			tile.url = e.url;
			if (dom.urlInput) dom.urlInput.value = e.url;
			updateTileTitle(dom, tile);
			updateNavState();
			saveCanvasDebounced();
		});

		wv.addEventListener("did-navigate-in-page", (e) => {
			if (e.isMainFrame) {
				tile.url = e.url;
				if (dom.urlInput) dom.urlInput.value = e.url;
				updateTileTitle(dom, tile);
				updateNavState();
				saveCanvasDebounced();
			}
		});

		wv.addEventListener("did-fail-load", (e) => {
			if (e.errorCode === -3) return;
			if (!e.isMainFrame) return;
			clearErrors();
			wv.style.display = "none";
			const errDiv = document.createElement("div");
			errDiv.className = "tile-load-error";
			errDiv.style.cssText =
				"padding:20px;color:#888;font-size:13px;";
			errDiv.textContent =
				`Failed to load: ${e.validatedURL || tile.url}`;
			dom.contentArea.appendChild(errDiv);
		});

		wv.addEventListener("render-process-gone", () => {
			const crashDiv = document.createElement("div");
			crashDiv.style.cssText =
				"padding:20px;color:#888;font-size:13px;";
			crashDiv.textContent =
				"Page crashed. Edit the URL and press Enter to reload.";
			if (dom.webview) {
				dom.contentArea.removeChild(dom.webview);
				dom.webview = null;
			}
			dom.contentArea.appendChild(crashDiv);
		});

		if (autoFocus) {
			wv.addEventListener(
				"dom-ready", () => focusCanvasTile(tile.id),
			);
		}
	}

	// -- Tile CRUD --

	function createCanvasTile(type, cx, cy, extra = {}) {
		const size = defaultSize(type);
		const tile = addTile({
			id: extra.id || generateId(),
			type,
			x: cx,
			y: cy,
			width: extra.width || size.width,
			height: extra.height || size.height,
			...extra,
		});
		snapToGrid(tile);
		window.shellApi.trackEvent("tile_created", { type });

		const dom = createTileDOM(tile, {
			onClose: (id) => closeCanvasTile(id),
			onFocus: (id, e) => {
				if (e && e.shiftKey) {
					toggleTileSelection(id);
					syncSelectionVisuals();
					return;
				}
				clearSelection();
				syncSelectionVisuals();
				focusCanvasTile(id, e);
			},
			onNavigate: (id, url) => {
				const t = getTile(id);
				if (!t || t.type !== "browser") return;
				t.url = url;
				const d = tileDOMs.get(id);
				if (d?.webview) {
					d.contentArea.removeChild(d.webview);
					d.webview = null;
				}
				spawnBrowserWebview(t);
				saveCanvasImmediate();
			},
			onDuplicate: (id) => {
				const t = getTile(id);
				if (!t) return;
				const gap = 40;
				const newTile = createCanvasTile("term", t.x + t.width + gap, t.y, {
					cwd: t.cwd,
					target: t.target,
					width: t.width,
					height: t.height,
				});
				spawnTerminalWebview(newTile, true);
				saveCanvasImmediate();
			},
			onToggleFullscreen: (id) => {
				toggleTileFullscreen(id);
			},
			onRename: (id) => {
				const t = getTile(id);
				const d = tileDOMs.get(id);
				if (!t || !d) return;
				startInlineRename(d, t, (newTitle) => {
					if (newTitle === "") {
						delete t.userTitle;
					} else {
						t.userTitle = newTitle;
					}
					updateTileTitle(d, t);
					saveCanvasImmediate();
				});
			},
		});

		// Double-click title bar → center tile in viewport
		dom.titleBar.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			if (onTileDblClick) onTileDblClick(tile);
		});

		attachDrag(dom.titleBar, tile, {
			viewport,
			onUpdate: repositionAllTiles,
			disablePointerEvents: (wvs) => {
				for (const w of wvs) {
					w.webview.style.pointerEvents = "none";
				}
			},
			enablePointerEvents: (wvs) => {
				for (const w of wvs) {
					w.webview.style.pointerEvents = "";
				}
			},
			getAllWebviews,
			getGroupDragContext: () => {
				if (
					!isSelected(tile.id) ||
					getSelectedTiles().length <= 1
				) {
					return null;
				}
				return getSelectedTiles().map((t) => ({
					tile: t,
					container: tileDOMs.get(t.id)?.container,
					startX: t.x,
					startY: t.y,
				}));
			},
			onShiftClick: (id) => {
				toggleTileSelection(id);
				syncSelectionVisuals();
			},
			onFocus: (id, e) => focusCanvasTile(id, e),
			isSpaceHeld,
			contentOverlay: dom.contentOverlay,
		});
		attachResize(
			dom.container, tile, viewport,
			repositionAllTiles,
			getAllWebviews,
			() => focusCanvasTile(tile.id),
			(t) => {
				if (t.type === "term" && onTerminalTileResized) {
					onTerminalTileResized(t.width, t.height);
				}
			},
		);

		tileLayer.appendChild(dom.container);
		tileDOMs.set(tile.id, dom);
		positionTile(
			dom.container, tile,
			viewportState.panX, viewportState.panY,
			viewportState.zoom,
		);

		return tile;
	}

	function closeCanvasTile(id) {
		const dom = tileDOMs.get(id);
		const tile = getTile(id);
		if (dom && dom.terminalContainer && tile?.ptySessionId) {
			disposeTerminal(tile.ptySessionId);
		}
		if (dom) {
			dom.container.remove();
			tileDOMs.delete(id);
		}
		deselectTile(id);
		if (tile) {
			window.shellApi.trackEvent(
				"tile_closed", { type: tile.type },
			);
			if (tile.type === "term" && tile.ptySessionId) {
				window.shellApi.ptyKillSession(tile.ptySessionId);
				if (onTerminalTileClosed) {
					onTerminalTileClosed(tile.ptySessionId);
				}
			}
		}
		removeTile(id);
		onReposition?.();
		saveCanvasImmediate();
	}

	function createFileTile(type, cx, cy, filePath, extra = {}) {
		const tile = createCanvasTile(type, cx, cy, { ...extra, filePath });
		const dom = tileDOMs.get(tile.id);
		if (!dom) return tile;

		if (type === "pdf") {
			const wv = document.createElement("webview");
			wv.setAttribute("src", toCollabFileUrl(filePath));
			wv.setAttribute("webpreferences", "contextIsolation=yes, sandbox=yes");
			wv.style.width = "100%";
			wv.style.height = "100%";
			wv.style.border = "none";
			dom.contentArea.appendChild(wv);
			dom.webview = wv;
		} else if (type === "image") {
			const img = document.createElement("img");
			img.src = toCollabFileUrl(filePath);
			img.style.width = "100%";
			img.style.height = "100%";
			img.style.objectFit = "contain";
			img.draggable = false;
			dom.contentArea.appendChild(img);
		} else {
			const wv = document.createElement("webview");
			const viewerConfig = configs.viewer;
			const mode = type === "note" ? "note" : "code";
			wv.setAttribute(
				"src",
				`${viewerConfig.src}?tilePath=${encodeURIComponent(filePath)}&tileMode=${mode}`,
			);
			wv.setAttribute("preload", viewerConfig.preload);
			wv.setAttribute(
				"webpreferences",
				"contextIsolation=yes, sandbox=yes",
			);
			wv.style.width = "100%";
			wv.style.height = "100%";
			wv.style.border = "none";

			dom.contentArea.appendChild(wv);
			dom.webview = wv;

			wv.addEventListener("dom-ready", () => {});
		}

		saveCanvasImmediate();
		return tile;
	}

	function createGraphTile(cx, cy, folderPath, workspacePath) {
		const tile = createCanvasTile("graph", cx, cy, {
			folderPath, workspacePath,
		});
		spawnGraphWebview(tile);
		saveCanvasImmediate();
		return tile;
	}

	function clearCanvas(viewportObj) {
		const tileIds = tiles.map((t) => t.id);
		for (const id of tileIds) {
			closeCanvasTile(id);
		}
		viewportState.panX = 0;
		viewportState.panY = 0;
		viewportState.zoom = 1;
		viewportObj.updateCanvas();
		saveCanvasImmediate();
	}

	// -- Canvas state restore --

	function restoreCanvasState(savedTiles) {
		for (const saved of savedTiles) {
			let cx = saved.x;
			let cy = saved.y;
			if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
				const size = defaultSize(saved.type);
				const pos = findAutoPlacement(
					tiles, size.width, size.height,
				);
				cx = pos.x;
				cy = pos.y;
			}

			if (saved.type === "term") {
				const tile = createCanvasTile(
					"term", cx, cy, {
						id: saved.id,
						width: saved.width,
						height: saved.height,
						zIndex: saved.zIndex,
						ptySessionId: saved.ptySessionId,
						target: saved.target,
						userTitle: saved.userTitle,
						autoTitle: saved.autoTitle,
					},
				);
				spawnTerminal(tile);
			} else if (saved.type === "graph" && saved.folderPath) {
				const tile = createCanvasTile(
					"graph", cx, cy, {
						id: saved.id,
						width: saved.width,
						height: saved.height,
						zIndex: saved.zIndex,
						folderPath: saved.folderPath,
						workspacePath: saved.workspacePath,
					},
				);
				spawnGraphWebview(tile);
			} else if (saved.type === "browser") {
				const tile = createCanvasTile(
					"browser", cx, cy, {
						id: saved.id,
						width: saved.width,
						height: saved.height,
						zIndex: saved.zIndex,
						url: saved.url,
					},
				);
				spawnBrowserWebview(tile);
			} else if (saved.filePath) {
				createFileTile(
					saved.type, cx, cy, saved.filePath, {
						id: saved.id,
						width: saved.width,
						height: saved.height,
						zIndex: saved.zIndex,
					},
				);
			}
		}
	}

	// -- Tile updates for external events --

	function updateTileForRename(oldPath, newPath) {
		let anyUpdated = false;
		for (const t of tiles) {
			if (t.filePath === oldPath) {
				t.filePath = newPath;
				t.type = inferTileType(newPath);
				const dom = tileDOMs.get(t.id);
				if (dom) updateTileTitle(dom, t);
				anyUpdated = true;
			}
			if (
				t.type === "graph" && t.folderPath &&
				workspaceRootMatch(oldPath, t.folderPath)
			) {
				t.folderPath =
					newPath + t.folderPath.slice(oldPath.length);
				const dom = tileDOMs.get(t.id);
				if (dom) {
					updateTileTitle(dom, t);
					if (dom.webview) {
						dom.webview.send(
							"scope-changed", t.folderPath,
						);
					}
				}
				anyUpdated = true;
			}
		}
		if (anyUpdated) saveCanvasDebounced();
	}

	function closeTilesForDeletedPaths(deletedPaths) {
		const deleted = new Set(deletedPaths);
		for (const t of [...tiles]) {
			if (t.filePath && deleted.has(t.filePath)) {
				closeCanvasTile(t.id);
			}
			if (
				t.type === "graph" && t.folderPath &&
				deleted.has(t.folderPath)
			) {
				closeCanvasTile(t.id);
			}
		}
	}

	function broadcastToTileWebviews(channel, ...args) {
		for (const [, dom] of tileDOMs) {
			if (dom.webview) dom.webview.send(channel, ...args);
		}
	}

	function renameTile(id, newTitle) {
		const t = getTile(id);
		if (!t) return;
		if (newTitle === "") {
			delete t.userTitle;
		} else {
			t.userTitle = newTitle;
		}
		const d = tileDOMs.get(id);
		if (d) updateTileTitle(d, t);
		saveCanvasImmediate();
	}

	async function initInProcessTerminals() {
		try {
			inProcessTerminals = await window.shellApi.getInProcessTerminals();
		} catch {
			inProcessTerminals = false;
		}
		if (inProcessTerminals) {
			initPtyDataDispatch();
		}
	}

	return {
		initInProcessTerminals,
		createCanvasTile,
		closeCanvasTile,
		focusCanvasTile,
		blurCanvasTileGuest,
		clearTileFocusRing,
		repositionAllTiles,
		syncSelectionVisuals,
		spawnTerminal,
		spawnTerminalWebview,
		spawnGraphWebview,
		spawnBrowserWebview,
		createFileTile,
		createGraphTile,
		clearCanvas,
		getCanvasStateForSave,
		restoreCanvasState,
		getTileDOMs: () => tileDOMs,
		getFocusedTileId: () => focusedTileId,
		getFocusedTile: () => getTile(focusedTileId),
		setFocusedTileId: (id) => { focusedTileId = id; },
		renameTile,
		toggleTileFullscreen,
		getFullscreenTileId: () => fullscreenTileId,
		updateTileForRename,
		closeTilesForDeletedPaths,
		broadcastToTileWebviews,
		saveCanvasDebounced,
		saveCanvasImmediate,
	};
}
