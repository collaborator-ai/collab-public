import { describe, test, expect, afterAll } from "bun:test";
import { loadConfig, getPref, setPref, getInProcessTerminals } from "./config";

// Capture the on-disk value up front so the round-trip assertions below never
// leave the user's real config mutated (setPref persists to disk).
const ORIGINAL = getPref(loadConfig(), "inProcessTerminals");

afterAll(() => {
  setPref(loadConfig(), "inProcessTerminals", ORIGINAL);
});

describe("getInProcessTerminals", () => {
  test("returns boolean", () => {
    expect(typeof getInProcessTerminals()).toBe("boolean");
  });

  test("returns true when pref is explicitly true", () => {
    const config = loadConfig();
    setPref(config, "inProcessTerminals", true);
    expect(getInProcessTerminals()).toBe(true);
  });

  test("returns false when pref is explicitly false", () => {
    const config = loadConfig();
    setPref(config, "inProcessTerminals", false);
    expect(getInProcessTerminals()).toBe(false);
  });

  test("defaults to true when pref is unset", () => {
    const config = loadConfig();
    delete (config.ui as Record<string, unknown>).inProcessTerminals;
    setPref(config, "inProcessTerminals", null);
    // null is not a boolean, so the accessor falls back to the default.
    expect(getInProcessTerminals()).toBe(true);
  });
});
