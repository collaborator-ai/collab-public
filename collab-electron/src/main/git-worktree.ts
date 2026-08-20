import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const WORKTREE_BASE = join(homedir(), ".collaborator", "worktrees");
const BRANCH_PREFIX = "refs/heads/";
const execFileAsync = promisify(execFile);

export interface BranchEntry {
  name: string;
  isHead: boolean;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

export function slugifyBranch(branch: string): string {
  return branch
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-+/g, "-");
}

export function worktreeDirFor(
  repoRoot: string,
  branch: string,
): string {
  const hash = createHash("sha256")
    .update(repoRoot)
    .digest("hex")
    .slice(0, 8);
  const repoName = basename(repoRoot);
  return join(
    WORKTREE_BASE,
    `${repoName}-${hash}`,
    slugifyBranch(branch),
  );
}

export function parseWorktreeList(
  porcelain: string,
): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | null = null;
  let branch: string | null = null;

  const finishEntry = () => {
    if (path !== null) entries.push({ path, branch });
    path = null;
    branch = null;
  };

  for (const line of porcelain.split(/\r?\n/)) {
    if (line === "") {
      finishEntry();
    } else if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      branch = ref.startsWith(BRANCH_PREFIX)
        ? ref.slice(BRANCH_PREFIX.length)
        : ref;
    }
  }
  finishEntry();

  return entries;
}

export function parseBranchList(raw: string): BranchEntry[] {
  const entries: BranchEntry[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const separator = line.lastIndexOf("|");
    if (separator === -1) continue;
    entries.push({
      name: line.slice(0, separator),
      isHead: line.slice(separator + 1) === "*",
    });
  }

  return entries;
}

async function git(args: string[], repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

export async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return null;
  }
}

export async function listBranches(
  repoRoot: string,
): Promise<BranchEntry[]> {
  const stdout = await git(
    [
      "for-each-ref",
      "--format=%(refname:short)|%(HEAD)",
      "refs/heads",
    ],
    repoRoot,
  );
  return parseBranchList(stdout);
}

export async function listWorktrees(
  repoRoot: string,
): Promise<WorktreeEntry[]> {
  const stdout = await git(
    ["worktree", "list", "--porcelain"],
    repoRoot,
  );
  return parseWorktreeList(stdout);
}

export async function resolveWorktree(
  repoRoot: string,
  branch: string,
  opts: { create: boolean; base?: string | undefined },
): Promise<string> {
  const existing = (await listWorktrees(repoRoot)).find(
    (entry) => entry.branch === branch,
  );
  if (existing && existsSync(existing.path)) return existing.path;
  if (existing) {
    // Git still lists a worktree whose directory was removed by hand.
    // Prune the stale record so the add below can succeed.
    await git(["worktree", "prune"], repoRoot);
  }

  const path = worktreeDirFor(repoRoot, branch);
  if (opts.create) {
    const args = ["worktree", "add", "-b", branch, path];
    if (opts.base !== undefined) args.push(opts.base);
    await git(args, repoRoot);
  } else {
    await git(["worktree", "add", path, branch], repoRoot);
  }

  return path;
}
