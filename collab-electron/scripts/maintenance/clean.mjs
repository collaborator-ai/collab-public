import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = new Set(process.argv.slice(2));
const deep = args.has("--deep");
const cwd = process.cwd();

const targets = [
  join(cwd, "out"),
  join(cwd, "dist"),
  join(cwd, "build-debug.log"),
];

if (deep) {
  targets.push(join(cwd, "node_modules"));
}

for (const target of targets) {
  if (!existsSync(target)) continue;
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}
