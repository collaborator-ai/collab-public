import { useEffect, useState } from "react";
import { TerminalTab } from "@collab/components/Terminal";

/** Approximate terminal dimensions from the viewport before xterm mounts. */
function estimateTermSize(): { cols: number; rows: number } {
  const CHAR_WIDTH = 7.22; // Menlo 12px on macOS
  const CELL_HEIGHT = 17; // xterm line height at fontSize 12
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  return {
    cols: Math.max(80, Math.floor(w / CHAR_WIDTH)),
    rows: Math.max(24, Math.floor(h / CELL_HEIGHT)),
  };
}

function App() {
  const [sessionId, setSessionId] = useState<string | null>(
    null,
  );
  const [exited, setExited] = useState(false);
  const [restored, setRestored] = useState(false);
  const [scrollbackData, setScrollbackData] =
    useState<string | null>(null);
  const [sessionMode, setSessionMode] =
    useState<"tmux" | "sidecar" | undefined>(undefined);

  useEffect(() => {
    const params = new URLSearchParams(
      window.location.search,
    );
    const existingSessionId = params.get("sessionId");
    const isRestored = params.get("restored") === "1";
    const cwd = params.get("cwd") || undefined;
    const tileId = params.get("tileId") || undefined;
    const target = params.get("target") || undefined;

    const createFreshSession = (
      sessionTarget: string | undefined = target,
      nextCwd?: string,
    ) => {
      const est = estimateTermSize();
      window.api
        .ptyCreate(nextCwd ?? cwd, est.cols, est.rows, sessionTarget, tileId)
        .then((result) => {
          setSessionId(result.sessionId);
          window.api.notifyPtySessionId(
            result.sessionId,
          );
          // If the requested cwd no longer existed, the main process
          // opened the shell in the nearest existing parent. Report that
          // corrected cwd so it becomes the default for subsequent
          // terminals and the fallback notice doesn't recur.
          const requestedCwd = nextCwd ?? cwd;
          if (
            requestedCwd
            && result.cwdHostPath
            && result.cwdHostPath !== requestedCwd
          ) {
            window.api.notifyCwdChanged(
              result.sessionId,
              result.cwdHostPath,
            );
          }
        })
        .catch(() => {
          setExited(true);
        });
    };

    if (isRestored && existingSessionId) {
      setRestored(true);
      const { cols, rows } = estimateTermSize();

      window.api
        .ptyDiscover()
        .then((sessions) => {
          const found = sessions.some(
            (session) => session.sessionId === existingSessionId,
          );
          if (!found) {
            throw new Error("Missing restored session");
          }
          return window.api.ptyReconnect(
            existingSessionId,
            cols,
            rows,
          );
        })
        .then((result) => {
          if (result.scrollback) {
            setScrollbackData(result.scrollback);
          }
          if (result.mode) {
            setSessionMode(result.mode);
          }
          setSessionId(existingSessionId);
        })
        .catch(async () => {
          setRestored(false);
          // Recover the original working directory from session
          // metadata so the fallback session opens in the right place.
          let fallbackCwd = cwd;
          let fallbackTarget: string | undefined;
          if (existingSessionId) {
            try {
              const meta = await window.api.ptyReadMeta(
                existingSessionId,
              );
              if (!fallbackCwd && meta?.cwd) fallbackCwd = meta.cwd;
              if (meta?.target) fallbackTarget = meta.target;
            } catch {
              // Metadata unavailable — fall through to default
            }
          }
          createFreshSession(fallbackTarget, fallbackCwd);
        });

      return;
    }

    if (existingSessionId) {
      setSessionId(existingSessionId);
      return;
    }

    createFreshSession();
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    const handleExit = (payload: {
      sessionId: string;
      exitCode: number;
    }) => {
      if (payload.sessionId === sessionId) {
        setExited(true);
      }
    };
    window.api.onPtyExit(sessionId, handleExit);
    return () => window.api.offPtyExit(sessionId, handleExit);
  }, [sessionId]);

  if (exited) {
    return (
      <div className="terminal-tile-exited">
        Session ended
      </div>
    );
  }

  if (!sessionId) {
    return (
      <div className="terminal-tile-loading">
        Connecting...
      </div>
    );
  }

  return (
    <TerminalTab
      sessionId={sessionId}
      visible={true}
      restored={restored}
      scrollbackData={scrollbackData}
      mode={sessionMode}
    />
  );
}

export default App;
