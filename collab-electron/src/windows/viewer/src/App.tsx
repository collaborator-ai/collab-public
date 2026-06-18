import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppConfig, type TreeNode, type ViewerItem } from "@collab/shared/types";
import {
	parseFileToViewerItem,
	serializeViewerItem,
} from "@collab/shared/viewer-item";
import { splitFilepath } from "@collab/shared/filepath";
import { ItemDetailView } from "@collab/components/ItemDetailView";
import { WorkspaceGraph } from "@collab/components/WorkspaceGraph";
import { FolderTableView } from "@collab/components/FolderTableView";
import "@collab/components/WorkspaceGraph/WorkspaceGraph.css";
import "@collab/components/FolderTableView/FolderTableView.css";
import "@collab/components/TreeView/TreeView.css";
import "@collab/components/Editor/Blocknote.css";
import "@collab/components/Editor/WikiLink.css";
import { CodeEditorView } from "@collab/components/CodeEditorView";
import "@collab/components/CodeEditorView/CodeEditorView.css";
import { isImageFile } from "@collab/shared/image";
import { isPdfFile } from "@collab/shared/pdf";
import { toCollabFileUrl } from "@collab/shared/collab-file-url";
import { extractCoverImageUrl } from "@collab/shared/extract-cover-image";
import { ImageView } from "@collab/components/ImageView/ImageView";
import "./styles/App.css";

const MARKDOWN_EXTENSIONS = new Set([
	".md", ".mdx", ".markdown", ".txt",
]);
const ENABLE_STALE_LOAD_GUARD = true;

function isMarkdownFile(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return false;
	return MARKDOWN_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function CloseOverlay({
	onClick,
	theme,
}: {
	onClick: () => void;
	theme: "light" | "dark";
}) {
	return (
		<div className="close-overlay-control" data-theme={theme}>
			<button
				type="button"
				className="close-overlay-button"
				onClick={onClick}
				aria-label="Close"
			>
				<svg
					aria-hidden="true"
					width="12"
					height="12"
					viewBox="0 0 12 12"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
				>
					<path
						d="M3 3L9 9M9 3L3 9"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			<span className="close-overlay-hint" aria-hidden="true">
				esc
			</span>
		</div>
	);
}

function blurGuestActiveElement() {
	const active = document.activeElement as HTMLElement | null;
	active?.blur();

	const selection = window.getSelection();
	if (selection && selection.type === "Range") {
		selection.removeAllRanges();
	}
}

export default function App() {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
	const [workspacePath, setWorkspacePath] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState("");
	const lastWrittenContentRef = useRef<string | null>(null);
	const [loadedPath, setLoadedPath] = useState<string | null>(null);
	const [fileStats, setFileStats] = useState<{
		ctime: string;
		mtime: string;
	} | null>(null);
	const [fileError, setFileError] = useState<string | null>(null);
	const isRenamingRef = useRef(false);
	const fileMtimeRef = useRef<string | null>(null);
	const selectedPathRef = useRef(selectedPath);
	const latestLoadTokenRef = useRef<symbol | null>(null);
	const mainRef = useRef<HTMLElement>(null);
	selectedPathRef.current = selectedPath;

	const [isTileMode] = useState(
		() => new URLSearchParams(window.location.search).has("tilePath"),
	);

	// Tile mode: load file directly from query params
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const tp = params.get("tilePath");
		if (tp && tp !== "undefined" && tp !== "null") {
			setSelectedPath(tp);
		}
	}, []);

	// Load workspace path on mount
	useEffect(() => {
		window.api.getConfig().then((config) => {
			const active = config.workspaces?.[0];
			if (active) setWorkspacePath(active);
		});
	}, []);

	useEffect(() => {
		return window.api.onShellBlur(() => {
			blurGuestActiveElement();
		});
	}, []);

	// Keep workspace path in sync when workspaces change (singleton viewer only)
	useEffect(() => {
		if (isTileMode) return;
		const refresh = () => {
			window.api.getConfig().then((config) => {
				const active = config.workspaces?.[0];
				setWorkspacePath((prev) => {
					if (prev !== (active ?? null)) setSelectedPath(null);
					return active ?? null;
				});
			});
		};
		const unsub1 = window.api.onWorkspaceAdded(refresh);
		const unsub2 = window.api.onWorkspaceRemoved(refresh);
		return () => { unsub1(); unsub2(); };
	}, []);

	// File selection is now restored via the onFileSelected IPC event
	// sent by the shell on mount — no separate getSelectedFile needed.

	// Listen for file selection from nav view (singleton viewer only)
	useEffect(() => {
		if (isTileMode) return;
		return window.api.onFileSelected((path) => {
			setSelectedPath(path);
			setFocusedFolder(null);
		});
	}, []);

	// Listen for folder selection from nav view
	useEffect(() => {
		return window.api.onFolderSelected((path) => {
			setFocusedFolder(path);
			setSelectedPath(null);
		});
	}, []);

	// Listen for file renames to keep selectedPath in sync
	useEffect(() => {
		return window.api.onFileRenamed((oldPath, newPath) => {
			setSelectedPath((current) => {
				if (current === oldPath) {
					isRenamingRef.current = true;
					return newPath;
				}
				return current;
			});
		});
	}, []);

	// Close viewer when current file is deleted externally
	useEffect(() => {
		return window.api.onFilesDeleted((paths) => {
			setSelectedPath((current) => {
				if (current && paths.includes(current)) {
					window.api.selectFile(null);
					return null;
				}
				return current;
			});
		});
	}, []);

	// Re-read content when wikilinks are updated in the current file
	useEffect(() => {
		return window.api.onWikilinksUpdated((updatedPaths) => {
			const current = selectedPathRef.current;
			if (current && updatedPaths.includes(current)) {
				Promise.all([
					window.api.readFile(current),
					window.api.getFileStats(current),
				])
					.then(([content, stats]) => {
						setFileContent(content);
						setFileStats(stats);
					})
					.catch((err) => {
						console.error(
							"Failed to reload after wikilinks update:",
							err,
						);
					});
			}
		});
	}, []);

	// Re-read file content when it changes on disk
	useEffect(() => {
		if (!selectedPath || isImageFile(selectedPath) || isPdfFile(selectedPath)) return;

		return window.api.onFsChanged((events) => {
			const currentPath = selectedPathRef.current;
			if (!currentPath) return;

			const changed = events.some((e) =>
				e.changes.some((c) => c.path === currentPath),
			);
			if (!changed) return;

			Promise.all([
				window.api.readFile(currentPath),
				window.api.getFileStats(currentPath),
			])
				.then(([content, stats]) => {
					fileMtimeRef.current = stats.mtime;
					if (lastWrittenContentRef.current !== null && content === lastWrittenContentRef.current) {
						return;
					}
					setFileContent(content);
					setFileStats(stats);
				})
				.catch((err) => {
					console.error("Failed to re-read file:", err);
				});
		});
	}, [selectedPath]);

	// Re-check file when window regains focus
	useEffect(() => {
		const onFocus = () => {
			const currentPath = selectedPathRef.current;
			if (!currentPath || isImageFile(currentPath) || isPdfFile(currentPath)) return;

			window.api.getFileStats(currentPath).then((stats) => {
				if (fileMtimeRef.current && stats.mtime !== fileMtimeRef.current) {
					window.api.readFile(currentPath).then((content) => {
						fileMtimeRef.current = stats.mtime;
						setFileContent(content);
						setFileStats(stats);
					}).catch((err) => {
						console.error("Failed to re-read file on focus:", err);
					});
				}
			}).catch(() => {});
		};

		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	// Load file content when selected
	// After a rename the path changes but content is unchanged — skip reload
	const prevPathRef = useRef(selectedPath);
	useEffect(() => {
		const pathChanged = selectedPath !== prevPathRef.current;
		prevPathRef.current = selectedPath;

		if (pathChanged && isRenamingRef.current) {
			isRenamingRef.current = false;
			latestLoadTokenRef.current = null;
			setLoadedPath(selectedPath);
			setFileError(null);
			return;
		}

		if (!selectedPath) {
			latestLoadTokenRef.current = null;
			fileMtimeRef.current = null;
			lastWrittenContentRef.current = null;
			setFileContent("");
			setLoadedPath(null);
			setFileStats(null);
			setFileError(null);
			return;
		}

		const path = selectedPath;
		const loadToken = Symbol("viewer-load");
		latestLoadTokenRef.current = loadToken;

		if (pathChanged) {
			setFileError(null);
		}

		if (isImageFile(path) || isPdfFile(path)) {
			setFileContent("");
			setLoadedPath(path);
			setFileError(null);
			window.api
				.getFileStats(path)
				.then((stats) => {
					if (
						ENABLE_STALE_LOAD_GUARD &&
						latestLoadTokenRef.current !== loadToken
					) {
						return;
					}
					setFileStats(stats);
				})
				.catch(() => {});
			return;
		}

			Promise.all([
				window.api.readFile(path),
				window.api.getFileStats(path),
			])
				.then(([content, stats]) => {
					if (
						ENABLE_STALE_LOAD_GUARD &&
						latestLoadTokenRef.current !== loadToken ||
						ENABLE_STALE_LOAD_GUARD &&
						selectedPathRef.current !== path
					) {
						return;
					}
				setFileContent(content);
				setLoadedPath(path);
				setFileStats(stats);
				fileMtimeRef.current = stats.mtime;
				setFileError(null);
				})
				.catch((err) => {
					if (
						ENABLE_STALE_LOAD_GUARD &&
						latestLoadTokenRef.current !== loadToken ||
						ENABLE_STALE_LOAD_GUARD &&
						selectedPathRef.current !== path
					) {
						return;
					}
				setFileError(String(err));
			});
	}, [selectedPath]);

	// Reset scroll to the top whenever a different file is opened. Keyed on
	// loadedPath so in-place reloads (fs change, focus, wikilink update) that
	// only refresh content keep the reader's position.
	useEffect(() => {
		if (mainRef.current) mainRef.current.scrollTop = 0;
	}, [loadedPath]);

	const viewerItem = useMemo<ViewerItem | null>(() => {
		if (!loadedPath || fileError) return null;
		return parseFileToViewerItem(
			loadedPath,
			fileContent,
			fileStats ?? undefined,
		);
	}, [loadedPath, fileContent, fileError, fileStats]);

	const [coverImageFailed, setCoverImageFailed] = useState(false);

	const coverImageUrl = useMemo(() => {
		if (!viewerItem || !loadedPath || !isMarkdownFile(loadedPath)) return null;
		return extractCoverImageUrl(
			viewerItem.text ?? "",
			viewerItem.frontmatter,
			loadedPath,
		);
	}, [viewerItem, loadedPath]);

	useEffect(() => {
		setCoverImageFailed(false);
	}, [coverImageUrl]);

	const hasCoverImage = !!coverImageUrl && !coverImageFailed;

	const saveViewerText = useCallback(
		async (text: string) => {
			if (!loadedPath || !viewerItem) return;
			if (selectedPathRef.current !== loadedPath) return;
			const content = serializeViewerItem(viewerItem, text);
			lastWrittenContentRef.current = content;
			const result = await window.api.writeFile(
				loadedPath,
				content,
				fileMtimeRef.current ?? undefined,
			);
			if (result.ok) fileMtimeRef.current = result.mtime;
			return result;
		},
		[loadedPath, viewerItem],
	);

	const saveCodeContent = useCallback(
		async (text: string) => {
			if (!loadedPath) return;
			lastWrittenContentRef.current = text;
			const result = await window.api.writeFile(
				loadedPath,
				text,
				fileMtimeRef.current ?? undefined,
			);
			if (result.ok) fileMtimeRef.current = result.mtime;
			return result;
		},
		[loadedPath],
	);

	const handleRename = useCallback(
		async (newTitle: string) => {
			if (!loadedPath) return;
			try {
				const newPath = await window.api.renameFile(loadedPath, newTitle);
				isRenamingRef.current = true;
				setSelectedPath(newPath);
			} catch (err) {
				console.error("Rename failed:", err);
			}
		},
		[loadedPath],
	);

	const [theme, setTheme] = useState<"light" | "dark">(() => {
		return document.documentElement.classList.contains("dark")
			? "dark"
			: "light";
	});

	useEffect(() => {
		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		const handleChange = (e: MediaQueryListEvent) => {
			setTheme(e.matches ? "dark" : "light");
		};
		mediaQuery.addEventListener("change", handleChange);
		return () => mediaQuery.removeEventListener("change", handleChange);
	}, []);

	const [navVisible, setNavVisible] = useState(true);

	useEffect(() => {
		return window.api.onNavVisibility((visible) => {
			setNavVisible(visible);
		});
	}, []);

	const handleExplorerSelect = useCallback((path: string) => {
		window.api.selectFile(path);
	}, []);

	const handleClose = useCallback(() => {
		window.api.selectFile(null);
		setSelectedPath(null);
	}, []);

	const handleCloseFolder = useCallback(() => {
		setFocusedFolder(null);
	}, []);

	// Escape key closes folder table or file viewer
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Escape") return;
			if (isTileMode) return;
			if (!focusedFolder && !selectedPath) return;

			const active = document.activeElement as HTMLElement | null;
			const isEditable =
				active?.isContentEditable ||
				active?.tagName === "TEXTAREA" ||
				(active?.tagName === "INPUT" &&
					!["button", "checkbox", "radio", "submit", "reset"].includes(
						(active as HTMLInputElement).type,
					));

			if (isEditable) {
				e.preventDefault();
				blurGuestActiveElement();
				return;
			}

			e.preventDefault();
			if (focusedFolder && !selectedPath) {
				handleCloseFolder();
			} else {
				handleClose();
			}
		}

		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [selectedPath, focusedFolder, isTileMode, handleClose, handleCloseFolder]);

	const displayedPath = loadedPath;
	const editingDisabled = !!selectedPath && selectedPath !== loadedPath && !isRenamingRef.current;
	const displayedIsMarkdown = displayedPath
		? isMarkdownFile(displayedPath)
		: false;
	const displayedIsImage = displayedPath
		? isImageFile(displayedPath)
		: false;
	const displayedIsPdf = displayedPath
		? isPdfFile(displayedPath)
		: false;
	const showFileLoading =
		!!selectedPath &&
		!displayedPath &&
		!fileError;
	const hasMarkdownFile =
		!!viewerItem &&
		!fileError &&
		!!displayedPath &&
		displayedIsMarkdown;
	const hasImageFile =
		!!displayedPath &&
		!fileError &&
		displayedIsImage;
	const hasPdfFile =
		!!displayedPath &&
		!fileError &&
		displayedIsPdf;
	const hasCodeFile =
		!!displayedPath &&
		!fileError &&
		!displayedIsMarkdown &&
		!displayedIsImage &&
		!displayedIsPdf;
	const hasFile =
		hasMarkdownFile || hasCodeFile || hasImageFile || hasPdfFile || showFileLoading;
	const hasFolder = !!focusedFolder && !selectedPath;
	const headerPath = showFileLoading
		? selectedPath
		: displayedPath;

	return (
		<div className={`app${navVisible ? " nav-visible" : ""}`}>
			{hasFile && headerPath && !isTileMode && (() => {
				const { parent, name } = splitFilepath(headerPath);
				return (
					<div className="item-filepath">
						<span className="filepath-text" title={headerPath}>
							<span className="filepath-parent">{parent}</span>
							<span className="filepath-name">{name}</span>
						</span>
					</div>
				);
			})()}
			<main ref={mainRef} className="main-content scrollbar-hover">
				{hasCoverImage && (
					<div className="item-cover-image">
						<img
							src={coverImageUrl}
							alt="Cover"
							className="cover-image"
							onError={() => setCoverImageFailed(true)}
						/>
					</div>
				)}
				{fileError && (
					<div className="empty-state" style={{ color: "#ef4444" }}>
						{fileError}
					</div>
				)}
				{hasFolder && (
					<>
						{!isTileMode && <CloseOverlay onClick={handleCloseFolder} theme={theme} />}
						<FolderTableView
							folderPath={focusedFolder}
							onSelectFile={handleExplorerSelect}
						/>
					</>
				)}
				{hasFile && !isTileMode && (
					<CloseOverlay onClick={handleClose} theme={theme} />
				)}
				{showFileLoading && (
					<>
						<div className="loading-state">
							<div className="loading-spinner"></div>
							<div className="loading-text">Loading...</div>
						</div>
					</>
				)}
				{hasMarkdownFile && (
					<>
						<ItemDetailView
							item={viewerItem}
							onTextChange={saveViewerText}
							onTitleChange={handleRename}
							theme={theme}
							editingDisabled={editingDisabled}
							className={isTileMode ? "canvas-tile-embed" : undefined}
						/>
					</>
				)}
				{hasCodeFile && displayedPath && (
					<>
						<CodeEditorView
							filePath={displayedPath}
							content={fileContent}
							onContentChange={saveCodeContent}
							theme={theme}
							editingDisabled={editingDisabled}
							className={isTileMode ? "canvas-tile-embed" : undefined}
						/>
					</>
				)}
				{hasImageFile && displayedPath && (
					<>
						<ImageView
							filePath={displayedPath}
							fileStats={fileStats}
							theme={theme}
							className={isTileMode ? "canvas-tile-embed" : undefined}
						/>
					</>
				)}
				{hasPdfFile && displayedPath && (
					<iframe
						src={toCollabFileUrl(displayedPath)}
						sandbox="allow-same-origin"
						style={{ width: "100%", height: "100%", border: "none" }}
						title={displayedPath}
					/>
				)}
			</main>
		</div>
	);
}
