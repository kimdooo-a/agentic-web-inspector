#!/usr/bin/env node
// A small static server for local development.
//
//   node tools/serve.mjs [folder] [--port 8080] [--host 127.0.0.1] [--no-cors]
//
// It sends Access-Control-Allow-Origin: * on the public agent files only, as a static
// host would with the _headers file, and the sandbox CSP on runtime/sandbox-worker.js.
// --no-cors leaves the header out, to see how a site without it looks to callers.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".hocon": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const PUBLIC_AGENT_FILE = /(^|\/)(agent-manifest\.json|[^/]+\.network\.json|links\.json|agent-mcp\.json)$|^\/\.well-known\/[^/]+\.json$/;
const SANDBOX_CSP = "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'";

/** Parse --flag value pairs and the first positional folder. */
function parseArgs(argv) {
  const options = { root: ".", port: 8080, host: "127.0.0.1", cors: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      options.port = Number(argv[++i]);
    } else if (arg === "--host") {
      options.host = argv[++i];
    } else if (arg === "--no-cors") {
      options.cors = false;
    } else if (!arg.startsWith("--")) {
      options.root = arg;
    }
  }
  return options;
}

/** Start serving; resolves with the server once it listens. */
export function serve({ root = ".", port = 8080, host = "127.0.0.1", cors = true } = {}) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || host}`);
      let path = decodeURIComponent(url.pathname);
      const file = normalize(join(base, path));
      if (file !== base && !file.startsWith(base + sep)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      let target = file;
      const info = await stat(target).catch(() => null);
      if (info && info.isDirectory()) {
        target = join(target, "index.html");
        path = path.endsWith("/") ? `${path}index.html` : `${path}/index.html`;
      }
      const body = await readFile(target).catch(() => null);
      const headers = { "Cache-Control": "no-store" };
      if (cors && PUBLIC_AGENT_FILE.test(path)) {
        headers["Access-Control-Allow-Origin"] = "*";
      }
      if (body === null) {
        res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      if (path.endsWith("/runtime/sandbox-worker.js")) {
        headers["Content-Security-Policy"] = SANDBOX_CSP;
      }
      headers["Content-Type"] = TYPES[extname(target).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, headers).end(req.method === "HEAD" ? undefined : body);
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  return new Promise((done) => server.listen(port, host, () => done(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const server = await serve(options);
  const address = server.address();
  console.log(`Serving ${resolve(options.root)} at http://${options.host}:${address.port}/${options.cors ? "" : " (no CORS headers)"}`);
}
