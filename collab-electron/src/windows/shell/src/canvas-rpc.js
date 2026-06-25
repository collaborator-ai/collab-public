import {
	tiles, getTile, defaultSize, snapToGrid,
} from "./canvas-state.js";

/**
 * Find a non-overlapping position on the canvas for a tile of the
 * given size. Scans on a 20 px grid within a 4000x3000 region.
 */
export function findAutoPlacement(existingTiles, width, height) {
	const CANVAS_W = 4000;
	const CANVAS_H = 3000;
	const STEP = 20;

	for (let y = 0; y <= CANVAS_H - height; y += STEP) {
		for (let x = 0; x <= CANVAS_W - width; x += STEP) {
			const overlaps = existingTiles.some((t) =>
				x < t.x + t.width &&
				x + width > t.x &&
				y < t.y + t.height &&
				y + height > t.y,
			);
			if (!overlaps) return { x, y };
		}
	}

	const last = existingTiles[existingTiles.length - 1];
	if (last) return { x: last.x + 40, y: last.y + 40 };
	return { x: 40, y: 40 };
}

/**
 * Create the canvas RPC request handler.
 *
 * Methods: tileList, tileCreate, tileRemove, tileMove, tileResize,
 *          viewportGet, viewportSet, terminalWrite, terminalRead,
 *          tileFocus, browserNavigate, browserScreenshot,
 *          browserSnapshot, browserClick, browserType,
 *          browserScroll, browserEvaluate, browserWait,
 *          browserInfo.
 */
export function createCanvasRpc({
	tileManager, viewportState, viewport, edgeIndicators,
}) {
	function respond(requestId, result) {
		window.shellApi.canvasRpcResponse({ requestId, result });
	}

	function respondError(requestId, code, message) {
		window.shellApi.canvasRpcResponse({
			requestId, error: { code, message },
		});
	}

	function requireTile(requestId, tileId) {
		const tile = getTile(tileId);
		if (!tile) {
			respondError(requestId, 3, "Tile not found");
			return null;
		}
		return tile;
	}

	function requireBrowserWcId(requestId, tileId) {
		const tile = requireTile(requestId, tileId);
		if (!tile) return null;
		if (tile.type !== "browser") {
			respondError(requestId, 4, "Tile is not a browser");
			return null;
		}
		const dom = tileManager.getTileDOMs().get(tileId);
		if (!dom || !dom.webview) {
			respondError(requestId, 4, "Browser webview not ready");
			return null;
		}
		return dom.webview.getWebContentsId();
	}

	return async function handleCanvasRpc(request) {
		const { requestId, method, params } = request;

		try {
			let result;
			switch (method) {
				case "tileList": {
					result = {
						tiles: tiles.map((t) => ({
							id: t.id,
							type: t.type,
							filePath: t.filePath,
							folderPath: t.folderPath,
							url: t.url,
							cwd: t.cwd,
							ptySessionId: t.ptySessionId,
							userTitle: t.userTitle,
							agentTitle: t.agentTitle,
							position: { x: t.x, y: t.y },
							size: { width: t.width, height: t.height },
							zIndex: t.zIndex,
						})),
					};
					break;
				}
				case "tileCreate": {
					const tileType = params.tileType || "note";
					const size = defaultSize(tileType);
					const pos = params.position
						? { x: params.position.x, y: params.position.y }
						: findAutoPlacement(tiles, size.width, size.height);

					let tile;
					if (tileType === "term") {
						tile = tileManager.createCanvasTile(
							"term", pos.x, pos.y,
						);
						tileManager.spawnTerminalWebview(tile);
					} else if (tileType === "browser") {
						tile = tileManager.createCanvasTile(
							"browser", pos.x, pos.y, { url: params.url },
						);
						tileManager.spawnBrowserWebview(tile, false);
					} else if (tileType === "pdf") {
						tile = tileManager.createFileTile(
							"pdf", pos.x, pos.y, params.filePath,
						);
					} else if (tileType === "graph") {
						const wsPath = "";
						tile = tileManager.createGraphTile(
							pos.x, pos.y, params.filePath, wsPath,
						);
					} else {
						tile = tileManager.createFileTile(
							tileType, pos.x, pos.y, params.filePath,
						);
					}
					tileManager.saveCanvasImmediate();
					result = { tileId: tile.id };
					break;
				}
				case "tileRemove": {
					if (!requireTile(requestId, params.tileId)) return;
					tileManager.closeCanvasTile(params.tileId);
					result = {};
					break;
				}
				case "tileMove": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					const mx = params.position?.x;
					const my = params.position?.y;
					if (!Number.isFinite(mx) || !Number.isFinite(my)) {
						respondError(requestId, 4, "Invalid position");
						return;
					}
					tile.x = mx;
					tile.y = my;
					snapToGrid(tile);
					tileManager.repositionAllTiles();
					tileManager.saveCanvasImmediate();
					result = {};
					break;
				}
				case "tileResize": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					const rw = params.size?.width;
					const rh = params.size?.height;
					if (!Number.isFinite(rw) || !Number.isFinite(rh)) {
						respondError(requestId, 4, "Invalid size");
						return;
					}
					tile.width = rw;
					tile.height = rh;
					snapToGrid(tile);
					tileManager.repositionAllTiles();
					tileManager.saveCanvasImmediate();
					result = {};
					break;
				}
				case "viewportGet": {
					result = {
						pan: {
							x: viewportState.panX,
							y: viewportState.panY,
						},
						zoom: viewportState.zoom,
					};
					break;
				}
				case "viewportSet": {
					if (params.pan) {
						viewportState.panX = params.pan.x;
						viewportState.panY = params.pan.y;
					}
					if (params.zoom !== undefined) {
						viewportState.zoom = params.zoom;
					}
					viewport.updateCanvas();
					tileManager.saveCanvasDebounced();
					result = {};
					break;
				}
				case "terminalWrite": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "term") {
						respondError(requestId, 4, "Tile is not a terminal");
						return;
					}
					if (!tile.ptySessionId) {
						respondError(requestId, 4, "Terminal has no session");
						return;
					}
					window.shellApi.ptyWrite(
						tile.ptySessionId, params.input,
					);
					result = {};
					break;
				}
				case "terminalRead": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "term") {
						respondError(requestId, 4, "Tile is not a terminal");
						return;
					}
					if (!tile.ptySessionId) {
						respondError(requestId, 4, "Terminal has no session");
						return;
					}
					const lines = params.lines ?? 50;
					const output = await window.shellApi.ptyCapture(
						tile.ptySessionId, lines,
					);
					result = { output };
					break;
				}
				case "browserNavigate": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "browser") {
						respondError(requestId, 4, "Tile is not a browser");
						return;
					}
					const dom = tileManager.getTileDOMs().get(tile.id);
					if (!dom?.webview) {
						respondError(requestId, 4, "Browser has no webview");
						return;
					}
					const wcId = dom.webview.getWebContentsId();
					result = await window.shellApi.browserNavigate(wcId, params.url);
					tile.url = params.url;
					if (dom.urlInput) dom.urlInput.value = params.url;
					break;
				}
				case "browserScreenshot": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "browser") {
						respondError(requestId, 4, "Tile is not a browser");
						return;
					}
					const dom = tileManager.getTileDOMs().get(tile.id);
					if (!dom?.webview) {
						respondError(requestId, 4, "Browser has no webview");
						return;
					}
					const wcId = dom.webview.getWebContentsId();
					result = await window.shellApi.browserScreenshot(wcId);
					break;
				}
				case "browserSnapshot": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "browser") {
						respondError(requestId, 4, "Tile is not a browser");
						return;
					}
					const dom = tileManager.getTileDOMs().get(tile.id);
					if (!dom?.webview) {
						respondError(requestId, 4, "Browser has no webview");
						return;
					}
					const wcId = dom.webview.getWebContentsId();
					result = await window.shellApi.browserSnapshot(wcId);
					break;
				}
				case "browserClick": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "browser") {
						respondError(requestId, 4, "Tile is not a browser");
						return;
					}
					const dom = tileManager.getTileDOMs().get(tile.id);
					if (!dom?.webview) {
						respondError(requestId, 4, "Browser has no webview");
						return;
					}
					const wcId = dom.webview.getWebContentsId();
					result = await window.shellApi.browserClick(wcId, params.selector);
					break;
				}
				case "browserType": {
					const tile = requireTile(requestId, params.tileId);
					if (!tile) return;
					if (tile.type !== "browser") {
						respondError(requestId, 4, "Tile is not a browser");
						return;
					}
					const dom = tileManager.getTileDOMs().get(tile.id);
					if (!dom?.webview) {
						respondError(requestId, 4, "Browser has no webview");
						return;
					}
					const wcId = dom.webview.getWebContentsId();
					result = await window.shellApi.browserType(
						wcId, params.selector, params.text,
					);
					break;
				}
				case "browserScroll": {
					const wcId = requireBrowserWcId(
						requestId, params.tileId,
					);
					if (wcId == null) return;
					result = await window.shellApi.browserScroll(
						wcId, params.x ?? 0, params.y ?? 0,
					);
					break;
				}
				case "browserEvaluate": {
					const wcId = requireBrowserWcId(
						requestId, params.tileId,
					);
					if (wcId == null) return;
					result = await window.shellApi.browserEvaluate(
						wcId, params.expression,
					);
					break;
				}
				case "browserWait": {
					const wcId = requireBrowserWcId(
						requestId, params.tileId,
					);
					if (wcId == null) return;
					result = await window.shellApi.browserWait(
						wcId, params.timeout,
					);
					break;
				}
				case "browserInfo": {
					const wcId = requireBrowserWcId(
						requestId, params.tileId,
					);
					if (wcId == null) return;
					result = await window.shellApi.browserInfo(wcId);
					break;
				}
				case "tileFocus": {
					const ids = params.tileIds;
					if (!Array.isArray(ids) || ids.length === 0) {
						respondError(
							requestId, 4,
							"tileIds must be a non-empty array",
						);
						return;
					}
					const focusTiles = [];
					for (const id of ids) {
						const t = getTile(id);
						if (!t) {
							respondError(
								requestId, 3, `Tile not found: ${id}`,
							);
							return;
						}
						focusTiles.push(t);
					}
					edgeIndicators.panToTiles(focusTiles);
					result = {};
					break;
				}
				default: {
					respondError(
						requestId, -32601,
						`Unknown method: ${method}`,
					);
					return;
				}
			}
			respond(requestId, result);
		} catch (err) {
			respondError(
				requestId, -32603,
				err.message || "Internal error",
			);
		}
	};
}
