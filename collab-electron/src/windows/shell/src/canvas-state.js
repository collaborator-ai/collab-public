/**
 * @typedef {'term' | 'note' | 'code' | 'image' | 'graph' | 'browser' | 'pdf'} TileType
 *
 * @typedef {Object} Tile
 * @property {string} id
 * @property {TileType} type
 * @property {number} x - Canvas X coordinate
 * @property {number} y - Canvas Y coordinate
 * @property {number} width - Canvas width
 * @property {number} height - Canvas height
 * @property {string} [filePath] - For file tiles
 * @property {string} [folderPath] - For graph tiles
 * @property {string} [url] - URL for browser tiles
 * @property {string} [cwd] - Working directory for terminal tiles
 * @property {string} [ptySessionId] - PTY session ID for terminal tiles
 * @property {string} [userTitle] - Title set by the user (wins over agentTitle)
 * @property {string} [agentTitle] - Title set by the agent (CLI or window title)
 * @property {number} zIndex - Stacking order
 */

/** @type {Tile[]} */
export const tiles = [];

let nextZIndex = 1;

const DEFAULT_TILE_SIZES = {
	term: { width: 400, height: 500 },
	note: { width: 440, height: 540 },
	code: { width: 440, height: 540 },
	image: { width: 280, height: 280 },
	graph: { width: 600, height: 500 },
	browser: { width: 800, height: 650 },
	pdf: { width: 600, height: 800 },
};

/** @param {TileType} type */
export function defaultSize(type) {
	return { ...DEFAULT_TILE_SIZES[type] };
}

let idCounter = 0;

export function generateId() {
	idCounter++;
	return `tile-${Date.now()}-${idCounter}`;
}

export function bringToFront(tile) {
	nextZIndex++;
	tile.zIndex = nextZIndex;
}

export function removeTile(id) {
	const idx = tiles.findIndex((t) => t.id === id);
	if (idx !== -1) tiles.splice(idx, 1);
}

export function addTile(tile) {
	if (!tile.zIndex) {
		nextZIndex++;
		tile.zIndex = nextZIndex;
	}
	tiles.push(tile);
	return tile;
}

export function getTile(id) {
	return tiles.find((t) => t.id === id) || null;
}

const IMAGE_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
]);

const GRID_CELL = 20;

/** Snap tile position and size to the minor grid. */
export function snapToGrid(tile) {
	tile.x = Math.round(tile.x / GRID_CELL) * GRID_CELL;
	tile.y = Math.round(tile.y / GRID_CELL) * GRID_CELL;
	tile.width = Math.round(tile.width / GRID_CELL) * GRID_CELL;
	tile.height = Math.round(tile.height / GRID_CELL) * GRID_CELL;
}

// ── Selection state ──

/** @type {Set<string>} */
const selectedTileIds = new Set();

/** @param {string} id */
export function selectTile(id) {
	selectedTileIds.add(id);
}

/** @param {string} id */
export function deselectTile(id) {
	selectedTileIds.delete(id);
}

/** @param {string} id */
export function toggleTileSelection(id) {
	if (selectedTileIds.has(id)) {
		selectedTileIds.delete(id);
	} else {
		selectedTileIds.add(id);
	}
}

export function clearSelection() {
	selectedTileIds.clear();
}

/** @param {string} id */
export function isSelected(id) {
	return selectedTileIds.has(id);
}

/** @returns {Tile[]} */
export function getSelectedTiles() {
	return tiles.filter((t) => selectedTileIds.has(t.id));
}

/** @returns {{ x: number, y: number }} */
function tileCenter(tile) {
	return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
}

/**
 * Returns the nearest tile in the given cardinal direction from fromId,
 * using a 120° forward cone filter (±60° from the axis).
 * @param {string|null} fromId - ID of focused tile, or null to use originX/Y
 * @param {'left'|'right'|'up'|'down'} direction
 * @param {number} [originX=0] - Canvas-space X when fromId is null
 * @param {number} [originY=0] - Canvas-space Y when fromId is null
 * @returns {Tile|null}
 */
export function getNearestTileInDirection(fromId, direction, originX = 0, originY = 0) {
	const from = fromId ? tiles.find((t) => t.id === fromId) : null;
	const fc = from ? tileCenter(from) : { x: originX, y: originY };

	const axisVec = {
		right: { dx: 1, dy: 0 }, left: { dx: -1, dy: 0 },
		down: { dx: 0, dy: 1 }, up: { dx: 0, dy: -1 },
	}[direction];

	const CONE_HALF = Math.PI / 3; // 60 degrees each side = 120° total cone

	const candidates = tiles
		.filter((t) => t.id !== fromId)
		.map((t) => {
			const tc = tileCenter(t);
			const dx = tc.x - fc.x;
			const dy = tc.y - fc.y;
			const dot = dx * axisVec.dx + dy * axisVec.dy;
			if (dot <= 0) return null;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (Math.acos(dot / dist) > CONE_HALF) return null;
			return { tile: t, dist };
		})
		.filter(Boolean);

	if (!candidates.length) return null;
	candidates.sort((a, b) => a.dist - b.dist);
	return candidates[0].tile;
}

/** @returns {Tile | null} */
export function tileAtPoint(cx, cy) {
	const sorted = [...tiles].sort((a, b) => b.zIndex - a.zIndex);
	for (const tile of sorted) {
		if (
			cx >= tile.x && cx < tile.x + tile.width &&
			cy >= tile.y && cy < tile.y + tile.height
		) {
			return tile;
		}
	}
	return null;
}

export function inferTileType(filePath) {
	const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	if (ext === ".md") return "note";
	if (ext === ".pdf") return "pdf";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	return "code";
}
