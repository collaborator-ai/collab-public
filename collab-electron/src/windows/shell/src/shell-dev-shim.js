/**
 * Dev shim for window.shellApi — runs only in the browser (no Electron preload).
 * Provides enough of the shellApi surface for the shell renderer to boot and
 * reach the main UI without hanging on the loading screen.
 */

if (!window.shellApi) {
	const noop = () => {};
	const noopSub = () => () => {};   // returns an unsubscribe fn
	const resolvedNull = () => Promise.resolve(null);
	const resolvedVoid = () => Promise.resolve();

	// Simple event emitter used for prefs and workspace events
	const listeners = {};
	function on(key, cb) {
		(listeners[key] ??= []).push(cb);
		return () => {
			const arr = listeners[key];
			if (arr) listeners[key] = arr.filter(fn => fn !== cb);
		};
	}

	// In the browser there is no main-process signal, so fire onLoadingDone
	// after a short tick once the renderer has registered its callback.
	let loadingDoneCbs = [];
	let loadingDoneFired = false;
	setTimeout(() => {
		loadingDoneFired = true;
		for (const cb of loadingDoneCbs) cb();
		loadingDoneCbs = [];
	}, 0);

	const origin = window.location.origin; // e.g. http://localhost:5173

	window.shellApi = {
		// -- Platform --
		getPlatform: () => "darwin",

		// -- View config: point sub-windows at the Vite dev server --
		getViewConfig: () => Promise.resolve({
			nav:          { src: `${origin}/nav/index.html`,           preload: "" },
			viewer:       { src: `${origin}/viewer/index.html`,        preload: "" },
			terminal:     { src: `${origin}/terminal/index.html`,      preload: "" },
			terminalTile: { src: `${origin}/terminal-tile/index.html`, preload: "" },
			graphTile:    { src: `${origin}/graph-tile/index.html`,    preload: "" },
			settings:     { src: `${origin}/settings/index.html`,      preload: "" },
			tileList:     { src: `${origin}/tile-list/index.html`,     preload: "" },
			agentChat:    { src: `${origin}/agent-chat/index.html`,    preload: "" },
		}),

		// -- Prefs --
		getPref: (key) => {
			const val = localStorage.getItem(`pref:${key}`);
			try { return Promise.resolve(val !== null ? JSON.parse(val) : null); }
			catch { return Promise.resolve(null); }
		},
		setPref: (key, value) => {
			try { localStorage.setItem(`pref:${key}`, JSON.stringify(value)); }
			catch {}
			return Promise.resolve();
		},
		onPrefChanged: (cb) => on("pref:changed", cb),

		// -- Loading --
		onLoadingStatus: noopSub,
		onLoadingDone: (cb) => {
			if (loadingDoneFired) { cb(); return noop; }
			loadingDoneCbs.push(cb);
			return () => { loadingDoneCbs = loadingDoneCbs.filter(fn => fn !== cb); };
		},

		// -- Inter-window forwarding (no-op in browser) --
		onForwardToWebview: noopSub,

		// -- Settings --
		onSettingsToggle: noopSub,
		openSettings:  noop,
		closeSettings: noop,
		toggleSettings: noop,

		// -- Shortcuts --
		onShortcut: noopSub,

		// -- Misc events --
		onBrowserTileFocusUrl: noopSub,
		onCanvasPinch: noopSub,
		onCanvasRpcRequest: noopSub,
		canvasRpcResponse: noop,

		// -- Canvas state --
		canvasLoadState: () => Promise.resolve(null),
		canvasSaveState: resolvedVoid,

		// -- Workspace --
		workspaceList: () => Promise.resolve({ workspaces: [] }),
		workspaceAdd:  resolvedNull,
		workspaceRemove: resolvedVoid,
		onWorkspaceAdded:   noopSub,
		onWorkspaceRemoved: noopSub,

		// -- Filesystem --
		isDirectory:   () => Promise.resolve(false),
		getDragPaths:  () => Promise.resolve([]),
		getPathForFile: (file) => file.name,
		getHomePath:   () => "/",

		// -- Webview console passthrough --
		logFromWebview: (panel, level, message) => {
			const fn = [console.debug, console.log, console.warn, console.error][level] ?? console.log;
			fn(`[webview:${panel}]`, message);
		},

		// -- Nav --
		selectFile: noop,

		// -- Updates --
		updateGetStatus: () => Promise.resolve({ status: "idle" }),
		updateCheck:     () => Promise.resolve({ status: "idle" }),
		updateDownload:  resolvedVoid,
		updateInstall:   noop,
		onUpdateStatus:  noopSub,

		// -- Dialogs --
		showConfirmDialog: ({ message, detail, buttons = ["OK", "Cancel"] }) => {
			const text = detail ? `${message}\n\n${detail}` : message;
			return Promise.resolve(window.confirm(text) ? 0 : 1);
		},
		showContextMenu: () => Promise.resolve(null),

		// -- External links --
		openExternal: (url) => { window.open(url, "_blank"); },

		// -- Analytics --
		trackEvent: (name, props) => console.debug("[analytics]", name, props),

		// -- Integrations / agents --
		getAgents:        () => Promise.resolve([]),
		installSkill:     resolvedVoid,
		hasOfferedPlugin: () => Promise.resolve(true),
		markPluginOffered: resolvedVoid,

		// -- PTY (no real shell in browser) --
		ptyKillSession:   resolvedVoid,
		ptyWrite:         noop,
		ptyCapture:       () => Promise.resolve(""),
		ptyDiscover:      () => Promise.resolve([]),
		onPtyStatusChanged: noopSub,
		onPtyExit:          noopSub,

		// -- Browser tile --
		browserNavigate:   () => Promise.resolve({ url: "" }),
		browserScreenshot: () => Promise.resolve({ data: "" }),
		browserSnapshot:   resolvedNull,
		browserClick:      resolvedVoid,
		browserType:       resolvedVoid,
		browserScroll:     resolvedVoid,
		browserEvaluate:   () => Promise.resolve({ value: undefined }),
		browserWait:       () => Promise.resolve({ status: "idle" }),
		browserInfo:       () => Promise.resolve({ url: "", title: "", loading: false, canGoBack: false, canGoForward: false }),

		// -- ACP agent events --
		onAgentUpdate:        noopSub,
		onAgentPromptComplete: noopSub,
		onAgentPromptError:   noopSub,
		onAgentExit:          noopSub,
		onAgentSessionReady:  noopSub,
		onAgentSessionFailed: noopSub,
	};

	console.log("[shell-dev-shim] window.shellApi mock installed");
}
