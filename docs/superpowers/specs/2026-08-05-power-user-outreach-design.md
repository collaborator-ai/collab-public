# Power-User Outreach Modal

**Date:** 2026-08-05
**Status:** Approved

## Purpose

We want to talk to our power users, but we have no accounts or emails — only
PostHog device IDs. This feature shows selected users an in-app modal inviting
them to book a call via cal.com.

## How it works

### Selection: PostHog feature flag

A feature flag named `power-user-outreach` in PostHog, targeted at the device
IDs (or a cohort) we want to reach. Its JSON payload carries the scheduling
link:

```json
{ "calUrl": "https://cal.com/..." }
```

The list of users and the cal.com link are both managed in the PostHog UI. No
new endpoint, no hosting, no release needed to change either.

The app's PostHog identity is the device UUID persisted at
`userData/device-id` (see `src/main/analytics.ts`).

### Main process: `src/main/outreach.ts` (new)

`initOutreach()` is called from `src/main/index.ts` once the shell window
exists, then waits ~15 seconds so it never competes with launch work.

Gating, in order:

1. Read `userData/outreach.json`. Shape is either `{"status": "done"}` or
   `{"status": "snoozed", "snoozedAt": "<ISO timestamp>"}`. A missing or
   unparseable file means the modal has never been shown.
2. If status is `done` → stop, permanently.
3. If status is `snoozed` and `snoozedAt` is less than **3 days** ago → stop.
4. Evaluate the flag with the existing posthog-node client and the device ID
   (`getFeatureFlag` + `getFeatureFlagPayload`). If the client is not
   initialized, the flag is disabled, the payload has no valid `calUrl`, or
   the network call fails → log a warning and stop. Outreach failures must
   never affect the app.
5. Send `outreach:show` with `calUrl` to the shell window and track
   `outreach_modal_shown`.

IPC handlers (registered alongside the other `ipc-*` handlers):

- `outreach:schedule` — `shell.openExternal(calUrl)`, write
  `{"status": "done"}`, track `outreach_scheduled`. The modal never shows
  again.
- `outreach:snooze` — write `{"status": "snoozed", "snoozedAt": now}`, track
  `outreach_snoozed`. The modal is eligible again 3 days later,
  indefinitely.

The gating decision is a pure function,
`shouldShowOutreach(state, now): boolean`, so it can be unit tested without
PostHog or the filesystem.

### Shell renderer: modal overlay

New `src/windows/shell/src/outreach-modal.js`, following the shell window's
vanilla-JS conventions, with styles in `shell.css`. On `outreach:show`, it
renders a centered card over a dimmed backdrop:

- Headline: "You're one of Collab's most active users"
- Two sentences: we'd love to hear how you use it; a short conversation
  directly shapes what we build next.
- Primary button: **"Grab a time with us"** → sends `outreach:schedule`
- Quiet text link: "Remind me later" → sends `outreach:snooze`

Every exit path resolves the modal: Esc and clicking the backdrop both count
as "remind me later". The modal cannot be dismissed without recording either
`done` or a snooze, so state stays consistent.

## Error handling

- No network / PostHog unreachable: warning log, no modal, no retry this
  launch. The next launch tries again.
- Corrupt `outreach.json`: treated as never-shown; the file is rewritten on
  the next user action.
- Renderer never talks to PostHog for this feature; the main process owns
  identity, flag evaluation, and state.

## Testing

- Unit tests for `shouldShowOutreach`: never-shown, done, snooze active,
  snooze expired, corrupt/missing state.
- Flag evaluation, IPC wiring, and the modal are verified manually with a
  test device ID added to the flag.

## Out of scope

- No "never ask again" button — the two specified buttons only.
- No collecting emails or identity beyond what PostHog already has.
- No in-app scheduling; the button opens cal.com in the default browser.
