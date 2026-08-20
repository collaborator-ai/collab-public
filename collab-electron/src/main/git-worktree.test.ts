// @ts-ignore -- Bun test types are not loaded by tsconfig.node.json.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  parseBranchList,
  parseWorktreeList,
  resolveWorktree,
  slugifyBranch,
  worktreeDirFor,
} from "./git-worktree";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

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

describe("resolveWorktree", () => {
  let repoRoot = "";
  let headBranch = "";
  const createdPaths = new Set<string>();

  beforeAll(async () => {
    repoRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "git-worktree-")),
    );
    await runGit(repoRoot, ["init"]);
    await runGit(repoRoot, [
      "config",
      "user.email",
      "test@example.com",
    ]);
    await runGit(repoRoot, ["config", "user.name", "Test"]);
    await runGit(repoRoot, ["config", "commit.gpgSign", "false"]);
    await runGit(repoRoot, [
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ]);
    headBranch = await runGit(repoRoot, [
      "symbolic-ref",
      "--short",
      "HEAD",
    ]);
    for (const branch of [
      "feature/x",
      "other",
      "reuse",
      "stale",
      "existing",
    ]) {
      await runGit(repoRoot, ["branch", branch]);
    }
    await runGit(repoRoot, ["checkout", "other"]);
    await runGit(repoRoot, [
      "commit",
      "--allow-empty",
      "-m",
      "other",
    ]);
    await runGit(repoRoot, ["checkout", headBranch]);
  });

  afterAll(async () => {
    for (const path of createdPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    if (repoRoot && existsSync(repoRoot)) {
      await runGit(repoRoot, ["worktree", "prune"]);
    }
    for (const path of createdPaths) {
      rmSync(dirname(path), { recursive: true, force: true });
    }
    if (repoRoot) {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test("returns the main tree for its checked-out branch", async () => {
    const before = await runGit(repoRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const path = await resolveWorktree(repoRoot, headBranch, {
      create: false,
    });

    expect(path).toBe(repoRoot);
    expect(await runGit(repoRoot, [
      "worktree",
      "list",
      "--porcelain",
    ])).toBe(before);
  });

  test("creates a worktree for an existing branch", async () => {
    const branch = "feature/x";
    const path = await resolveWorktree(repoRoot, branch, {
      create: false,
    });
    createdPaths.add(path);

    expect(path).toBe(worktreeDirFor(repoRoot, branch));
    expect(existsSync(path)).toBe(true);
    expect(await runGit(path, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ])).toBe(branch);
  });

  test("reuses the same worktree path", async () => {
    const first = await resolveWorktree(repoRoot, "reuse", {
      create: false,
    });
    createdPaths.add(first);
    const before = await runGit(repoRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const second = await resolveWorktree(repoRoot, "reuse", {
      create: false,
    });

    expect(second).toBe(first);
    expect(await runGit(repoRoot, [
      "worktree",
      "list",
      "--porcelain",
    ])).toBe(before);
  });

  test("creates a new branch from an explicit base", async () => {
    const branch = "created/from-other";
    const path = await resolveWorktree(repoRoot, branch, {
      create: true,
      base: "other",
    });
    createdPaths.add(path);

    expect(await runGit(path, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ])).toBe(branch);
    expect(await runGit(path, ["rev-parse", "HEAD"])).toBe(
      await runGit(repoRoot, ["rev-parse", "other"]),
    );
  });

  test("creates a new branch from HEAD without a base", async () => {
    const branch = "created/from-head";
    const path = await resolveWorktree(repoRoot, branch, {
      create: true,
    });
    createdPaths.add(path);

    expect(await runGit(path, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ])).toBe(branch);
    expect(await runGit(path, ["rev-parse", "HEAD"])).toBe(
      await runGit(repoRoot, ["rev-parse", "HEAD"]),
    );
  });

  test("recreates a worktree whose directory was deleted", async () => {
    const branch = "stale";
    const first = await resolveWorktree(repoRoot, branch, {
      create: false,
    });
    createdPaths.add(first);
    rmSync(first, { recursive: true, force: true });
    expect(existsSync(first)).toBe(false);

    const second = await resolveWorktree(repoRoot, branch, {
      create: false,
    });

    expect(second).toBe(first);
    expect(existsSync(second)).toBe(true);
    expect(await runGit(second, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ])).toBe(branch);
  });

  test("rejects creating a branch that already exists", async () => {
    const path = worktreeDirFor(repoRoot, "existing");
    createdPaths.add(path);

    await expect(resolveWorktree(repoRoot, "existing", {
      create: true,
      base: headBranch,
    })).rejects.toThrow();
  });
});
