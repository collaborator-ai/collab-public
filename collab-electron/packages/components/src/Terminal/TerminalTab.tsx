import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTheme } from "./theme";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";

// Matches VS Code's TerminalDataBufferer throttle interval.
// Coalesces rapid PTY data events into a single term.write()
// call, preventing partial-render artifacts from the renderer
// processing many small sequential writes.
const DATA_BUFFER_FLUSH_MS = 5;
const IS_MAC = window.api.getPlatform() === "darwin";

interface TerminalTabProps {
	sessionId: string;
	visible: boolean;
	restored?: boolean;
}

function TerminalTab({
	sessionId,
	visible,
	restored,
}: TerminalTabProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<FitAddon | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const prefersDark = window.matchMedia(
			"(prefers-color-scheme: dark)",
		).matches;

		const term = new Terminal({
			theme: getTheme(),
			fontFamily: 'Menlo, Monaco, "Courier New", monospace',
			fontSize: 12,
			fontWeight: "300",
			fontWeightBold: "500",
			cursorBlink: true,
			scrollback: 200000,
			allowProposedApi: true,
			allowTransparency: prefersDark,
			macOptionIsMeta: false,
			overviewRuler: { width: 8 },
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		fitRef.current = fit;

		const unicode11 = new Unicode11Addon();
		term.loadAddon(unicode11);
		term.unicode.activeVersion = "11";

		// WebGL renderer: double-buffered canvas avoids the
		// partial-paint artifacts the DOM renderer can show
		// during rapid sequential writes. Falls back to DOM
		// if the GPU context can't be acquired.
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			term.loadAddon(webgl);
		} catch {
			// DOM renderer fallback — no action needed
		}

		// Delay initial fit: the webview may not have its final
		// dimensions when the page first loads. Double-rAF ensures
		// the layout pass has finished before we measure.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => fit.fit());
		});

		// Auto-focus xterm when the webview already has focus (e.g.
		// tile created via Cmd+N or double-click where focusCanvasTile
		// ran before xterm mounted).
		if (document.hasFocus()) {
			term.focus();
		}

		// Keep xterm focused whenever the webview window gains focus,
		// so typing works immediately after clicking a tile title bar
		// or programmatic webview.focus() calls.
		const onWindowFocus = () => term.focus();
		window.addEventListener("focus", onWindowFocus);

		if (!restored) {
			term.write(
				`\x1b[38;2;100;100;100mStarting...\x1b[0m`,
			);
		}

		// Shift+Enter: inject a CSI u escape sequence so TUI apps like
		// Claude Code can detect the shift modifier. Block both keydown
		// AND keypress to prevent xterm from also sending \r through the
		// normal onData path.
		const copySelectionToClipboard = () => {
			const selection = term.getSelection();
			if (!selection) return false;
			void navigator.clipboard.writeText(selection).catch(() => {});
			return true;
		};

		let suppressPasteEvent = false;

		const pasteFromShortcut = () => {
			suppressPasteEvent = true;
			void pasteClipboardText();
		};

		const pasteClipboardText = async () => {
			try {
				const text = await navigator.clipboard.readText();
				if (text) {
					window.api.ptyWrite(sessionId, text);
				}
			} catch {
				// Clipboard access can fail outside a user gesture.
			}
		};

		term.attachCustomKeyEventHandler((e) => {
			if (e.key === "Enter" && e.shiftKey) {
				if (e.type === "keydown") {
					window.api.ptySendRawKeys(sessionId, "\x1b[13;2u");
				}
				return false;
			}
			// Option key on macOS: with macOptionIsMeta disabled (so
			// macOS composes special characters like —), we manually
			// send ESC+key for the readline/shell bindings we need.
			if (IS_MAC && e.type === "keydown" && e.altKey && !e.metaKey && !e.ctrlKey) {
				if (e.key === "ArrowLeft") {
					window.api.ptyWrite(sessionId, "\x1bb");
					return false;
				}
				if (e.key === "ArrowRight") {
					window.api.ptyWrite(sessionId, "\x1bf");
					return false;
				}
				if (e.key === "b") {
					window.api.ptyWrite(sessionId, "\x1bb");
					return false;
				}
				if (e.key === "f") {
					window.api.ptyWrite(sessionId, "\x1bf");
					return false;
				}
				if (e.key === "d") {
					window.api.ptyWrite(sessionId, "\x1bd");
					return false;
				}
				if (e.key === "Backspace") {
					window.api.ptyWrite(sessionId, "\x1b\x7f");
					return false;
				}
				if (e.key === ".") {
					window.api.ptyWrite(sessionId, "\x1b.");
					return false;
				}
			}
			// Command+Arrow on macOS: jump to start/end of line, matching
			// the system terminal. ESC has no metaKey, so send the
			// readline beginning/end-of-line controls (Ctrl-A / Ctrl-E).
			if (IS_MAC && e.type === "keydown" && e.metaKey && !e.altKey && !e.ctrlKey) {
				if (e.key === "ArrowLeft") {
					window.api.ptyWrite(sessionId, "\x01");
					return false;
				}
				if (e.key === "ArrowRight") {
					window.api.ptyWrite(sessionId, "\x05");
					return false;
				}
			}
			const primaryModifier = IS_MAC ? e.metaKey : e.ctrlKey;
			if (e.type === "keydown" && primaryModifier) {
				const key = e.key.toLowerCase();
				if (key === "c" && copySelectionToClipboard()) {
					return false;
				}
				if (key === "v") {
					pasteFromShortcut();
					return false;
				}
				if (!IS_MAC && e.shiftKey) {
					if (key === "c" && copySelectionToClipboard()) {
						return false;
					}
					if (key === "v") {
						pasteFromShortcut();
						return false;
					}
				}
			}
			if (e.type === "keydown" && e.shiftKey && e.key === "Insert") {
				pasteFromShortcut();
				return false;
			}
			if (e.type === "keydown" && e.metaKey) {
				if (e.key === "t" || (e.key >= "1" && e.key <= "9")) {
					return false;
				}
			}
			return true;
		});

		// OSC 7: shell reports current working directory
		// Format: file://hostname/path or file:///path
		term.parser.registerOscHandler(7, (data) => {
			try {
				const url = new URL(data);
				if (url.protocol === "file:") {
					const cwd = decodeURIComponent(url.pathname);
					if (cwd) window.api.notifyCwdChanged(sessionId, cwd);
				}
			} catch {
				// Malformed URL — ignore
			}
			return true;
		});

		term.onData((data: string) => {
			window.api.ptyWrite(sessionId, data);
		});

		let dataBuffer: Uint8Array[] = [];
		let flushTimer: number | undefined;
		let firstData = true;

		const flushData = () => {
			if (dataBuffer.length === 0) {
				flushTimer = undefined;
				return;
			}
			const chunks = dataBuffer;
			dataBuffer = [];
			flushTimer = undefined;
			if (firstData) {
				firstData = false;
				if (!restored) {
					term.reset();
				}
			}
			for (const chunk of chunks) {
				term.write(chunk);
			}
		};

		const handleData = (payload: {
			sessionId: string;
			data: Uint8Array;
		}) => {
			if (payload.sessionId !== sessionId) return;
			dataBuffer.push(payload.data);
			if (flushTimer === undefined) {
				flushTimer = window.setTimeout(
					flushData,
					DATA_BUFFER_FLUSH_MS,
				);
			}
		};
		window.api.onPtyData(sessionId, handleData);

		term.onResize(({ cols, rows }) => {
			window.api.ptyResize(sessionId, cols, rows);
		});

		const handleCopy = (event: ClipboardEvent) => {
			const selection = term.getSelection();
			if (!selection) return;
			event.clipboardData?.setData("text/plain", selection);
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		const handlePaste = (event: ClipboardEvent) => {
			if (suppressPasteEvent) {
				suppressPasteEvent = false;
				// Only suppress if clipboard has text (already sent via
				// pasteClipboardText). If it only has images, let the
				// event propagate so downstream handlers can process it.
				if (event.clipboardData?.getData("text/plain")) {
					event.preventDefault();
					event.stopImmediatePropagation();
				}
				return;
			}
			const text = event.clipboardData?.getData("text/plain");
			if (!text) return;
			window.api.ptyWrite(sessionId, text);
			event.preventDefault();
			event.stopImmediatePropagation();
		};

		const handleDragOver = (event: DragEvent) => {
			event.preventDefault();
			if (event.dataTransfer) {
				event.dataTransfer.dropEffect = "copy";
			}
		};

		const handleDrop = async (event: DragEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (!event.dataTransfer?.files?.length) return;

			// Extract paths synchronously before any await
			const rawPaths: string[] = [];
			for (let i = 0; i < event.dataTransfer.files.length; i++) {
				const file = event.dataTransfer.files[i];
				if (!file) continue;
				try {
					const p = window.api.getPathForFile(file);
					if (p) rawPaths.push(p);
				} catch { /* skip non-file items */ }
			}
			if (rawPaths.length === 0) return;

			// Filter out directories
			const checks = rawPaths.map(async (p) => {
				const isDir = await window.api.isDirectory(p);
				return isDir ? null : p;
			});
			const paths = (await Promise.all(checks)).filter(
				(p): p is string => p !== null,
			);
			if (paths.length === 0) return;

			const escaped = paths.map(
				(p) => "'" + p.replace(/'/g, "'\\''") + "'",
			);
			try {
				await window.api.ptyWrite(sessionId, escaped.join(" "));
			} catch { /* PTY may have exited */ }
			term.focus();
		};

		container.addEventListener("copy", handleCopy, true);
		container.addEventListener("paste", handlePaste, true);
		container.addEventListener("dragover", handleDragOver);
		container.addEventListener("drop", handleDrop);

		const offShellBlur = window.api.onShellBlur(() => {
			term.blur();
			const active = document.activeElement as HTMLElement | null;
			active?.blur();
		});

		// Debounce resize via rAF to coalesce rapid events
		let rafId = 0;
		const resizeObserver = new ResizeObserver((entries) => {
			const { width, height } = entries[0].contentRect;
			if (width > 0 && height > 0) {
				cancelAnimationFrame(rafId);
				rafId = requestAnimationFrame(() => fit.fit());
			}
		});
		resizeObserver.observe(containerRef.current);

		const mediaQuery = window.matchMedia(
			"(prefers-color-scheme: dark)",
		);
		const onThemeChange = (e: MediaQueryListEvent) => {
			term.options.allowTransparency = e.matches;
			term.options.theme = getTheme();
		};
		mediaQuery.addEventListener("change", onThemeChange);

		return () => {
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				flushData();
			}
			cancelAnimationFrame(rafId);
			window.removeEventListener("focus", onWindowFocus);
			mediaQuery.removeEventListener("change", onThemeChange);
			resizeObserver.disconnect();
			container.removeEventListener("copy", handleCopy, true);
			container.removeEventListener("paste", handlePaste, true);
			container.removeEventListener("dragover", handleDragOver);
			container.removeEventListener("drop", handleDrop);
			window.api.offPtyData(sessionId, handleData);
			offShellBlur();
			term.dispose();
			fitRef.current = null;
		};
	}, [sessionId]);

	useEffect(() => {
		if (visible && fitRef.current) {
			requestAnimationFrame(() => fitRef.current?.fit());
		}
	}, [visible]);

	return (
		<div
			ref={containerRef}
			className="terminal-tab"
			style={{ display: visible ? "block" : "none" }}
		/>
	);
}

export default TerminalTab;
