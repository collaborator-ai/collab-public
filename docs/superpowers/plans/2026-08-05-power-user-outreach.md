# Power-User Outreach Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show selected power users (targeted via a PostHog feature flag) an in-app modal inviting them to book a cal.com call.

**Architecture:** The main process evaluates the `power-user-outreach` feature flag with the existing posthog-node client and the device ID, gates on done/snoozed state persisted in `userData/outreach.json`, and IPCs the shell window to show a vanilla-JS modal. The renderer never talks to PostHog; the main process owns identity, flag evaluation, state, and opening the external URL.

**Tech Stack:** Electron (main + preload + vanilla-JS shell renderer), posthog-node 5.x, bun test.

**Spec:** `docs/superpowers/specs/2026-08-05-power-user-outreach-design.md`

## Global Constraints

- Working directory: `collab-electron/` inside the `alexandria` worktree (`~/repos/collab-public.alexandria`).
- Flag key: `power-user-outreach`. Payload shape: `{ "calUrl": "https://cal.com/..." }` — `calUrl` must be a string starting with `https://`.
- Snooze duration: 3 days. Startup delay before check: 15 seconds.
- Analytics event names: `outreach_modal_shown`, `outreach_scheduled`, `outreach_snoozed`.
- Modal copy, verbatim: headline "You're one of Collab's most active users"; body "We'd love to hear how you use it. A short conversation with you directly shapes what we build next."; primary button "Grab a time with us"; text link "Remind me later".
- Outreach failures (no client, network error, bad payload) must never affect the app: log a warning and skip.
- Main/preload TypeScript files use 2-space indent; shell renderer JS/CSS/HTML files use tabs (match surrounding files).
- Typecheck after TS changes: `npx tsc --noEmit -p tsconfig.node.json` (expect no new errors).
- Do NOT run the full `bun test` suite — some suites need node-pty (see collab-electron/CLAUDE.md). Run only the test file named in the task.
- Commit messages: imperative, `feat(shell): ...` / `feat(main): ...` style, ≤72-char subject.

---

### Task 1: Pure gating logic (`outreach-state.ts`)

**Files:**
- Create: `src/main/outreach-state.ts`
- Test: `src/main/outreach-state.test.ts`

**Interfaces:**
- Consumes: nothing (no imports beyond stdlib; this file must stay electron-free so bun can run it).
- Produces:
  - `type OutreachState = { status: "done" } | { status: "snoozed"; snoozedAt: string }`
  - `parseOutreachState(raw: string | null): OutreachState | null`
  - `shouldShowOutreach(state: OutreachState | null, now: Date): boolean`
  - `const SNOOZE_MS: number` (3 days in ms)

- [ ] **Step 1: Install dependencies in the worktree (it has no `node_modules` yet)**

Run: `cd ~/repos/collab-public.alexandria/collab-electron && bun install`

- [ ] **Step 2: Write the failing test**

Create `src/main/outreach-state.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  parseOutreachState,
  shouldShowOutreach,
  SNOOZE_MS,
} from "./outreach-state";

describe("parseOutreachState", () => {
  test("null input means never shown", () => {
    expect(parseOutreachState(null)).toBeNull();
  });

  test("parses done state", () => {
    expect(parseOutreachState('{"status":"done"}')).toEqual({
      status: "done",
    });
  });

  test("parses snoozed state with valid timestamp", () => {
    const raw = '{"status":"snoozed","snoozedAt":"2026-08-01T00:00:00.000Z"}';
    expect(parseOutreachState(raw)).toEqual({
      status: "snoozed",
      snoozedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  test("corrupt JSON is treated as never shown", () => {
    expect(parseOutreachState("not json{")).toBeNull();
  });

  test("unknown status is treated as never shown", () => {
    expect(parseOutreachState('{"status":"maybe"}')).toBeNull();
  });

  test("snoozed with unparseable timestamp is treated as never shown", () => {
    expect(
      parseOutreachState('{"status":"snoozed","snoozedAt":"garbage"}'),
    ).toBeNull();
  });

  test("non-object JSON is treated as never shown", () => {
    expect(parseOutreachState('"done"')).toBeNull();
  });
});

describe("shouldShowOutreach", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  test("shows when never shown before", () => {
    expect(shouldShowOutreach(null, now)).toBe(true);
  });

  test("never shows after done", () => {
    expect(shouldShowOutreach({ status: "done" }, now)).toBe(false);
  });

  test("hides while snooze is active", () => {
    const snoozedAt = new Date(now.getTime() - SNOOZE_MS + 60_000);
    expect(
      shouldShowOutreach(
        { status: "snoozed", snoozedAt: snoozedAt.toISOString() },
        now,
      ),
    ).toBe(false);
  });

  test("shows again once snooze has expired", () => {
    const snoozedAt = new Date(now.getTime() - SNOOZE_MS - 60_000);
    expect(
      shouldShowOutreach(
        { status: "snoozed", snoozedAt: snoozedAt.toISOString() },
        now,
      ),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/main/outreach-state.test.ts`
Expected: FAIL — cannot resolve `./outreach-state`.

- [ ] **Step 4: Write the implementation**

Create `src/main/outreach-state.ts`:

```typescript
export const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

export type OutreachState =
  | { status: "done" }
  | { status: "snoozed"; snoozedAt: string };

export function parseOutreachState(
  raw: string | null,
): OutreachState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const state = parsed as Record<string, unknown>;
  if (state.status === "done") return { status: "done" };
  if (
    state.status === "snoozed" &&
    typeof state.snoozedAt === "string" &&
    !Number.isNaN(Date.parse(state.snoozedAt))
  ) {
    return { status: "snoozed", snoozedAt: state.snoozedAt };
  }
  return null;
}

export function shouldShowOutreach(
  state: OutreachState | null,
  now: Date,
): boolean {
  if (!state) return true;
  if (state.status === "done") return false;
  return now.getTime() - Date.parse(state.snoozedAt) >= SNOOZE_MS;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/main/outreach-state.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/outreach-state.ts src/main/outreach-state.test.ts
git commit -m "feat(main): add outreach gating logic"
```

---

### Task 2: Flag helper + main-process wiring (`outreach.ts`)

**Files:**
- Modify: `src/main/analytics.ts` (add one exported function at the end)
- Create: `src/main/outreach.ts`
- Modify: `src/main/index.ts` (one import + one call)

**Interfaces:**
- Consumes: `parseOutreachState`, `shouldShowOutreach`, `OutreachState` from `./outreach-state` (Task 1); existing `getDeviceId`, `trackEvent`, and module-level `client` in `analytics.ts`.
- Produces:
  - `getFlagPayload(flag: string): Promise<unknown>` exported from `analytics.ts` — returns the payload if the flag is enabled for this device, else `null`.
  - `initOutreach(getWindow: () => BrowserWindow | null): void` exported from `outreach.ts`.
  - IPC surface used by Task 3: main→renderer event `outreach:show` (no args); renderer→main invokes `outreach:schedule` and `outreach:snooze` (no args).

- [ ] **Step 1: Add the flag helper to `analytics.ts`**

Append at the end of `src/main/analytics.ts`:

```typescript
export async function getFlagPayload(flag: string): Promise<unknown> {
  if (!client) return null;
  const distinctId = getDeviceId();
  const value = await client.getFeatureFlag(flag, distinctId);
  if (!value) return null;
  return (await client.getFeatureFlagPayload(flag, distinctId)) ?? null;
}
```

(posthog-node signatures: `getFeatureFlag(key, distinctId, options?): Promise<FeatureFlagValue | undefined>`, `getFeatureFlagPayload(key, distinctId, matchValue?, options?): Promise<JsonType | undefined>`.)

- [ ] **Step 2: Create `src/main/outreach.ts`**

```typescript
import { app, ipcMain, shell, type BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getFlagPayload, trackEvent } from "./analytics";
import {
  parseOutreachState,
  shouldShowOutreach,
  type OutreachState,
} from "./outreach-state";

const OUTREACH_FLAG = "power-user-outreach";
const OUTREACH_DELAY_MS = 15_000;

let calUrl: string | null = null;

function statePath(): string {
  return join(app.getPath("userData"), "outreach.json");
}

function readState(): OutreachState | null {
  try {
    return parseOutreachState(readFileSync(statePath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeState(state: OutreachState): void {
  const filePath = statePath();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(state));
}

async function maybeShowOutreach(
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (!shouldShowOutreach(readState(), new Date())) return;

  let payload: unknown;
  try {
    payload = await getFlagPayload(OUTREACH_FLAG);
  } catch (err) {
    console.warn("[outreach] flag evaluation failed:", err);
    return;
  }
  if (typeof payload !== "object" || payload === null) return;
  const url = (payload as Record<string, unknown>).calUrl;
  if (typeof url !== "string" || !url.startsWith("https://")) {
    console.warn("[outreach] flag payload has no valid calUrl");
    return;
  }

  const win = getWindow();
  if (!win || win.isDestroyed()) return;

  calUrl = url;
  win.webContents.send("outreach:show");
  trackEvent("outreach_modal_shown");
}

export function initOutreach(
  getWindow: () => BrowserWindow | null,
): void {
  ipcMain.handle("outreach:schedule", async () => {
    if (!calUrl) return;
    await shell.openExternal(calUrl);
    writeState({ status: "done" });
    trackEvent("outreach_scheduled");
  });

  ipcMain.handle("outreach:snooze", () => {
    writeState({
      status: "snoozed",
      snoozedAt: new Date().toISOString(),
    });
    trackEvent("outreach_snoozed");
  });

  setTimeout(() => {
    void maybeShowOutreach(getWindow);
  }, OUTREACH_DELAY_MS);
}
```

Design notes (why, for the reviewer):
- `calUrl` lives only in the main process and `outreach:schedule` opens the stored URL — the renderer never supplies a URL to `shell.openExternal`.
- Every failure path returns silently after at most a `console.warn`; the app must never notice outreach problems.

- [ ] **Step 3: Wire into startup in `src/main/index.ts`**

Add to the existing import block near the top (alongside the `./analytics` import):

```typescript
import { initOutreach } from "./outreach";
```

In the `app.whenReady()` callback, immediately after these existing lines:

```typescript
  initMainAnalytics();
  trackEvent("app_launched");
```

add:

```typescript
  initOutreach(() => mainWindow);
```

- [ ] **Step 4: Typecheck and re-run Task 1's tests**

Run: `npx tsc --noEmit -p tsconfig.node.json && bun test src/main/outreach-state.test.ts`
Expected: no new type errors; 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/analytics.ts src/main/outreach.ts src/main/index.ts
git commit -m "feat(main): evaluate outreach flag and gate modal"
```

---

### Task 3: Preload API + shell modal UI

**Files:**
- Modify: `src/preload/shell.ts` (three entries in the `shellApi` object)
- Create: `src/windows/shell/src/outreach-modal.js`
- Modify: `src/windows/shell/src/renderer.js` (one import + one call)
- Modify: `src/windows/shell/src/shell.css` (append one section)

**Interfaces:**
- Consumes: IPC surface from Task 2 — event `outreach:show`, invokes `outreach:schedule` / `outreach:snooze`.
- Produces: `window.shellApi.onOutreachShow(cb)`, `window.shellApi.outreachSchedule()`, `window.shellApi.outreachSnooze()`; `initOutreachModal()` exported from `outreach-modal.js`.

- [ ] **Step 1: Extend the preload bridge**

In `src/preload/shell.ts`, inside the `contextBridge.exposeInMainWorld("shellApi", { ... })` object, add after the `onSettingsToggle` entry (2-space indent, matching the file):

```typescript
  onOutreachShow: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("outreach:show", handler);
    return () => ipcRenderer.removeListener("outreach:show", handler);
  },
  outreachSchedule: (): Promise<void> =>
    ipcRenderer.invoke("outreach:schedule"),
  outreachSnooze: (): Promise<void> =>
    ipcRenderer.invoke("outreach:snooze"),
```

- [ ] **Step 2: Create the modal module**

Create `src/windows/shell/src/outreach-modal.js` (tabs, matching shell renderer files):

```javascript
export function initOutreachModal() {
	window.shellApi.onOutreachShow(() => showModal());
}

function showModal() {
	if (document.getElementById("outreach-backdrop")) return;

	const backdrop = document.createElement("div");
	backdrop.id = "outreach-backdrop";

	const card = document.createElement("div");
	card.id = "outreach-card";
	card.setAttribute("role", "dialog");
	card.setAttribute("aria-modal", "true");
	card.setAttribute("aria-labelledby", "outreach-headline");
	card.innerHTML = `
		<h2 id="outreach-headline">You're one of Collab's most active users</h2>
		<p>We'd love to hear how you use it. A short conversation with you
		directly shapes what we build next.</p>
		<button type="button" id="outreach-schedule">Grab a time with us</button>
		<a href="#" id="outreach-snooze">Remind me later</a>
	`;

	backdrop.appendChild(card);
	document.body.appendChild(backdrop);

	const close = () => {
		document.removeEventListener("keydown", onKeydown);
		backdrop.remove();
	};
	const snooze = () => {
		window.shellApi.outreachSnooze();
		close();
	};
	const onKeydown = (e) => {
		if (e.key === "Escape") snooze();
	};

	card.querySelector("#outreach-schedule").addEventListener("click", () => {
		window.shellApi.outreachSchedule();
		close();
	});
	card.querySelector("#outreach-snooze").addEventListener("click", (e) => {
		e.preventDefault();
		snooze();
	});
	backdrop.addEventListener("click", (e) => {
		if (e.target === backdrop) snooze();
	});
	document.addEventListener("keydown", onKeydown);

	card.querySelector("#outreach-schedule").focus();
}
```

Every exit path (button, link, Esc, backdrop click) resolves to schedule or snooze — the modal cannot be dismissed without recording state (per spec).

- [ ] **Step 3: Wire into the shell renderer**

In `src/windows/shell/src/renderer.js`, add to the import block at the top:

```javascript
import { initOutreachModal } from "./outreach-modal.js";
```

and call it once right after the imports and constants (near the alpha-banner setup, before viewport/tile initialization):

```javascript
initOutreachModal();
```

- [ ] **Step 4: Append modal styles to `shell.css`**

Append at the end of `src/windows/shell/src/shell.css` (tabs). Before committing to `z-index: 1000`, check the file's existing maximum (`rg -n "z-index" src/windows/shell/src/shell.css`) and use a value above it:

```css
/* -- Power-user outreach modal -- */

#outreach-backdrop {
	position: fixed;
	inset: 0;
	z-index: 1000;
	background: rgba(0, 0, 0, 0.35);
	display: flex;
	align-items: center;
	justify-content: center;
}

#outreach-card {
	background: var(--bg);
	color: var(--fg);
	border: 1px solid var(--border);
	border-radius: 10px;
	padding: 28px 32px;
	max-width: 400px;
	text-align: center;
	font-family: var(--font-sans);
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}

#outreach-card h2 {
	margin: 0 0 12px;
	font-size: 18px;
}

#outreach-card p {
	margin: 0 0 20px;
	color: var(--muted);
	font-size: 14px;
	line-height: 1.5;
}

#outreach-schedule {
	display: block;
	width: 100%;
	padding: 10px 16px;
	border: none;
	border-radius: 8px;
	background: var(--edge-dot);
	color: white;
	font-size: 14px;
	font-weight: 600;
	font-family: var(--font-sans);
	cursor: pointer;
}

#outreach-schedule:hover {
	background: var(--edge-dot-hover);
}

#outreach-snooze {
	display: inline-block;
	margin-top: 14px;
	color: var(--muted);
	font-size: 12px;
	text-decoration: none;
}

#outreach-snooze:hover {
	text-decoration: underline;
}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.node.json`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/preload/shell.ts src/windows/shell/src/outreach-modal.js src/windows/shell/src/renderer.js src/windows/shell/src/shell.css
git commit -m "feat(shell): add power-user outreach modal"
```

---

### Task 4: End-to-end verification

**Files:** none created; manual QA against a real flag.

**Interfaces:**
- Consumes: everything from Tasks 1–3, plus a `power-user-outreach` flag in PostHog.

- [ ] **Step 1: Create the flag in PostHog (manual, PostHog UI)**

In the Collaborators Inc. PostHog project: new feature flag, key `power-user-outreach`, release condition matching your own device ID (read it from `cat "$HOME/Library/Application Support/Collaborator/device-id"` — confirm the actual userData directory name if the app ID differs), payload `{"calUrl": "https://cal.com/<your-link>"}`.

- [ ] **Step 2: Run the app and verify the modal appears**

Run: `bun run dev`
Expected: ~15s after the shell window loads, the modal appears with the spec copy. Verify in PostHog that `outreach_modal_shown` was captured.

- [ ] **Step 3: Verify snooze paths**

Click "Remind me later" → modal closes; `~/Library/Application Support/Collaborator/outreach.json` (same userData directory as step 1) contains `{"status":"snoozed","snoozedAt":...}`; relaunch → no modal. Repeat once using Esc and once using a backdrop click (delete `outreach.json` between attempts to re-arm).

- [ ] **Step 4: Verify schedule path**

Delete `outreach.json`, relaunch, click "Grab a time with us" → default browser opens the cal.com link, file contains `{"status":"done"}`, relaunch → no modal. Verify `outreach_scheduled` in PostHog.

- [ ] **Step 5: Verify the disabled path**

Set the flag's release condition to 0%/no matches, delete `outreach.json`, relaunch → no modal, no errors beyond at most a warning log.

- [ ] **Step 6: Reset your own state**

Turn the flag off (or remove your device ID from it) and delete your local `outreach.json` so you don't keep seeing the modal during development.
