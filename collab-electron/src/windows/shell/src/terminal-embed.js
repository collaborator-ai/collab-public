import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { getTheme } from "@collab/components/Terminal/theme";
import "@xterm/xterm/css/xterm.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_BUFFER_FLUSH_MS = 5;
const IS_MAC = window.shellApi.getPlatform() === "darwin";
const textEncoder = new TextEncoder();

const AGENT_TITLE_MAX_LEN = 60;

/** Collapse to a single clean line, strip control chars, cap length. */
function sanitizeAgentTitle(raw) {
	return raw
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, AGENT_TITLE_MAX_LEN);
}

// Scrollback: start small to avoid a CPU spike on terminal creation, then
// grow to the full limit once the terminal is idle and interactive.
const INITIAL_SCROLLBACK = 1000;
const FULL_SCROLLBACK = 200000;
const SCROLLBACK_GROW_DELAY_MS = 2000;

/** Schedule work on the next animation frame (returns a promise). */
const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

// ---------------------------------------------------------------------------
// Terminal registry
// ---------------------------------------------------------------------------

/** @type {Map<string, TerminalHandle>} */
const registry = new Map();

// ---------------------------------------------------------------------------
// TerminalHandle
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TerminalHandle
 * @property {string} sessionId
 * @property {(data: string|Uint8Array) => void} write
 * @property {() => void} focus
 * @property {() => void} blur
 * @property {() => void} dispose
 * @property {Terminal} term
 */

// ---------------------------------------------------------------------------
// createTerminal
// ---------------------------------------------------------------------------

/**
 * Create an xterm.js terminal instance inside the given container element.
 * Returns a handle immediately — all heavy initialisation (DOM mount, addon
 * loading) is spread across animation frames so the main thread is never
 * blocked for more than a single lightweight phase.
 *
 * @param {HTMLElement} container
 * @param {string} sessionId
 * @param {{ scrollbackData?: string|null, mode?: "tmux"|"sidecar"|"direct", restored?: boolean, onAgentTitle?: ((sessionId: string, title: string) => void)|null, acceptStandardTitle?: boolean }} [options]
 * @returns {Promise<TerminalHandle>}
 */
export async function createTerminal(container, sessionId, options = {}) {
	const {
		scrollbackData = null,
		restored = false,
		onAgentTitle = null,
		acceptStandardTitle = false,
	} = options;

	const t0 = performance.now();
	const lap = (label) => {
		const ms = (performance.now() - t0).toFixed(1);
		console.log(`[terminal-embed] createTerminal +${ms}ms  ${label}`);
	};

	// -- Mutable state shared between the handle and the init pipeline ---------

	/** @type {Terminal|null} */
	let term = null;
	/** @type {FitAddon|null} */
	let fit = null;
	let disposed = false;
	let ready = false;
	let pendingFocus = false;

	// -- Data buffering (works before and after xterm is ready) -----------------

	/** @type {Uint8Array[]} */
	let dataBuffer = [];
	/** @type {number|undefined} */
	let flushTimer;
	let firstData = true;

	const flushData = () => {
		if (dataBuffer.length === 0) {
			flushTimer = undefined;
			return;
		}
		if (!term || !ready) return; // will be flushed when ready
		const chunks = dataBuffer;
		dataBuffer = [];
		flushTimer = undefined;

		if (firstData) {
			firstData = false;
			term.write("\x1b[2J\x1b[H");
		}
		for (const chunk of chunks) {
			term.write(chunk);
		}
	};

	const writeBuffered = (data) => {
		const chunk = typeof data === "string" ? textEncoder.encode(data) : data;
		dataBuffer.push(chunk);
		if (ready && flushTimer === undefined) {
			flushTimer = window.setTimeout(flushData, DATA_BUFFER_FLUSH_MS);
		}
	};

	// -- Cleanup bookkeeping (accumulates as phases complete) -------------------

	const cleanups = [];

	// -- Resize state (shared with Phase 2) ------------------------------------

	const FIT_DEBOUNCE_MS = 100;
	let fitTimer = 0;
	let resizeObserver = null;

	// -- Build handle (returned immediately) ------------------------------------

	/** @type {TerminalHandle} */
	const handle = {
		sessionId,
		write: writeBuffered,
		focus() {
			if (term && ready) term.focus();
			else pendingFocus = true;
		},
		blur() {
			if (term) term.blur();
		},
		get term() { return term; },
		dispose() {
			disposed = true;
			if (flushTimer !== undefined) {
				clearTimeout(flushTimer);
				// Flush remaining data synchronously before teardown
				if (term && ready && dataBuffer.length > 0) {
					const chunks = dataBuffer;
					dataBuffer = [];
					for (const chunk of chunks) term.write(chunk);
				}
			}
			clearTimeout(fitTimer);
			for (const fn of cleanups) {
				try { fn(); } catch { /* best-effort */ }
			}
			if (term) { term.dispose(); term = null; }
			registry.delete(sessionId);
			earlyDataBuffers.delete(sessionId);
		},
	};

	// Register immediately so PTY data arriving during init is buffered
	// on the handle rather than in the early-data fallback map.
	registry.set(sessionId, handle);

	// Drain any data that arrived before we registered
	const early = earlyDataBuffers.get(sessionId);
	if (early) {
		earlyDataBuffers.delete(sessionId);
		for (const chunk of early.chunks) handle.write(chunk);
	}

	// =========================================================================
	// Phase 1 (next frame): xterm instance + DOM mount
	// =========================================================================

	await nextFrame();
	if (disposed) return handle;
	lap("phase 1 start: new Terminal + open");

	const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
	term = new Terminal({
		theme: getTheme(),
		fontFamily: 'Menlo, Monaco, "Cascadia Mono", Consolas, "Courier New", monospace',
		fontSize: 12,
		fontWeight: "300",
		fontWeightBold: "500",
		cursorBlink: true,
		scrollback: INITIAL_SCROLLBACK,
		allowProposedApi: true,
		// The theme background is rgba(..,0); transparency lets the canvas
		// show through instead of compositing onto solid black.
		allowTransparency: prefersDark,
	});

	fit = new FitAddon();
	term.loadAddon(fit);
	term.open(container);

	if (!restored) {
		term.write("\x1b[38;2;100;100;100mStarting...\x1b[0m");
	}
	if (restored && scrollbackData) {
		term.write(scrollbackData);
	}

	// =========================================================================
	// Phase 2 (next frame): addons, input wiring, resize observer
	// =========================================================================

	lap("phase 1 done");
	await nextFrame();
	if (disposed) return handle;
	lap("phase 2 start: addons + input wiring");

	// Unicode 11 support
	const unicode11 = new Unicode11Addon();
	term.loadAddon(unicode11);
	term.unicode.activeVersion = "11";

	// Agent-target tiles adopt the window title the CLI emits (e.g. Claude
	// Code's session summary), surfaced via xterm's title-change event.
	if (onAgentTitle && acceptStandardTitle) {
		const titleDisposable = term.onTitleChange((raw) => {
			const title = sanitizeAgentTitle(raw);
			if (title) onAgentTitle(sessionId, title);
		});
		cleanups.push(() => titleDisposable.dispose());
	}

	// Scroll isolation
	const handleWheel = (e) => { e.stopPropagation(); };
	container.addEventListener("wheel", handleWheel, { passive: true });
	cleanups.push(() => container.removeEventListener("wheel", handleWheel));

	// Input handling
	const copySelectionToClipboard = () => {
		const selection = term.getSelection();
		if (!selection) return false;
		void navigator.clipboard.writeText(selection).catch(() => {});
		return true;
	};
	let suppressPasteEvent = false;
	const pasteClipboardText = async () => {
		try {
			const text = await navigator.clipboard.readText();
			if (text) window.shellApi.ptyWrite(sessionId, text);
		} catch { /* noop */ }
	};
	const pasteFromShortcut = () => {
		suppressPasteEvent = true;
		void pasteClipboardText();
	};

	term.attachCustomKeyEventHandler((e) => {
		if (e.key === "Enter" && e.shiftKey) {
			if (e.type === "keydown") {
				window.shellApi.ptySendRawKeys(sessionId, "\x1b[13;2u");
			}
			return false;
		}
		const primaryModifier = IS_MAC ? e.metaKey : e.ctrlKey;
		if (e.type === "keydown" && primaryModifier) {
			const key = e.key.toLowerCase();
			if (key === "c" && copySelectionToClipboard()) return false;
			if (key === "v") { pasteFromShortcut(); return false; }
			if (!IS_MAC && e.shiftKey) {
				if (key === "c" && copySelectionToClipboard()) return false;
				if (key === "v") { pasteFromShortcut(); return false; }
			}
		}
		if (e.type === "keydown" && e.shiftKey && e.key === "Insert") {
			pasteFromShortcut();
			return false;
		}
		if (e.type === "keydown" && e.shiftKey) {
			if (e.key === "PageUp") { term.scrollPages(-1); return false; }
			if (e.key === "PageDown") { term.scrollPages(1); return false; }
		}
		if (e.type === "keydown" && e.metaKey) {
			if (e.key === "t" || (e.key >= "1" && e.key <= "9")) return false;
		}
		return true;
	});

	term.onData((data) => { window.shellApi.ptyWrite(sessionId, data); });

	// Clipboard events
	const handleCopy = (event) => {
		const selection = term.getSelection();
		if (!selection) return;
		event.clipboardData?.setData("text/plain", selection);
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	const handlePaste = (event) => {
		if (suppressPasteEvent) {
			suppressPasteEvent = false;
			event.preventDefault();
			event.stopImmediatePropagation();
			return;
		}
		const text = event.clipboardData?.getData("text/plain");
		if (!text) return;
		window.shellApi.ptyWrite(sessionId, text);
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	container.addEventListener("copy", handleCopy, true);
	container.addEventListener("paste", handlePaste, true);
	cleanups.push(() => {
		container.removeEventListener("copy", handleCopy, true);
		container.removeEventListener("paste", handlePaste, true);
	});

	// Resize observer + fit
	term.onResize(({ cols, rows }) => {
		window.shellApi.ptyResize(sessionId, cols, rows);
	});
	resizeObserver = new ResizeObserver((entries) => {
		const { width, height } = entries[0].contentRect;
		if (width > 0 && height > 0) {
			clearTimeout(fitTimer);
			fitTimer = window.setTimeout(() => fit.fit(), FIT_DEBOUNCE_MS);
		}
	});
	resizeObserver.observe(container);
	cleanups.push(() => resizeObserver.disconnect());

	// Theme
	const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
	const onThemeChange = (e) => {
		term.options.allowTransparency = e.matches;
		term.options.theme = getTheme();
	};
	mediaQuery.addEventListener("change", onThemeChange);
	cleanups.push(() => mediaQuery.removeEventListener("change", onThemeChange));

	// -- Terminal is now interactive -------------------------------------------
	ready = true;

	// Flush data that arrived during init and run deferred fit
	if (dataBuffer.length > 0) {
		flushTimer = window.setTimeout(flushData, DATA_BUFFER_FLUSH_MS);
	}
	requestAnimationFrame(() => {
		if (!disposed && fit) fit.fit();
	});

	if (pendingFocus && term) {
		term.focus();
		pendingFocus = false;
	}

	// =========================================================================
	// Phase 3 (idle): grow scrollback to full capacity
	// =========================================================================

	lap("phase 2 done (ready=true)");
	setTimeout(() => {
		if (!disposed && term) {
			try { term.options.scrollback = FULL_SCROLLBACK; } catch { /* disposed */ }
		}
	}, SCROLLBACK_GROW_DELAY_MS);

	return handle;
}

// ---------------------------------------------------------------------------
// getTerminal
// ---------------------------------------------------------------------------

export function getTerminal(sessionId) {
	return registry.get(sessionId);
}

// ---------------------------------------------------------------------------
// disposeTerminal
// ---------------------------------------------------------------------------

export function disposeTerminal(sessionId) {
	const handle = registry.get(sessionId);
	if (handle) {
		handle.dispose();
	}
}

// ---------------------------------------------------------------------------
// initPtyDataDispatch
// ---------------------------------------------------------------------------

/** @type {Map<string, { chunks: Array<string|Uint8Array>, bytes: number }>} */
const earlyDataBuffers = new Map();
const EARLY_BUFFER_MAX_BYTES = 512 * 1024; // 512 KB per session
const EARLY_BUFFER_TIMEOUT_MS = 30_000;    // cleanup after 30s if never consumed

export function initPtyDataDispatch() {
	// Expose registry for DevTools debugging only in development builds.
	try {
		if (process.env?.NODE_ENV !== "production") {
			window.__terminalRegistry = registry;
		}
	} catch { /* process may not exist in some test envs */ }

	window.shellApi.onPtyData((sessionId, data) => {
		const handle = registry.get(sessionId);
		if (handle) {
			handle.write(data);
		} else {
			// Buffer data that arrives before createTerminal finishes.
			// Cap total bytes to prevent unbounded growth if init fails.
			let entry = earlyDataBuffers.get(sessionId);
			if (!entry) {
				entry = { chunks: [], bytes: 0 };
				earlyDataBuffers.set(sessionId, entry);
				// Auto-cleanup if the terminal is never created
				setTimeout(() => earlyDataBuffers.delete(sessionId), EARLY_BUFFER_TIMEOUT_MS);
			}
			const len = typeof data === "string" ? data.length : data.byteLength;
			if (entry.bytes < EARLY_BUFFER_MAX_BYTES) {
				entry.chunks.push(data);
				entry.bytes += len;
			}
		}
	});

	window.shellApi.onPtyExit((payload) => {
		const sid = typeof payload === "string" ? payload : payload?.sessionId;
		if (sid) {
			disposeTerminal(sid);
		}
	});
}
