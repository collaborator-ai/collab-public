export type DrawMode = "pointer" | "draw-rect" | "draw-text" | "draw-line";

export type AnnotationRect = {
	id: string;
	type: "rect";
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
};

export type AnnotationText = {
	id: string;
	type: "text";
	x: number;
	y: number;
	content: string;
	fontSize: number;
	color: string;
};

export type AnnotationLineFree = {
	id: string;
	type: "line";
	mode: "free";
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	color: string;
};

export type AnnotationLineConnected = {
	id: string;
	type: "line";
	mode: "connected";
	fromTileId: string;
	toTileId: string;
	color: string;
};

export type Annotation =
	| AnnotationRect
	| AnnotationText
	| AnnotationLineFree
	| AnnotationLineConnected;

export const annotations: Annotation[] = [];

let currentMode: DrawMode = "pointer";

export function generateAnnotationId(): string {
	return `ann-${Date.now()}`;
}

export function getDefaultAnnotationColor(): string {
	return document.documentElement.classList.contains("dark") ? "#848484" : "#71717b";
}

export function addAnnotation(data: Omit<Annotation, "id">): Annotation {
	const id = generateAnnotationId();
	const ann = { id, ...data } as Annotation;
	annotations.push(ann);
	return ann;
}

export function removeAnnotation(id: string): void {
	const idx = annotations.findIndex((a) => a.id === id);
	if (idx !== -1) annotations.splice(idx, 1);
}

export function updateAnnotation(id: string, changes: Partial<Omit<Annotation, "id">>): Annotation | null {
	const ann = annotations.find((a) => a.id === id);
	if (ann) Object.assign(ann, changes);
	return ann ?? null;
}

/**
 * Replace a connected line with a free line in-place (no stale keys).
 * Use this instead of updateAnnotation when converting connected→free.
 */
export function convertToFreeLine(
	id: string,
	coords: { x1: number; y1: number; x2: number; y2: number },
): AnnotationLineFree | null {
	const idx = annotations.findIndex((a) => a.id === id);
	if (idx === -1) return null;
	const existing = annotations[idx];
	if (!existing || existing.type !== "line" || existing.mode !== "connected") return null;
	const freeAnn: AnnotationLineFree = {
		id: existing.id,
		type: "line",
		mode: "free",
		...coords,
		color: existing.color,
	};
	annotations[idx] = freeAnn;
	return freeAnn;
}

export function getAnnotation(id: string): Annotation | null {
	return annotations.find((a) => a.id === id) ?? null;
}

export function setDrawMode(mode: DrawMode): void {
	currentMode = mode;
}

export function getDrawMode(): DrawMode {
	return currentMode;
}

/**
 * Remove connected lines that reference a deleted tile.
 * Returns the IDs that were removed so callers can also clean up DOM.
 */
export function removeConnectedLinesForTile(tileId: string): string[] {
	const toRemove = annotations
		.filter(
			(a): a is AnnotationLineConnected =>
				a.type === "line" &&
				a.mode === "connected" &&
				(a.fromTileId === tileId || a.toTileId === tileId),
		)
		.map((a) => a.id);
	for (const id of toRemove) removeAnnotation(id);
	return toRemove;
}

/**
 * After restoring annotations, convert any connected lines whose tile references
 * no longer exist into free lines using the last known tile center coordinates.
 */
export function validateAnnotations(
	liveTileIds: Set<string>,
	getTileCenter: (id: string) => { x: number; y: number } | null,
): void {
	for (let i = 0; i < annotations.length; i++) {
		const ann = annotations[i];
		if (!ann || ann.type !== "line" || ann.mode !== "connected") continue;
		const fromOk = liveTileIds.has(ann.fromTileId);
		const toOk = liveTileIds.has(ann.toTileId);
		if (fromOk && toOk) continue;
		if (!fromOk && !toOk) {
			annotations.splice(i, 1);
			i--;
			continue;
		}
		const p1 = (fromOk ? getTileCenter(ann.fromTileId) : null) ?? { x: 0, y: 0 };
		const p2 = (toOk ? getTileCenter(ann.toTileId) : null) ?? { x: 0, y: 0 };
		annotations[i] = {
			id: ann.id,
			type: "line",
			mode: "free",
			x1: p1.x,
			y1: p1.y,
			x2: p2.x,
			y2: p2.y,
			color: ann.color,
		};
	}
}

// ── Annotation selection ──────────────────────────────────────────

const selectedAnnotationIds = new Set<string>();

export function selectAnnotation(id: string): void {
	selectedAnnotationIds.add(id);
}

export function clearAnnotationSelection(): void {
	selectedAnnotationIds.clear();
}

export function isAnnotationSelected(id: string): boolean {
	return selectedAnnotationIds.has(id);
}

export function getSelectedAnnotationIds(): Set<string> {
	return new Set(selectedAnnotationIds);
}

export function getSelectedAnnotations(): Annotation[] {
	return annotations.filter((a) => selectedAnnotationIds.has(a.id));
}

export function restoreAnnotations(saved: unknown[]): void {
	annotations.length = 0;
	if (!Array.isArray(saved)) return;
	for (const a of saved) annotations.push({ ...(a as Annotation) });
}

export function getAnnotationsForSave(): Annotation[] {
	return annotations.map((a) => ({ ...a }));
}
