/** Dev server: watch, rebuild the web output, serve dist/ with live reload.
 *
 * Each change re-runs the project's build in a fresh process (so edited
 * modules are always picked up) and pings every open browser tab over
 * server-sent events. The PDF is never built here — run the full build
 * for that.
 */

import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync, watch } from "node:fs";
import { createServer, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";

export interface DevConfig {
  /** Project root; dist/ inside it is served. */
  root: string;
  /** Directories (relative to root) whose changes trigger a rebuild. */
  watch: string[];
  /** Command that performs the web build, e.g. ["npx", "tsx", "tools/build.ts", "--no-pdf"]. */
  buildCommand: string[];
  port?: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

const RELOAD_SNIPPET = `<script>new EventSource("/__reload").onmessage = () => location.reload()</script>`;

export function runDev(cfg: DevConfig): void {
  const dist = join(cfg.root, "dist");
  const port = cfg.port ?? Number(process.env.PORT ?? 8787);
  const clients = new Set<ServerResponse>();
  let building = false;
  let queued = false;

  function build(reason: string): void {
    if (building) {
      queued = true;
      return;
    }
    building = true;
    const started = Date.now();
    const [cmd, ...args] = cfg.buildCommand;
    execFile(cmd, args, { cwd: cfg.root }, (err, stdout, stderr) => {
      building = false;
      if (err) {
        console.error(`[dev] build FAILED (${reason}):\n${stderr || stdout}`);
      } else {
        console.log(`[dev] rebuilt in ${Date.now() - started}ms (${reason})`);
        for (const res of clients) res.write("data: reload\n\n");
      }
      if (queued) {
        queued = false;
        build("queued change");
      }
    });
  }

  let timer: NodeJS.Timeout | undefined;
  const schedule = (what: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => build(what), 150);
  };

  for (const entry of cfg.watch) {
    const target = join(cfg.root, entry);
    if (!existsSync(target)) continue;
    const recursive = statSync(target).isDirectory();
    watch(target, { recursive }, (_event, file) => {
      if (!file || !file.includes("~")) schedule(`${entry}/${file ?? ""}`);
    });
  }

  createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/__reload") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    let path = normalize(join(dist, decodeURIComponent(url)));
    if (!path.startsWith(dist)) {
      res.writeHead(404).end("not found");
      return;
    }
    // directory-style chapter URLs: /slug/ -> /slug/index.html
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) {
      res.writeHead(404).end("not found");
      return;
    }
    const type = MIME[extname(path)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    if (type.startsWith("text/html")) {
      res.end(readFileSync(path, "utf-8").replace("</body>", `${RELOAD_SNIPPET}</body>`));
    } else {
      createReadStream(path).pipe(res);
    }
  }).listen(port, () => {
    console.log(`[dev] serving dist/ at http://localhost:${port}`);
    build("startup");
  });
}
