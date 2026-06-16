import { snapToGrid } from "./canvas-state.js";

const MIN_SIZES = {
  term: { width: 200, height: 120 },
  note: { width: 200, height: 120 },
  code: { width: 200, height: 120 },
  image: { width: 80, height: 80 },
  graph: { width: 300, height: 250 },
};

const CLICK_THRESHOLD = 3;

/**
 * Attach drag behavior to a tile's title bar.
 * Supports single-tile drag, group drag (when tile is in a
 * multi-tile selection), and Shift+click toggling.
 *
 * @param {HTMLElement} titleBar
 * @param {import('./canvas-state.js').Tile} tile
 * @param {object} opts
 * @param {object} opts.viewport - { panX, panY, zoom } (read live)
 * @param {() => void} opts.onUpdate
 * @param {(ws: Array<{webview: HTMLElement}>) => void} opts.disablePointerEvents
 * @param {(ws: Array<{webview: HTMLElement}>) => void} opts.enablePointerEvents
 * @param {() => Array<{webview: HTMLElement}>} opts.getAllWebviews
 * @param {() => null | Array<{tile: object, container: HTMLElement, startX: number, startY: number}>} opts.getGroupDragContext
 * @param {(tileId: string) => void} opts.onShiftClick
 * @param {() => boolean} [opts.isSpaceHeld] - when true, suppress drag (canvas is panning)
 * @param {HTMLElement} [opts.contentOverlay] - secondary drag surface over tile content
 */
export function attachDrag(titleBar, tile, {
  viewport,
  onUpdate,
  disablePointerEvents,
  enablePointerEvents,
  getAllWebviews,
  getGroupDragContext,
  onShiftClick,
  onFocus,
  isSpaceHeld,
  contentOverlay,
  isTileInSelection,
  onGroupDragStart,
  onGroupDragMove,
  onGroupDragEnd,
}) {
  function startDrag(e, { deferFocus = false } = {}) {
    if (e.button !== 0) return;
    if (isSpaceHeld?.()) return;
    e.preventDefault();
    if (!deferFocus && onFocus) onFocus(tile.id, e);

    const startMX = e.clientX;
    const startMY = e.clientY;
    const startTX = tile.x;
    const startTY = tile.y;
    const startPanX = viewport.panX;
    const startPanY = viewport.panY;
    const shiftHeld = e.shiftKey;

    const groupCtx = getGroupDragContext();
    const isGroupDrag = groupCtx !== null && groupCtx.length > 1;

    // Fire annotation group drag callbacks if this tile is part of the selection
    const tileSelected = isTileInSelection?.() ?? false;
    if (tileSelected) onGroupDragStart?.();

    const webviews = getAllWebviews();
    disablePointerEvents(webviews);

    const container = titleBar.closest(".canvas-tile");
    container.classList.add("tile-dragging");
    if (isGroupDrag) {
      for (const entry of groupCtx) {
        entry.container.classList.add("tile-dragging");
      }
    }

    let moved = false;
    let lastMX = startMX;
    let lastMY = startMY;

    function applyDrag(mx, my) {
      const panDX = viewport.panX - startPanX;
      const panDY = viewport.panY - startPanY;
      const dx = (mx - startMX - panDX) / viewport.zoom;
      const dy = (my - startMY - panDY) / viewport.zoom;

      if (isGroupDrag) {
        for (const entry of groupCtx) {
          entry.tile.x = entry.startX + dx;
          entry.tile.y = entry.startY + dy;
        }
      } else {
        tile.x = startTX + dx;
        tile.y = startTY + dy;
      }
      if (tileSelected) onGroupDragMove?.(dx, dy);
      onUpdate();
    }

    function onMove(e) {
      lastMX = e.clientX;
      lastMY = e.clientY;
      const dist = Math.hypot(lastMX - startMX, lastMY - startMY);
      if (dist >= CLICK_THRESHOLD) moved = true;
      applyDrag(lastMX, lastMY);
    }

    function onWheel() {
      applyDrag(lastMX, lastMY);
    }

    function onUp(e) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("wheel", onWheel);
      enablePointerEvents(webviews);

      if (shiftHeld && !moved) {
        container.classList.remove("tile-dragging");
        if (isGroupDrag) {
          for (const entry of groupCtx) {
            entry.container.classList.remove("tile-dragging");
          }
        }
        onShiftClick(tile.id);
        return;
      }

      if (deferFocus && !moved && onFocus) {
        onFocus(tile.id, e);
      }

      container.classList.remove("tile-dragging");
      if (isGroupDrag) {
        for (const entry of groupCtx) {
          entry.container.classList.remove("tile-dragging");
          snapToGrid(entry.tile);
        }
      } else {
        snapToGrid(tile);
      }
      onUpdate();
      if (tileSelected && moved) onGroupDragEnd?.();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("wheel", onWheel, { passive: true });
  }

  titleBar.addEventListener("mousedown", (e) => startDrag(e));

  if (contentOverlay) {
    contentOverlay.addEventListener("mousedown", (e) => {
      startDrag(e, { deferFocus: true });
    });
  }
}

/**
 * Attach marquee (rubber-band) selection to the canvas element.
 *
 * @param {HTMLElement} canvasEl
 * @param {object} opts
 * @param {object} opts.viewport - { panX, panY, zoom } (read live)
 * @param {() => Array<import('./canvas-state.js').Tile>} opts.tiles
 * @param {(ids: Set<string>) => void} opts.onSelectionChange
 * @param {() => boolean} opts.isShiftHeld
 * @param {() => boolean} opts.isSpaceHeld
 * @param {() => Array<{webview: HTMLElement}>} opts.getAllWebviews
 */
export function attachMarquee(canvasEl, {
  viewport,
  tiles,
  onSelectionChange,
  onRectSelect,
  isShiftHeld,
  isSpaceHeld,
  isBlocked,
  getAllWebviews,
}) {
  const tileLayer = canvasEl.querySelector("#tile-layer");
  const gridCanvas = canvasEl.querySelector("#grid-canvas");

  canvasEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    // Ignore if Space is held (pan gesture) or draw mode is active
    if (isSpaceHeld()) return;
    if (isBlocked?.()) return;
    // Only trigger on clicks directly on the canvas background
    if (
      e.target !== canvasEl &&
      e.target !== tileLayer &&
      e.target !== gridCanvas
    ) return;

    e.preventDefault();
    if (document.activeElement) document.activeElement.blur();

    const webviews = getAllWebviews();
    for (const w of webviews) w.webview.style.pointerEvents = "none";

    const startSX = e.clientX;
    const startSY = e.clientY;

    const marquee = document.createElement("div");
    marquee.className = "selection-marquee";
    marquee.style.position = "fixed";
    marquee.style.left = `${startSX}px`;
    marquee.style.top = `${startSY}px`;
    marquee.style.width = "0px";
    marquee.style.height = "0px";
    document.body.appendChild(marquee);

    let moved = false;

    function onMove(e) {
      const curSX = e.clientX;
      const curSY = e.clientY;
      const dist = Math.hypot(curSX - startSX, curSY - startSY);
      if (dist >= CLICK_THRESHOLD) moved = true;

      const left = Math.min(startSX, curSX);
      const top = Math.min(startSY, curSY);
      const width = Math.abs(curSX - startSX);
      const height = Math.abs(curSY - startSY);

      marquee.style.left = `${left}px`;
      marquee.style.top = `${top}px`;
      marquee.style.width = `${width}px`;
      marquee.style.height = `${height}px`;
    }

    function onUp(e) {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      marquee.remove();
      for (const w of webviews) w.webview.style.pointerEvents = "";

      if (!moved) {
        // Click on empty canvas — clear selection
        onSelectionChange(new Set());
        onRectSelect?.(null);
        return;
      }

      // Compute marquee rect in canvas coordinates
      const curSX = e.clientX;
      const curSY = e.clientY;
      const mLeft = Math.min(startSX, curSX);
      const mTop = Math.min(startSY, curSY);
      const mRight = Math.max(startSX, curSX);
      const mBottom = Math.max(startSY, curSY);

      // Convert viewport-relative pointer coords into canvas coords.
      const viewerRect = canvasEl.getBoundingClientRect();
      const toCanvas = (sx, sy) => ({
        x: (sx - viewerRect.left - viewport.panX) / viewport.zoom,
        y: (sy - viewerRect.top - viewport.panY) / viewport.zoom,
      });

      const cTL = toCanvas(mLeft, mTop);
      const cBR = toCanvas(mRight, mBottom);

      // AABB hit-test against all tiles
      const hitIds = new Set();
      for (const t of tiles()) {
        const tRight = t.x + t.width;
        const tBottom = t.y + t.height;
        if (
          t.x < cBR.x &&
          tRight > cTL.x &&
          t.y < cBR.y &&
          tBottom > cTL.y
        ) {
          hitIds.add(t.id);
        }
      }

      onSelectionChange(hitIds);
      onRectSelect?.({ left: cTL.x, top: cTL.y, right: cBR.x, bottom: cBR.y });
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/**
 * Creates resize handle elements and attaches resize behavior.
 * @param {HTMLElement} container
 * @param {import('./canvas-state.js').Tile} tile
 * @param {object} viewport
 * @param {() => void} onUpdate
 * @param {() => Array<{webview: HTMLElement}>} getAllWebviews
 */
export function attachResize(
  container, tile, viewport, onUpdate, getAllWebviews, onFocus,
  onResizeEnd,
) {
  const edges = ["n", "s", "e", "w"];
  const corners = ["nw", "ne", "sw", "se"];

  for (const dir of [...edges, ...corners]) {
    const handle = document.createElement("div");
    const kind = dir.length === 1 ? "edge" : "corner";
    handle.className = `tile-resize-handle ${kind}-${dir}`;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      const startMX = e.clientX;
      const startMY = e.clientY;
      const startPanX = viewport.panX;
      const startPanY = viewport.panY;
      const startX = tile.x;
      const startY = tile.y;
      const startW = tile.width;
      const startH = tile.height;
      const min = MIN_SIZES[tile.type] || MIN_SIZES.term;

      const webviews = getAllWebviews();
      for (const wv of webviews) {
        wv.webview.style.pointerEvents = "none";
      }

      function onMove(e) {
        const panDX = viewport.panX - startPanX;
        const panDY = viewport.panY - startPanY;
        const dx = (e.clientX - startMX - panDX) / viewport.zoom;
        const dy = (e.clientY - startMY - panDY) / viewport.zoom;
        const symmetric = e.altKey;
        const m = symmetric ? 2 : 1;
        const cx = startX + startW / 2;
        const cy = startY + startH / 2;

        if (dir.includes("e")) {
          tile.width = Math.max(min.width, startW + dx * m);
          if (symmetric) tile.x = cx - tile.width / 2;
        }
        if (dir.includes("w")) {
          const newW = Math.max(min.width, startW - dx * m);
          tile.x = symmetric
            ? cx - newW / 2
            : startX + (startW - newW);
          tile.width = newW;
        }
        if (dir.includes("s")) {
          tile.height = Math.max(min.height, startH + dy * m);
          if (symmetric) tile.y = cy - tile.height / 2;
        }
        if (dir.includes("n")) {
          const newH = Math.max(min.height, startH - dy * m);
          tile.y = symmetric
            ? cy - newH / 2
            : startY + (startH - newH);
          tile.height = newH;
        }

        onUpdate();
      }

      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        for (const wv of webviews) {
          wv.webview.style.pointerEvents = "";
        }
        snapToGrid(tile);
        onUpdate();
        if (onResizeEnd) onResizeEnd(tile);
        if (onFocus) onFocus();
      }

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    container.appendChild(handle);
  }
}
