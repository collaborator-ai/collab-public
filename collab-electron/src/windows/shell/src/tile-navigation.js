/**
 * Navigation policy for selecting a tile (from the sidebar terminal tree,
 * keyboard navigation, etc.).
 *
 * While a tile is fullscreen the other tiles are hidden, so selecting a
 * different tile must swap the fullscreen view to it rather than panning the
 * (invisible) canvas. Selecting the already-fullscreen tile is a no-op.
 * Otherwise a plain selection pans to the tile, and a focusing selection also
 * gives it keyboard focus.
 *
 * @param {object} args
 * @param {string|null} args.fullscreenTileId currently fullscreen tile, if any
 * @param {string} args.targetTileId tile being selected
 * @param {boolean} args.focus whether the selection should focus the tile
 * @returns {{kind: "swap-fullscreen" | "none" | "pan" | "pan-and-focus"}}
 */
export function resolveTileNavigation({ fullscreenTileId, targetTileId, focus }) {
	if (fullscreenTileId) {
		return fullscreenTileId === targetTileId
			? { kind: "none" }
			: { kind: "swap-fullscreen" };
	}
	return { kind: focus ? "pan-and-focus" : "pan" };
}
