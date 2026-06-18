import { spawnSync } from "node:child_process";

const label = "collab.renderer.preview";

if (process.platform === "darwin") {
  const result = spawnSync("launchctl", ["remove", label], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.log("Preview was not running.");
    process.exit(0);
  }
  console.log("Preview stopped.");
  process.exit(0);
}

console.log("Stop the preview process that is serving COLLAB_PREVIEW_PORT, or close the terminal that started it.");
