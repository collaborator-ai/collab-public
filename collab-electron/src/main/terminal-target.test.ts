import { describe, expect, test } from "bun:test";
import { resolveTerminalTarget } from "./terminal-target";

describe("resolveTerminalTarget claude", () => {
  test("launches the claude binary with skip-permissions", () => {
    const resolved = resolveTerminalTarget("claude", "/some/dir");
    expect(resolved.target).toBe("claude");
    expect(resolved.command).toBe("claude");
    expect(resolved.args).toEqual(["--dangerously-skip-permissions"]);
    expect(resolved.displayName).toBe("Claude Code");
  });

  test("runs claude in the requested cwd on every platform", () => {
    const resolved = resolveTerminalTarget("claude", "/work/project");
    expect(resolved.cwd).toBe("/work/project");
    expect(resolved.cwdHostPath).toBe("/work/project");
  });
});
