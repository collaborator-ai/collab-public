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
