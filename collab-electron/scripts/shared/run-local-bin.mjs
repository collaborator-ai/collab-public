import { spawnSync } from "node:child_process";
import { normalizeWindowsPath, resolvePackageBin } from "./local-bin.mjs";

const [, , packageName, ...args] = process.argv;

if (!packageName) {
  console.error("Usage: node scripts/shared/run-local-bin.mjs <package-name> [args...]");
  process.exit(1);
}

const cwd = normalizeWindowsPath(process.cwd());
const binPath = resolvePackageBin(cwd, packageName);
const result = spawnSync(process.execPath, [binPath, ...args], {
  stdio: "inherit",
  cwd,
  env: process.env,
});

process.exit(result.status ?? 1);
