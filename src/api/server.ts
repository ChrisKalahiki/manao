import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Store } from "../store/store.js";
import { ParamError } from "../query/params.js";
import { type Dashboard, openDashboard, SECURITY_HEADERS } from "./dashboard.js";
import { ROUTES, type Route } from "./routes.js";

export interface ApiOptions {
  store: Store;
  /** 0 picks a free port. */
  port: number;
  /** The hub's clock; every response carries it as `now`. */
  now: () => Date;
  /** The built dashboard, served at every path outside /api. */
  dashboardDir: string;
  log: (line: string) => void;
}

/** The read-only HTTP API, listening on 127.0.0.1. */
export interface Api {
  /** Where it listens, e.g. `http://127.0.0.1:7420`. */
  readonly url: string;
  /** Stops listening and drops open connections. */
  close(): Promise<void>;
}

interface Reply {
  status: number;
  /** JSON, or a dashboard file's bytes. */
  body: ({ now: string } & ReturnType<Route>) | { error: string } | Buffer;
  headers?: http.OutgoingHttpHeaders;
}

const HOST = "127.0.0.1";
/** What `tailscale serve` may pass through as the Host. */
const TAILNET_HOST = /^([a-z0-9-]+\.)+ts\.net(:\d+)?$/;

/** Starts listening on `port`; fails naming the port if it cannot. */
export async function startApi(opts: ApiOptions): Promise<Api> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(new Error(`manao: cannot start the API on ${HOST}:${opts.port} (${err.code ?? err.message})`, { cause: err })),
    );
    server.listen(opts.port, HOST, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const allowedHosts = new Set([`localhost:${port}`, `${HOST}:${port}`]);
  const dashboard = openDashboard(opts.dashboardDir);
  if (!dashboard.built) opts.log(`manao: no dashboard in ${opts.dashboardDir}; run \`bun run build\` to serve it`);

  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    let reply: Reply;
    try {
      reply = answer(req, allowedHosts, dashboard, opts);
    } catch (err) {
      opts.log(`manao: API error on ${req.method} ${req.url}: ${err instanceof Error ? err.stack : String(err)}`);
      reply = { status: 500, body: { error: "Internal error" } };
    }
    if (Buffer.isBuffer(reply.body)) {
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
      return;
    }
    res.writeHead(reply.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...reply.headers,
    });
    res.end(JSON.stringify(reply.body));
  });

  return {
    url: `http://${HOST}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * The guards every endpoint and dashboard file shares, in order: Host (403),
 * method (405), path (404), parameters (400).
 */
function answer(
  req: http.IncomingMessage,
  allowedHosts: ReadonlySet<string>,
  dashboard: Dashboard,
  opts: ApiOptions,
): Reply {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  const refusalHeaders = isApi ? {} : SECURITY_HEADERS;
  const host = req.headers.host?.toLowerCase();
  if (host === undefined || !(allowedHosts.has(host) || TAILNET_HOST.test(host))) {
    const error = `Host ${req.headers.host ?? "(none)"} is not allowed`;
    return { status: 403, body: { error }, headers: refusalHeaders };
  }
  if (req.method !== "GET") {
    const error = `${req.method} is not allowed; the API is read-only`;
    return { status: 405, body: { error }, headers: { allow: "GET", ...refusalHeaders } };
  }
  if (!isApi) return dashboard.serve((req.url ?? "/").split("?")[0] ?? "/");
  const route = ROUTES.get(url.pathname);
  if (!route) return { status: 404, body: { error: `No such path: ${url.pathname}` } };
  const now = opts.now();
  try {
    return { status: 200, body: { now: now.toISOString(), ...route(url.searchParams, opts.store, now) } };
  } catch (err) {
    if (err instanceof ParamError) return { status: 400, body: { error: err.message } };
    throw err;
  }
}
