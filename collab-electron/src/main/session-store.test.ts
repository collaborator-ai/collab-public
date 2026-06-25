import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import {
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
} from "./session-store";

describe("session-store", () => {
  const testId = "test-" + Date.now().toString(16);

  afterEach(() => {
    deleteSessionMeta(testId);
  });

  test("writeSessionMeta + readSessionMeta round-trip", () => {
    const meta = {
      shell: "/bin/zsh",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
    };
    writeSessionMeta(testId, meta);
    const read = readSessionMeta(testId);
    expect(read).toEqual(meta);
  });

  test("readSessionMeta returns null for missing file", () => {
    expect(readSessionMeta("nonexistent-id")).toBeNull();
  });

  test("readSessionMeta returns null for corrupt JSON", () => {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(
      `${SESSION_DIR}/${testId}.json`, "not json",
    );
    expect(readSessionMeta(testId)).toBeNull();
  });

  test("deleteSessionMeta is no-op for missing file", () => {
    expect(
      () => deleteSessionMeta("nonexistent-id"),
    ).not.toThrow();
  });
});
