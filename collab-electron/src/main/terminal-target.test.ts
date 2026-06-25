import { describe, expect, test } from "bun:test";
import { resolveTerminalTarget } from "./terminal-target";

describe("resolveTerminalTarget agents", () => {
  test("launches the claude binary with skip-permissions", () => {
    const resolved = resolveTerminalTarget("claude", "/some/dir");
    expect(resolved.target).toBe("claude");
    expect(resolved.command).toBe("claude");
    expect(resolved.args).toEqual(["--dangerously-skip-permissions"]);
    expect(resolved.displayName).toBe("Claude Code");
  });

  test("pins a claude conversation id with --session-id", () => {
    const resolved = resolveTerminalTarget("claude", "/some/dir", "abc-123");
    expect(resolved.args).toEqual([
      "--dangerously-skip-permissions",
      "--session-id",
      "abc-123",
    ]);
    expect(resolved.claudeSessionId).toBe("abc-123");
  });

  test("ignores a session id for agents without session support", () => {
    const resolved = resolveTerminalTarget("codex", "/some/dir", "abc-123");
    expect(resolved.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(resolved.claudeSessionId).toBeUndefined();
  });

  test("launches the codex binary with bypass flag", () => {
    const resolved = resolveTerminalTarget("codex", "/some/dir");
    expect(resolved.target).toBe("codex");
    expect(resolved.command).toBe("codex");
    expect(resolved.args).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
    expect(resolved.displayName).toBe("Codex");
  });

  test("launches opencode with no args (config-driven permissions)", () => {
    const resolved = resolveTerminalTarget("opencode", "/some/dir");
    expect(resolved.target).toBe("opencode");
    expect(resolved.command).toBe("opencode");
    expect(resolved.args).toEqual([]);
    expect(resolved.displayName).toBe("opencode");
  });

  test("runs the agent in the requested cwd on every platform", () => {
    const resolved = resolveTerminalTarget("codex", "/work/project");
    expect(resolved.cwd).toBe("/work/project");
    expect(resolved.cwdHostPath).toBe("/work/project");
  });
});
