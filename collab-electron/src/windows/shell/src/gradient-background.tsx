/**
 * Static mesh-gradient backdrop for the shell window.
 *
 * Replaces the OS translucency (macOS vibrancy / Windows mica) that previously
 * let the desktop show through the app. The gradient is pinned behind every
 * panel and tile; the translucent UI layers compose on top of it.
 *
 * Uses the *static* mesh gradient: it renders a single frame with no animation
 * loop, so it has no recurring GPU/CPU cost (it only re-draws when the theme
 * changes). An animated variant exists but its continuous requestAnimationFrame
 * render drained the battery as a persistent full-window background.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { StaticMeshGradient } from "@paper-design/shaders-react";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Gaussian softening applied to the whole backdrop, in px. */
const BLUR_PX = 36;

// The shell's panels and canvas frost the backdrop (~75% base color over it),
// so these are deliberately saturated to still read through the frosting as a
// soft, ambient wash rather than a literal flat tint.

/** Light theme: cohesive cool palette (indigo→violet→teal) with a warm accent. */
const LIGHT_COLORS = [
	"#a9c2f4",
	"#c8b4ee",
	"#a4ddd8",
	"#edc9d4",
	"#b6c6f1",
];

/** Dark theme: jewel-toned indigo→violet→teal, bright enough to survive frosting. */
const DARK_COLORS = [
	"#33457e",
	"#45346b",
	"#235a63",
	"#553a62",
	"#27376f",
];

function useDarkMode(): boolean {
	const [dark, setDark] = useState(
		() => window.matchMedia(DARK_QUERY).matches,
	);
	useEffect(() => {
		const mql = window.matchMedia(DARK_QUERY);
		const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);
	return dark;
}

function GradientBackground() {
	const dark = useDarkMode();
	return (
		<StaticMeshGradient
			colors={dark ? DARK_COLORS : LIGHT_COLORS}
			positions={6}
			waveX={0.4}
			waveXShift={0.25}
			waveY={0.4}
			waveYShift={0.2}
			mixing={0.8}
			grainOverlay={0.03}
			scale={1.25}
			speed={0}
			style={{ width: "100%", height: "100%" }}
		/>
	);
}

/** Mount the gradient as a fixed, full-window layer behind all app content. */
export function mountGradientBackground(): void {
	const container = document.createElement("div");
	container.id = "gradient-bg";
	container.style.position = "fixed";
	// Overscan past the viewport by ~2x the blur radius so the blur's faded
	// edges fall off-screen instead of revealing the opaque window base color.
	container.style.inset = `-${BLUR_PX * 2}px`;
	container.style.zIndex = "-1";
	container.style.pointerEvents = "none";
	container.style.filter = `blur(${BLUR_PX}px)`;
	document.body.prepend(container);

	createRoot(container).render(
		<StrictMode>
			<GradientBackground />
		</StrictMode>,
	);
}
