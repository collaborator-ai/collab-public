import type { Annotation, AnnotationLineConnected } from "./annotation-manager.js";
import {
	annotations,
	addAnnotation,
	removeAnnotation,
	updateAnnotation,
	convertToFreeLine,
	getAnnotation,
	getDefaultAnnotationColor,
	setDrawMode,
	getDrawMode,
	isAnnotationSelected,
	getSelectedAnnotations,
} from "./annotation-manager.js";

const TRASH_SVG = `<svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor"><path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16H56V208a16,16,0,0,0,16,16H184a16,16,0,0,0,16-16V64h16a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm88,168H72V64H184ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/></svg>`;

type TileLike = {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	zIndex: number;
};

type AnnotationRendererOpts = {
	annotationLayer: HTMLElement;
	annotationSvg: SVGSVGElement;
	viewportState: { panX: number; panY: number; zoom: number };
	canvasEl: HTMLElement;
	getTiles: () => TileLike[];
	getTileDOMs: () => Map<string, { container: HTMLElement }>;
	onSave: () => void;
	onModeChange: (mode: string) => void;
	getSelectedTiles?: () => TileLike[];
	onTileGroupDragMove?: () => void;
};

export function createAnnotationRenderer({
	annotationLayer,
	annotationSvg,
	viewportState,
	canvasEl,
	getTiles,
	getTileDOMs,
	onSave,
	onModeChange,
	getSelectedTiles,
	onTileGroupDragMove,
}: AnnotationRendererOpts) {
	const domMap = new Map<string, HTMLElement | SVGGElement>();

	// ── SVG tile-mask — hides annotations where tiles sit ──────────
	// Uses an SVG <mask>: white bg (show all) + black rects per tile (hide).
	// Updated on every reposition so lines vanish cleanly behind tiles
	// even when tiles have reduced opacity from the canvas opacity setting.

	const svgDefs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
	annotationSvg.appendChild(svgDefs);

	const tileMask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
	tileMask.id = "ann-tile-mask";
	const tileMaskBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
	tileMaskBg.setAttribute("x", "-99999");
	tileMaskBg.setAttribute("y", "-99999");
	tileMaskBg.setAttribute("width", "199999");
	tileMaskBg.setAttribute("height", "199999");
	tileMaskBg.setAttribute("fill", "white");
	tileMask.appendChild(tileMaskBg);
	svgDefs.appendChild(tileMask);

	// All annotation SVG elements live inside this masked group
	const annotationGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
	annotationGroup.setAttribute("mask", "url(#ann-tile-mask)");
	annotationSvg.appendChild(annotationGroup);

	function updateTileMask() {
		// Remove previous tile rects (everything after the background rect)
		while (tileMask.children.length > 1) {
			tileMask.removeChild(tileMask.lastChild!);
		}
		for (const tile of getTiles()) {
			const { x: sx, y: sy } = c2s(tile.x, tile.y);
			const w = tile.width * viewportState.zoom;
			const h = tile.height * viewportState.zoom;
			const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
			r.setAttribute("x", String(sx));
			r.setAttribute("y", String(sy));
			r.setAttribute("width", String(w));
			r.setAttribute("height", String(h));
			r.setAttribute("fill", "black");
			tileMask.appendChild(r);
		}
	}

	// ── Coordinate helpers ──────────────────────────────────────────

	function c2s(cx: number, cy: number) {
		return {
			x: cx * viewportState.zoom + viewportState.panX,
			y: cy * viewportState.zoom + viewportState.panY,
		};
	}

	function s2c(sx: number, sy: number) {
		return {
			x: (sx - viewportState.panX) / viewportState.zoom,
			y: (sy - viewportState.panY) / viewportState.zoom,
		};
	}

	// ── Positioning ─────────────────────────────────────────────────

	function positionRect(g: SVGGElement, ann: import("./annotation-manager.js").AnnotationRect) {
		const { x, y } = c2s(ann.x, ann.y);
		const w = ann.width * viewportState.zoom;
		const h = ann.height * viewportState.zoom;
		for (const rect of g.querySelectorAll("rect")) {
			rect.setAttribute("x", String(x));
			rect.setAttribute("y", String(y));
			rect.setAttribute("width", String(w));
			rect.setAttribute("height", String(h));
		}
		g.querySelector(".ann-rect-visual")?.setAttribute("stroke", ann.color);
	}

	function positionText(el: HTMLElement, ann: import("./annotation-manager.js").AnnotationText) {
		const { x, y } = c2s(ann.x, ann.y);
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
		el.style.color = ann.color;
		el.style.fontSize = `${ann.fontSize * viewportState.zoom}px`;
	}

	function getLineScreenCoords(ann: import("./annotation-manager.js").AnnotationLineFree | AnnotationLineConnected) {
		if (ann.mode === "free") {
			const p1 = c2s(ann.x1, ann.y1);
			const p2 = c2s(ann.x2, ann.y2);
			return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
		}
		// connected: derive from tile centers
		const tileList = getTiles();
		const from = tileList.find((t) => t.id === ann.fromTileId);
		const to = tileList.find((t) => t.id === ann.toTileId);
		if (!from || !to) return null;
		const p1 = c2s(from.x + from.width / 2, from.y + from.height / 2);
		const p2 = c2s(to.x + to.width / 2, to.y + to.height / 2);
		return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
	}

	function positionLine(group: SVGGElement, ann: import("./annotation-manager.js").AnnotationLineFree | AnnotationLineConnected) {
		const coords = getLineScreenCoords(ann);
		if (!coords) return;
		const { x1, y1, x2, y2 } = coords;
		for (const line of group.querySelectorAll("line")) {
			line.setAttribute("x1", String(x1));
			line.setAttribute("y1", String(y1));
			line.setAttribute("x2", String(x2));
			line.setAttribute("y2", String(y2));
		}
	}

	function positionById(id: string) {
		const ann = getAnnotation(id);
		const el = domMap.get(id);
		if (!ann || !el) return;
		if (ann.type === "rect") positionRect(el as SVGGElement, ann);
		else if (ann.type === "text") positionText(el as HTMLElement, ann);
		else if (ann.type === "line") positionLine(el as SVGGElement, ann);
	}

	// ── Popover ─────────────────────────────────────────────────────

	let activePopover: HTMLElement | null = null;
	let activePopoverAnnId: string | null = null;
	let activePopoverResizeHandler: (() => void) | null = null;

	function dismissPopover() {
		if (activePopover) {
			activePopover.remove();
			activePopover = null;
			activePopoverAnnId = null;
		}
		if (activePopoverResizeHandler) {
			window.removeEventListener("resize", activePopoverResizeHandler);
			activePopoverResizeHandler = null;
		}
	}

	function showPopover(ann: Annotation, anchorEl: Element) {
		dismissPopover();

		const pop = document.createElement("div");
		pop.className = "annotation-popover";
		pop.style.visibility = "hidden";

		// Trash
		const trash = document.createElement("button");
		trash.className = "ann-pop-trash";
		trash.innerHTML = TRASH_SVG;
		trash.title = "Delete";
		trash.addEventListener("click", (e) => {
			e.stopPropagation();
			domMap.get(ann.id)?.remove();
			domMap.delete(ann.id);
			removeAnnotation(ann.id);
			onSave();
			dismissPopover();
		});
		pop.appendChild(trash);

		// Color picker + hex input
		const colorPicker = document.createElement("input");
		colorPicker.type = "color";
		colorPicker.className = "ann-pop-color-picker";
		colorPicker.value = ann.color;
		colorPicker.addEventListener("click", (e) => e.stopPropagation());

		const hexWrap = document.createElement("div");
		hexWrap.className = "ann-pop-hex-wrap";
		const hashSpan = document.createElement("span");
		hashSpan.textContent = "#";
		const hexInput = document.createElement("input");
		hexInput.type = "text";
		hexInput.className = "ann-pop-hex";
		hexInput.maxLength = 6;
		hexInput.value = ann.color.replace("#", "");

		function applyColor(val: string) {
			updateAnnotation(ann.id, { color: val });
			const el = domMap.get(ann.id);
			if (el) {
				if (ann.type === "rect") el.querySelector(".ann-rect-visual")?.setAttribute("stroke", val);
				else if (ann.type === "text") el.style.color = val;
				else if (ann.type === "line") el.querySelector(".ann-line-visual")?.setAttribute("stroke", val);
			}
			onSave();
		}

		colorPicker.addEventListener("input", () => {
			hexInput.value = colorPicker.value.replace("#", "");
			applyColor(colorPicker.value);
		});

		hexInput.addEventListener("input", () => {
			const val = "#" + hexInput.value;
			if (/^#[0-9a-fA-F]{6}$/.test(val)) {
				colorPicker.value = val;
				applyColor(val);
			}
		});
		hexInput.addEventListener("click", (e) => e.stopPropagation());
		hexInput.addEventListener("keydown", (e) => e.stopPropagation());

		pop.appendChild(colorPicker);
		hexWrap.appendChild(hashSpan);
		hexWrap.appendChild(hexInput);
		pop.appendChild(hexWrap);

		// Font size buttons for text
		if (ann.type === "text") {
			const fontUp = document.createElement("button");
			fontUp.className = "ann-pop-font ann-pop-font-up";
			fontUp.textContent = "A";
			fontUp.title = "Increase font size";
			fontUp.addEventListener("click", (e) => {
				e.stopPropagation();
				const newSize = (ann.fontSize ?? 16) + 2;
				updateAnnotation(ann.id, { fontSize: newSize });
				const el = domMap.get(ann.id);
				if (el) el.style.fontSize = `${newSize * viewportState.zoom}px`;
				onSave();
			});

			const fontDown = document.createElement("button");
			fontDown.className = "ann-pop-font ann-pop-font-down";
			fontDown.textContent = "a";
			fontDown.title = "Decrease font size";
			fontDown.addEventListener("click", (e) => {
				e.stopPropagation();
				const newSize = Math.max(8, (ann.fontSize ?? 16) - 2);
				updateAnnotation(ann.id, { fontSize: newSize });
				const el = domMap.get(ann.id);
				if (el) el.style.fontSize = `${newSize * viewportState.zoom}px`;
				onSave();
			});

			pop.appendChild(fontUp);
			pop.appendChild(fontDown);
		}

		document.body.appendChild(pop);
		activePopover = pop;
		activePopoverAnnId = ann.id;

		// Position above anchor (clamped to viewport).
		// Use rAF to ensure layout is complete before reading getBoundingClientRect.
		function positionPopover() {
			const ar = anchorEl.getBoundingClientRect();
			const pr = pop.getBoundingClientRect();
			let left = ar.left + ar.width / 2 - pr.width / 2;
			let top = ar.top - pr.height - 8;
			left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
			if (top < 8) top = ar.bottom + 8;
			pop.style.left = `${left}px`;
			pop.style.top = `${top}px`;
			pop.style.visibility = "visible";
		}

		requestAnimationFrame(positionPopover);
		activePopoverResizeHandler = positionPopover;
		window.addEventListener("resize", positionPopover);
	}

	// ── Drag on existing annotations ────────────────────────────────

	// Guard against accumulating multiple simultaneous drag listener sets
	// (e.g. if mouseup was missed because the window lost focus mid-drag).
	let isDragging = false;

	function attachAnnotationDrag(el: HTMLElement | SVGElement, ann: Annotation) {
		el.addEventListener("mousedown", (rawE) => {
			const e = rawE as MouseEvent;
			if (e.button !== 0) return;
			if (isDragging) return;
			isDragging = true;
			e.stopPropagation();

			const startClientX = e.clientX;
			const startClientY = e.clientY;
			let dragged = false;

			// Determine if this is a group drag (annotation is part of a multi-selection)
			const selectedAnns = getSelectedAnnotations();
			const isGroupDrag = selectedAnns.length > 1 && isAnnotationSelected(ann.id);

			// Snapshot start canvas coords for all group members (or just this annotation)
			const dragGroup = isGroupDrag ? selectedAnns : [ann];

			// Snapshot selected tile positions for cross-system group drag
			const annIsSelected = isAnnotationSelected(ann.id);
			const tileDragGroup = annIsSelected && getSelectedTiles
				? (getSelectedTiles() ?? []).map((t) => ({ tile: t, startX: t.x, startY: t.y }))
				: [];

			type Snap = {
				ann: Annotation;
				connected?: boolean;
				x?: number;
				y?: number;
				x1?: number;
				y1?: number;
				x2?: number;
				y2?: number;
			};
			const snapshots: Snap[] = dragGroup.map((a) => {
				if (a.type === "line") {
					if (a.mode === "free") {
						return { ann: a, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 };
					}
					// connected lines: snapshot tile-center screen coords, converted to free on drag
					return { ann: a, connected: true };
				}
				return { ann: a, x: a.x, y: a.y };
			});

			function onMove(ev: MouseEvent) {
				const dx = ev.clientX - startClientX;
				const dy = ev.clientY - startClientY;

				if (!dragged && Math.hypot(dx, dy) > 4) {
					dragged = true;
					dismissPopover();

					// Convert connected lines to free on first drag —
					// but only when dragging the line individually (not as part of a group
					// selection, where tiles move too and the line should stay anchored).
					if (!isGroupDrag) {
						for (const snap of snapshots) {
							if (snap.connected) {
								const coords = getLineScreenCoords(snap.ann as AnnotationLineConnected);
								if (coords) {
									const c1 = s2c(coords.x1, coords.y1);
									const c2 = s2c(coords.x2, coords.y2);
									// Use convertToFreeLine to replace the object in-place,
									// avoiding stale fromTileId/toTileId keys in serialization.
									const freed = convertToFreeLine(snap.ann.id, {
										x1: c1.x, y1: c1.y,
										x2: c2.x, y2: c2.y,
									});
									if (freed) {
										snap.x1 = freed.x1;
										snap.y1 = freed.y1;
										snap.x2 = freed.x2;
										snap.y2 = freed.y2;
										snap.connected = false;
									}
								}
							}
						}
					}
				}
				if (!dragged) return;

				const dcx = dx / viewportState.zoom;
				const dcy = dy / viewportState.zoom;

				for (const snap of snapshots) {
					const a = snap.ann;
					// Skip connected lines in a group drag — they track their tiles via onTileMoved
					if (snap.connected) continue;
					if (a.type === "rect" || a.type === "text") {
						updateAnnotation(a.id, { x: snap.x! + dcx, y: snap.y! + dcy });
					} else if (a.type === "line") {
						updateAnnotation(a.id, {
							x1: snap.x1! + dcx, y1: snap.y1! + dcy,
							x2: snap.x2! + dcx, y2: snap.y2! + dcy,
						});
					}
					positionById(a.id);
				}

				// Also move selected tiles
				if (tileDragGroup.length > 0) {
					for (const { tile, startX, startY } of tileDragGroup) {
						tile.x = startX + dcx;
						tile.y = startY + dcy;
					}
					onTileGroupDragMove?.();
				}
			}

			function cleanup() {
				document.removeEventListener("mousemove", onMove);
				document.removeEventListener("mouseup", onUp);
				window.removeEventListener("blur", cleanup);
				isDragging = false;
			}

			function onUp() {
				cleanup();
				if (dragged) {
					onSave();
				} else {
					showPopover(ann, el as HTMLElement);
				}
			}

			document.addEventListener("mousemove", onMove);
			document.addEventListener("mouseup", onUp);
			window.addEventListener("blur", cleanup);
		});
	}

	// ── DOM creation ────────────────────────────────────────────────

	function createRectEl(ann: import("./annotation-manager.js").AnnotationRect) {
		const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
		g.dataset.annId = ann.id;

		// Wide invisible hit target on the stroke only — interior is transparent to events
		const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		hit.setAttribute("fill", "none");
		hit.setAttribute("stroke", "transparent");
		hit.setAttribute("stroke-width", "10");
		hit.setAttribute("rx", "8");
		hit.style.pointerEvents = "stroke";
		hit.style.cursor = "move";

		// Visible border
		const visual = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		visual.classList.add("ann-rect-visual");
		visual.setAttribute("fill", "none");
		visual.setAttribute("stroke", ann.color);
		visual.setAttribute("stroke-width", "2");
		visual.setAttribute("rx", "8");
		visual.style.pointerEvents = "none";

		g.appendChild(hit);
		g.appendChild(visual);
		annotationGroup.appendChild(g);
		positionRect(g, ann);
		attachAnnotationDrag(hit, ann);
		return g;
	}

	function createTextEl(ann: import("./annotation-manager.js").AnnotationText) {
		const el = document.createElement("div");
		el.className = "annotation-text";
		el.dataset.annId = ann.id;
		el.textContent = ann.content;
		positionText(el, ann);
		attachAnnotationDrag(el, ann);

		el.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			dismissPopover();

			// Hide the live label and show an editor in its place
			el.style.visibility = "hidden";

			const editor = document.createElement("div");
			editor.className = "annotation-text-editor";
			editor.contentEditable = "true";
			editor.style.left = el.style.left;
			editor.style.top = el.style.top;
			editor.style.color = ann.color;
			editor.style.fontSize = el.style.fontSize;
			editor.textContent = ann.content;
			annotationLayer.appendChild(editor);

			// Select all text so the user can type over it or position cursor
			requestAnimationFrame(() => {
				editor.focus();
				const range = document.createRange();
				range.selectNodeContents(editor);
				const sel = window.getSelection();
				sel?.removeAllRanges();
				sel?.addRange(range);
			});

			let committed = false;

			function commit() {
				if (committed) return;
				committed = true;
				const content = editor.textContent?.trim() ?? "";
				editor.remove();
				if (content) {
					updateAnnotation(ann.id, { content });
					el.textContent = content;
					el.style.visibility = "";
				} else {
					// User cleared the text — remove the annotation entirely
					el.remove();
					domMap.delete(ann.id);
					removeAnnotation(ann.id);
				}
				onSave();
			}

			editor.addEventListener("blur", commit, { once: true });
			editor.addEventListener("keydown", (e) => {
				e.stopPropagation();
				if (e.key === "Escape" && !committed) {
					committed = true;
					editor.removeEventListener("blur", commit);
					editor.remove();
					el.style.visibility = "";
				}
			});
		});

		annotationLayer.appendChild(el);
		return el;
	}

	function createLineGroup(ann: import("./annotation-manager.js").AnnotationLineFree | AnnotationLineConnected) {
		const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
		g.dataset.annId = ann.id;

		// Wide invisible hit target
		const hit = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"line",
		);
		hit.classList.add("ann-line-hit");
		hit.setAttribute("stroke", "transparent");
		hit.setAttribute("stroke-width", "12");
		hit.setAttribute("stroke-linecap", "round");
		hit.style.cursor = "move";
		hit.style.pointerEvents = "stroke";

		// Visible line
		const visual = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"line",
		);
		visual.classList.add("ann-line-visual");
		visual.setAttribute("stroke", ann.color);
		visual.setAttribute("stroke-width", "2");
		visual.setAttribute("stroke-linecap", "round");
		visual.style.pointerEvents = "none";

		g.appendChild(hit);
		g.appendChild(visual);
		annotationGroup.appendChild(g);
		positionLine(g, ann);
		attachAnnotationDrag(hit, ann);
		return g;
	}

	function renderAnnotation(ann: Annotation) {
		let el;
		if (ann.type === "rect") el = createRectEl(ann);
		else if (ann.type === "text") el = createTextEl(ann);
		else if (ann.type === "line") el = createLineGroup(ann);
		else return;
		domMap.set(ann.id, el);
	}

	// ── Draw interactions ────────────────────────────────────────────

	// Preview elements
	let previewEl: HTMLElement | SVGGElement | null = null; // rect div or SVG g for line
	let drawStartClientX = 0;
	let drawStartClientY = 0;
	let drawStartCX = 0;
	let drawStartCY = 0;

	// Line connected-mode state
	let linePhase1: { fromTileId: string; previewLine: SVGGElement } | null = null;

	function clearPreview() {
		if (previewEl) {
			previewEl.remove();
			previewEl = null;
		}
	}

	function cancelLinePhase1() {
		if (linePhase1?.previewLine) linePhase1.previewLine.remove();
		clearAllLineHighlights();
		linePhase1 = null;
	}

	/** Hit test canvas coords against tiles. */
	function tileAtCanvasPoint(cx: number, cy: number) {
		const tileList = [...getTiles()].sort((a, b) => b.zIndex - a.zIndex);
		for (const t of tileList) {
			if (
				cx >= t.x &&
				cx < t.x + t.width &&
				cy >= t.y &&
				cy < t.y + t.height
			) {
				return t;
			}
		}
		return null;
	}

	/** Set highlight on a tile container. */
	function setTileHighlight(tileId: string, active: boolean) {
		const dom = getTileDOMs().get(tileId);
		if (dom) {
			dom.container.classList.toggle("annotation-line-target", active);
		}
	}

	let lineHoverTileId: string | null = null;

	function setLineHover(tileId: string | null) {
		if (lineHoverTileId === tileId) return;
		if (lineHoverTileId) {
			getTileDOMs().get(lineHoverTileId)?.container.classList.remove("annotation-line-hover");
		}
		lineHoverTileId = tileId;
		if (tileId) {
			getTileDOMs().get(tileId)?.container.classList.add("annotation-line-hover");
		}
	}

	function clearAllLineHighlights() {
		for (const [, dom] of getTileDOMs()) {
			dom.container.classList.remove("annotation-line-hover", "annotation-line-source", "annotation-line-target");
		}
		lineHoverTileId = null;
	}

	// Hover highlight in draw-line mode — works both before and after first tile is selected
	canvasEl.addEventListener("mousemove", (e) => {
		if (getDrawMode() !== "draw-line") return;
		const rect = canvasEl.getBoundingClientRect();
		const { x: cx, y: cy } = s2c(e.clientX - rect.left, e.clientY - rect.top);
		const tile = tileAtCanvasPoint(cx, cy);
		const hoverId = (tile && tile.id !== linePhase1?.fromTileId) ? tile.id : null;
		setLineHover(hoverId);
	});

	// Canvas mousedown — handle draw modes
	canvasEl.addEventListener(
		"mousedown",
		(e) => {
			const mode = getDrawMode();
			if (mode === "pointer") return;
			if (e.button !== 0) return;

			// Block marquee and panning from firing
			e.stopImmediatePropagation();

			const rect = canvasEl.getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const { x: cx, y: cy } = s2c(sx, sy);

			if (mode === "draw-rect") {
				drawStartClientX = e.clientX;
				drawStartClientY = e.clientY;
				drawStartCX = cx;
				drawStartCY = cy;

				previewEl = document.createElement("div");
				previewEl.className = "annotation-preview-rect";
				previewEl.style.left = `${sx}px`;
				previewEl.style.top = `${sy}px`;
				previewEl.style.width = "0";
				previewEl.style.height = "0";
				annotationLayer.appendChild(previewEl);

				function onRectMove(ev: MouseEvent) {
					const cRect = canvasEl.getBoundingClientRect();
					const curSX = ev.clientX - cRect.left;
					const curSY = ev.clientY - cRect.top;
					const left = Math.min(
						drawStartCX * viewportState.zoom + viewportState.panX,
						curSX,
					);
					const top = Math.min(
						drawStartCY * viewportState.zoom + viewportState.panY,
						curSY,
					);
					const w = Math.abs(
						curSX -
							(drawStartCX * viewportState.zoom + viewportState.panX),
					);
					const h = Math.abs(
						curSY -
							(drawStartCY * viewportState.zoom + viewportState.panY),
					);
					if (previewEl) {
						previewEl.style.left = `${left}px`;
						previewEl.style.top = `${top}px`;
						previewEl.style.width = `${w}px`;
						previewEl.style.height = `${h}px`;
					}
				}

				function onRectUp(ev: MouseEvent) {
					document.removeEventListener("mousemove", onRectMove);
					document.removeEventListener("mouseup", onRectUp);
					clearPreview();

					const cRect = canvasEl.getBoundingClientRect();
					const curSX = ev.clientX - cRect.left;
					const curSY = ev.clientY - cRect.top;
					const { x: curCX, y: curCY } = s2c(curSX, curSY);

					const w = Math.abs(curCX - drawStartCX);
					const h = Math.abs(curCY - drawStartCY);
					if (w < 10 || h < 10) {
						// Too small — cancel
					} else {
						const color = getDefaultAnnotationColor();
						const ann = addAnnotation({
							type: "rect",
							x: Math.min(drawStartCX, curCX),
							y: Math.min(drawStartCY, curCY),
							width: w,
							height: h,
							color,
						});
						renderAnnotation(ann);
						onSave();
					}
					activateMode("pointer");
				}

				document.addEventListener("mousemove", onRectMove);
				document.addEventListener("mouseup", onRectUp);
			} else if (mode === "draw-text") {
				// Commit text immediately at click
				activateMode("pointer");
				spawnTextEditor(cx, cy);
			} else if (mode === "draw-line") {
				// Check if we're in phase 1 (waiting for second tile)
				if (linePhase1) {
					const targetTile = tileAtCanvasPoint(cx, cy);
					if (targetTile && targetTile.id !== linePhase1.fromTileId) {
						// Clicked a different tile → connected line
						const fromId = linePhase1.fromTileId;
						cancelLinePhase1();
						const color = getDefaultAnnotationColor();
						const ann = addAnnotation({
							type: "line",
							mode: "connected",
							fromTileId: fromId,
							toTileId: targetTile.id,
							color,
						});
						renderAnnotation(ann);
						onSave();
					} else {
						// Clicked canvas or same tile → free line from source center to here
						const phase1FromId = linePhase1!.fromTileId;
						const fromTile = getTiles().find((t) => t.id === phase1FromId);
						cancelLinePhase1();
						if (fromTile) {
							const color = getDefaultAnnotationColor();
							const ann = addAnnotation({
								type: "line",
								mode: "free",
								x1: fromTile.x + fromTile.width / 2,
								y1: fromTile.y + fromTile.height / 2,
								x2: cx,
								y2: cy,
								color,
							});
							renderAnnotation(ann);
							onSave();
						}
					}
					activateMode("pointer");
					return;
				}

				const tile = tileAtCanvasPoint(cx, cy);

				if (tile) {
					// Start connected-line phase 1 (detect click vs drag on mouseup)
					drawStartClientX = e.clientX;
					drawStartClientY = e.clientY;

					// Create a preview SVG line from tile center to cursor
					const g = document.createElementNS(
						"http://www.w3.org/2000/svg",
						"g",
					);
					const pl = document.createElementNS(
						"http://www.w3.org/2000/svg",
						"line",
					);
					pl.setAttribute("stroke", getDefaultAnnotationColor());
					pl.setAttribute("stroke-width", "2");
					pl.setAttribute("stroke-linecap", "round");
					pl.setAttribute("stroke-dasharray", "6 4");
					pl.style.pointerEvents = "none";
					g.appendChild(pl);
					annotationSvg.appendChild(g);

					const tileCenterS = c2s(
						tile.x + tile.width / 2,
						tile.y + tile.height / 2,
					);
					pl.setAttribute("x1", String(tileCenterS.x));
					pl.setAttribute("y1", String(tileCenterS.y));
					pl.setAttribute("x2", String(tileCenterS.x));
					pl.setAttribute("y2", String(tileCenterS.y));

					linePhase1 = { fromTileId: tile.id, previewLine: g };
					setLineHover(null);
					// Green border on the selected source tile
					getTileDOMs().get(tile.id)?.container.classList.add("annotation-line-source");

					let lineDragged = false;

					function onLineTileMove(ev: MouseEvent) {
						const dist = Math.hypot(
							ev.clientX - drawStartClientX,
							ev.clientY - drawStartClientY,
						);
						if (dist > 4) lineDragged = true;

						// Update preview line end
						const cRect = canvasEl.getBoundingClientRect();
						const curSX = ev.clientX - cRect.left;
						const curSY = ev.clientY - cRect.top;
						pl.setAttribute("x2", String(curSX));
						pl.setAttribute("y2", String(curSY));

					}

					function onLineTileUp(ev: MouseEvent) {
						document.removeEventListener("mousemove", onLineTileMove);
						document.removeEventListener("mouseup", onLineTileUp);

						const cRect = canvasEl.getBoundingClientRect();
						const curSX = ev.clientX - cRect.left;
						const curSY = ev.clientY - cRect.top;
						const { x: curCX, y: curCY } = s2c(curSX, curSY);

						if (lineDragged) {
							// Free line drag from tile center to release point
							cancelLinePhase1();
							const color = getDefaultAnnotationColor();
							const ann = addAnnotation({
								type: "line",
								mode: "free",
								x1: tile!.x + tile!.width / 2,
								y1: tile!.y + tile!.height / 2,
								x2: curCX,
								y2: curCY,
								color,
							});
							renderAnnotation(ann);
							onSave();
							activateMode("pointer");
						} else {
							// Click: stay in phase 1, waiting for second tile
							// (phase 1 active state is handled by subsequent mousedown)
						}
					}

					document.addEventListener("mousemove", onLineTileMove);
					document.addEventListener("mouseup", onLineTileUp);
				} else {
					// Free line drag on empty canvas
					drawStartClientX = e.clientX;
					drawStartClientY = e.clientY;
					drawStartCX = cx;
					drawStartCY = cy;

					const g = document.createElementNS(
						"http://www.w3.org/2000/svg",
						"g",
					);
					const pl = document.createElementNS(
						"http://www.w3.org/2000/svg",
						"line",
					);
					pl.setAttribute("stroke", getDefaultAnnotationColor());
					pl.setAttribute("stroke-width", "2");
					pl.setAttribute("stroke-linecap", "round");
					pl.setAttribute("stroke-dasharray", "6 4");
					pl.style.pointerEvents = "none";
					const startS = c2s(cx, cy);
					pl.setAttribute("x1", String(startS.x));
					pl.setAttribute("y1", String(startS.y));
					pl.setAttribute("x2", String(startS.x));
					pl.setAttribute("y2", String(startS.y));
					g.appendChild(pl);
					annotationSvg.appendChild(g);
					previewEl = g;

					function onFreeLineMove(ev: MouseEvent) {
						const cRect = canvasEl.getBoundingClientRect();
						const curSX = ev.clientX - cRect.left;
						const curSY = ev.clientY - cRect.top;
						pl.setAttribute("x2", String(curSX));
						pl.setAttribute("y2", String(curSY));
					}

					function onFreeLineUp(ev: MouseEvent) {
						document.removeEventListener("mousemove", onFreeLineMove);
						document.removeEventListener("mouseup", onFreeLineUp);
						clearPreview();

						const cRect = canvasEl.getBoundingClientRect();
						const curSX = ev.clientX - cRect.left;
						const curSY = ev.clientY - cRect.top;
						const { x: curCX, y: curCY } = s2c(curSX, curSY);

						const dist = Math.hypot(
							curCX - drawStartCX,
							curCY - drawStartCY,
						);
						if (dist > 5) {
							const color = getDefaultAnnotationColor();
							const ann = addAnnotation({
								type: "line",
								mode: "free",
								x1: drawStartCX,
								y1: drawStartCY,
								x2: curCX,
								y2: curCY,
								color,
							});
							renderAnnotation(ann);
							onSave();
						}
						activateMode("pointer");
					}

					document.addEventListener("mousemove", onFreeLineMove);
					document.addEventListener("mouseup", onFreeLineUp);
				}
			}
		},
		true, // capture phase — fires before marquee listener
	);

	// Escape cancels draw mode / line phase 1
	// Backspace/Delete removes the annotation whose popover is open
	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			if (getDrawMode() !== "pointer") {
				cancelLinePhase1();
				clearPreview();
				activateMode("pointer");
			} else if (linePhase1) {
				cancelLinePhase1();
			}
			return;
		}

		if ((e.key === "Backspace" || e.key === "Delete") && activePopoverAnnId) {
			const id = activePopoverAnnId;
			domMap.get(id)?.remove();
			domMap.delete(id);
			removeAnnotation(id);
			onSave();
			dismissPopover();
		}
	});

	// Dismiss popover on outside click
	document.addEventListener("mousedown", (e) => {
		if (
			activePopover &&
			!activePopover.contains(e.target as Node | null)
		) {
			dismissPopover();
		}
	});

	// ── Text editor ─────────────────────────────────────────────────

	function spawnTextEditor(cx: number, cy: number) {
		const color = getDefaultAnnotationColor();
		const fontSize = 16;
		const { x: sx, y: sy } = c2s(cx, cy);

		const editor = document.createElement("div");
		editor.className = "annotation-text-editor";
		editor.contentEditable = "true";
		editor.style.left = `${sx}px`;
		editor.style.top = `${sy}px`;
		editor.style.color = color;
		editor.style.fontSize = `${fontSize * viewportState.zoom}px`;
		annotationLayer.appendChild(editor);

		requestAnimationFrame(() => editor.focus());

		function commit() {
			const content = editor.textContent?.trim() ?? "";
			editor.remove();
			if (content) {
				const ann = addAnnotation({
					type: "text",
					x: cx,
					y: cy,
					content,
					fontSize,
					color,
				});
				renderAnnotation(ann);
				onSave();
			}
		}

		editor.addEventListener("blur", commit, { once: true });
		editor.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				editor.removeEventListener("blur", commit);
				editor.remove();
			}
		});
	}

	// ── Mode management ──────────────────────────────────────────────

	function activateMode(mode: string) {
		if (mode !== "pointer") dismissPopover();
		if (linePhase1 && mode !== "draw-line") {
			cancelLinePhase1();
		}
		if (mode !== "draw-line") {
			clearAllLineHighlights();
		}
		setDrawMode(mode as import("./annotation-manager.js").DrawMode);
		onModeChange(mode);
	}

	// ── Public API ───────────────────────────────────────────────────

	function repositionAll() {
		for (const ann of annotations) positionById(ann.id);
		updateTileMask();
	}

	function renderAll() {
		for (const ann of annotations) {
			if (!domMap.has(ann.id)) renderAnnotation(ann);
		}
		updateTileMask();
	}

	/** Call when a tile has moved — re-positions connected lines. */
	function onTileMoved() {
		for (const ann of annotations) {
			if (ann.type === "line" && ann.mode === "connected") {
				const g = domMap.get(ann.id);
				if (g) positionLine(g as SVGGElement, ann);
			}
		}
		updateTileMask();
	}

	/** Remove DOM for a deleted annotation (called by tile-manager on tile removal). */
	function removeAnnotationDOM(id: string) {
		domMap.get(id)?.remove();
		domMap.delete(id);
	}

	/** Sync the .annotation-selected class on all annotation DOM elements. */
	function syncSelectionVisuals() {
		for (const ann of annotations) {
			const el = domMap.get(ann.id);
			if (!el) continue;
			el.classList.toggle("annotation-selected", isAnnotationSelected(ann.id));
		}
	}

	return {
		repositionAll,
		renderAll,
		onTileMoved,
		removeAnnotationDOM,
		activateMode,
		syncSelectionVisuals,
	};
}
