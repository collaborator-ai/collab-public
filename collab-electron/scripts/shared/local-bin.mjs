import { readFileSync } from "node:fs";
import { join } from "node:path";

export function normalizeWindowsPath(path) {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

export function resolvePackageBin(cwd, packageName, binName = packageName) {
  const repoDir = normalizeWindowsPath(cwd);
  const packageJsonPath = join(repoDir, "node_modules", packageName, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const binField = packageJson.bin;
  const relativeBinPath = typeof binField === "string" ? binField : binField?.[binName];

  if (!relativeBinPath) {
    throw new Error(`Package ${packageName} does not declare bin ${binName}`);
  }

  return join(repoDir, "node_modules", packageName, relativeBinPath);
}
