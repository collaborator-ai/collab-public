import { execSync } from "child_process";
import { defineConfig } from "electron-vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const outDir = "out";

const gitCommitSha = execSync("git rev-parse HEAD", {
  encoding: "utf8",
}).trim();

export default defineConfig({
  main: {
    define: {
      __GIT_COMMIT_SHA__: JSON.stringify(gitCommitSha),
    },
    resolve: {
      alias: {
        "@collab/shared": resolve(__dirname, "packages/shared/src"),
      },
    },
    build: {
      outDir: resolve(__dirname, outDir, "main"),
      rollupOptions: {
        external: ["node-pty", "@parcel/watcher", "typescript", "sharp"],
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "pty-sidecar": resolve(__dirname, "src/main/sidecar/entry.ts"),
          "watcher-worker": resolve(
            __dirname,
            "src/main/watcher-worker.ts",
          ),
          "git-replay-worker": resolve(
            __dirname,
            "src/main/git-replay-worker.ts",
          ),
          "image-worker": resolve(
            __dirname,
            "src/main/image-worker.ts",
          ),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(__dirname, outDir, "preload"),
      rollupOptions: {
        input: {
          universal: resolve(__dirname, "src/preload/universal.ts"),
          shell: resolve(__dirname, "src/preload/shell.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/windows"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@collab/shared": resolve(__dirname, "packages/shared/src"),
        "@collab/theme": resolve(__dirname, "packages/theme/src"),
        "@collab/components": resolve(
          __dirname,
          "packages/components/src",
        ),
      },
    },
    build: {
      outDir: resolve(__dirname, outDir, "renderer"),
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/windows/index.html"),
          nav: resolve(__dirname, "src/windows/nav/index.html"),
          viewer: resolve(__dirname, "src/windows/viewer/index.html"),
          terminal: resolve(__dirname, "src/windows/terminal/index.html"),
          settings: resolve(__dirname, "src/windows/settings/index.html"),
          shell: resolve(__dirname, "src/windows/shell/index.html"),
          "terminal-tile": resolve(
            __dirname,
            "src/windows/terminal-tile/index.html",
          ),
          "graph-tile": resolve(
            __dirname,
            "src/windows/graph-tile/index.html",
          ),
          "tile-list": resolve(__dirname, "src/windows/tile-list/index.html"),
          "agent-chat": resolve(
            __dirname,
            "src/windows/agent-chat/index.html",
          ),
        },
      },
    },
  },
});
