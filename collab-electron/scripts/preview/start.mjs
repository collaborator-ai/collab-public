import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const label = "collab.renderer.preview";
const repoDir = process.cwd();
const port = process.env.COLLAB_PREVIEW_PORT ?? "5173";
const host = process.env.COLLAB_PREVIEW_HOST ?? "127.0.0.1";
const outDir = join(repoDir, "out", "renderer");
const serverScript = fileURLToPath(new URL("./static-server.mjs", import.meta.url));
const logPath = join(repoDir, ".collab", "preview.log");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoDir,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0 && options.check !== false) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.status ?? 1);
  }
  return result;
}

if (!existsSync(join(outDir, "index.html"))) {
  console.error("Missing out/renderer/index.html. Run `bun run build` before starting the preview.");
  process.exit(1);
}

await mkdir(dirname(logPath), { recursive: true });
await writeFile(logPath, "", { flag: "a" });

if (process.platform === "darwin") {
  run("launchctl", ["remove", label], { check: false });
  const shellCommand = [
    `cd ${JSON.stringify(repoDir)}`,
    `COLLAB_PREVIEW_HOST=${JSON.stringify(host)} COLLAB_PREVIEW_PORT=${JSON.stringify(port)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)} ${JSON.stringify(outDir)} ${port} >> ${JSON.stringify(logPath)} 2>&1`,
  ].join(" && ");
  run("launchctl", ["submit", "-l", label, "--", "/bin/zsh", "-lc", shellCommand]);
} else {
  const child = spawn(process.execPath, [serverScript, outDir, port], {
    cwd: repoDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COLLAB_PREVIEW_HOST: host,
      COLLAB_PREVIEW_PORT: port,
    },
  });
  child.unref();
  if (child.error) {
    console.error(child.error.message);
    process.exit(1);
  }
}

console.log(`Preview running at http://${host}:${port}/`);
console.log(`Stop it with: bun run preview:stop`);
