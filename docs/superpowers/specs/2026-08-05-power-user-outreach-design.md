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
exists and checks immediately; the modal is sent as soon as the flag
evaluates and the shell window has finished loading (the send waits for
`did-finish-load` if the renderer is still loading, so it is never lost).

The app holds **no local outreach state**. All done/snoozed state lives in
PostHog as person properties, and the flag's release conditions do the
gating server-side:

- Group A (fresh): `distinct_id` in the target list AND `outreach_status`
  is not set AND `outreach_snoozed_at` is not set.
- Group B (snooze expired): `distinct_id` in the target list AND
  `outreach_status` is not set AND `outreach_snoozed_at` more than
  **3 days** ago.

The app's only job: evaluate the flag with the existing posthog-node client
and the device ID (`getFeatureFlag` + `getFeatureFlagPayload`). If the
client is not initialized, the flag is disabled, the payload has no valid
`calUrl`, or the network call fails → log a warning and stop. Outreach
failures must never affect the app. Otherwise send `outreach:show` to the
shell window and track `outreach_modal_shown`.

IPC handlers (registered alongside the other `ipc-*` handlers):

- `outreach:schedule` — open `calUrl` externally with
  `metadata[posthogId]=<device ID>` appended (cal.com passes booking
  metadata to webhooks, joining the booking back to product usage), track
  `outreach_scheduled` with `$set: {outreach_status: "done"}`. The flag
  stops matching, so the modal never shows again.
- `outreach:snooze` — track `outreach_snoozed` with
  `$set: {outreach_snoozed_at: <now, ISO>}`. The flag stops matching until
  3 days later, indefinitely.

The cal.com webhook additionally writes `outreach_status: "booked"` via its
own `$set`, so completed bookings silence the modal even from a snoozed
state. Known trade-off: `$set` propagation through PostHog ingestion takes
seconds, so a snooze/schedule followed by an immediate relaunch can show
the modal one extra time.

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
- Renderer never talks to PostHog for this feature; the main process owns
  identity, flag evaluation, and the `$set` writes.

## Testing

- Gating logic lives in the flag's release conditions; verify it with
  PostHog's flag test-evaluation API against persons in each state (fresh,
  done, snoozed active, snooze expired).
- Flag evaluation, IPC wiring, and the modal are verified manually with a
  test device ID added to the flag.

## Out of scope

- No "never ask again" button — the two specified buttons only.
- No collecting emails or identity beyond what PostHog already has.
- No in-app scheduling; the button opens cal.com in the default browser.
