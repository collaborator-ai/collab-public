import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "out/renderer");
const port = Number(process.env.COLLAB_PREVIEW_PORT ?? process.argv[3] ?? 5173);
const host = process.env.COLLAB_PREVIEW_HOST ?? "127.0.0.1";

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url ?? "/", "http://localhost").pathname);
  const relative = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
  const requested = resolve(root, relative);
  if (requested !== root && !requested.startsWith(`${root}${sep}`)) {
    return null;
  }

  if (!existsSync(requested)) return null;
  const stats = statSync(requested);
  return stats.isDirectory() ? join(requested, "index.html") : requested;
}

const server = createServer((request, response) => {
  const filePath = resolveRequestPath(request.url);
  if (!filePath || !existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Collaborator preview serving ${root} at http://${host}:${port}/`);
});
