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
