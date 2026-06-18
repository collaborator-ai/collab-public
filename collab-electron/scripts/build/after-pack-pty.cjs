// after-pack-pty.cjs – electron-builder afterPack hook (Windows only)
//
// On Windows the PTY sidecar process intentionally outlives the app so that
// terminal sessions persist across restarts.  This means conpty.node (and its
// siblings) in node_modules/node-pty/build/Release/ are locked by the OS and
// cannot be overwritten.  Instead of copying prebuilds *before* electron-builder
// (which touches the live node_modules), we do it here, where electron-builder
// has already staged the app to a separate output directory.

const { cpSync, existsSync } = require("node:fs");
const { join } = require("node:path");

/** electron-builder Arch enum → Node.js arch string */
const ARCH_MAP = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

exports.default = async function afterPackPty(context) {
  if (process.platform !== "win32") return;

  const arch = ARCH_MAP[context.arch];
  if (!arch) return;

  const tag = `win32-${arch}`;
  const projectRoot = context.packager.projectDir;
  const src = join(projectRoot, "node_modules", "node-pty", "prebuilds", tag);

  if (!existsSync(src)) {
    console.error(`No node-pty prebuilds for ${tag}`);
    process.exit(1);
  }

  const dst = join(
    context.appOutDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );

  if (!existsSync(dst)) {
    console.warn(`Expected unpacked path not found: ${dst} – skipping prebuild install`);
    return;
  }

  cpSync(src, dst, { recursive: true });
  console.log(`• node-pty prebuilds (${tag}) → staged app`);
};
