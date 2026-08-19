// @ts-ignore -- Bun test types are not loaded by tsconfig.node.json.
import { describe, expect, test } from "bun:test";
import { basename, dirname } from "node:path";
import {
  parseBranchList,
  parseWorktreeList,
  slugifyBranch,
  worktreeDirFor,
} from "./git-worktree";

describe("slugifyBranch", () => {
  test("replaces slashes with hyphens", () => {
    expect(slugifyBranch("feature/nested/change")).toBe(
      "feature-nested-change",
    );
  });

  test("strips unsafe characters and collapses hyphens", () => {
    expect(slugifyBranch("feature / a:b?--done")).toBe(
      "feature-ab-done",
    );
  });
});

describe("worktreeDirFor", () => {
  test("is stable for the same repository and branch", () => {
    const first = worktreeDirFor("/projects/repo", "feature/x");
    const second = worktreeDirFor("/projects/repo", "feature/x");
    expect(first).toBe(second);
    expect(basename(first)).toBe("feature-x");
  });

  test("separates repositories with the same basename", () => {
    const first = worktreeDirFor("/one/repo", "feature/x");
    const second = worktreeDirFor("/two/repo", "feature/x");
    expect(dirname(first)).not.toBe(dirname(second));
  });
});

describe("parseWorktreeList", () => {
  test("parses branch worktrees without changing branch names", () => {
    const fixture = [
      "worktree /repo",
      "HEAD a9ccdf57cbd010300cc9ae8c6077845604b9dabc",
      "branch refs/heads/master",
      "",
      "worktree /wt-feature-x",
      "HEAD a9ccdf57cbd010300cc9ae8c6077845604b9dabc",
      "branch refs/heads/feature/x",
      "",
    ].join("\n");

    expect(parseWorktreeList(fixture)).toEqual([
      { path: "/repo", branch: "master" },
      { path: "/wt-feature-x", branch: "feature/x" },
    ]);
  });

  test("emits null for a detached worktree", () => {
    const fixture = [
      "worktree /repo",
      "HEAD a9ccdf57cbd010300cc9ae8c6077845604b9dabc",
      "detached",
    ].join("\n");

    expect(parseWorktreeList(fixture)).toEqual([
      { path: "/repo", branch: null },
    ]);
  });

  test("returns an empty list for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("parseBranchList", () => {
  test("parses branch names and the checked-out marker", () => {
    const fixture = [
      "feature/x| ",
      "master|*",
      "other| ",
      "",
    ].join("\n");

    expect(parseBranchList(fixture)).toEqual([
      { name: "feature/x", isHead: false },
      { name: "master", isHead: true },
      { name: "other", isHead: false },
    ]);
  });

  test("does not trim the branch name", () => {
    expect(parseBranchList(" branch|*\n")).toEqual([
      { name: " branch", isHead: true },
    ]);
  });

  test("returns an empty list for empty input", () => {
    expect(parseBranchList("")).toEqual([]);
  });
});
