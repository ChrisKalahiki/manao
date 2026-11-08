import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** A dashboard file's bytes, or a 404 the server sends as JSON. */
export interface DashboardReply {
  status: 200 | 404;
  body: Buffer | { error: string };
  headers: Record<string, string>;
}

/** The built dashboard: static files served from one folder and nothing outside it. */
export interface Dashboard {
  /** Whether the folder holds a built page. */
  readonly built: boolean;
  /** Answers a GET for `rawPath` (the request target before any decoding, without its query). */
  serve(rawPath: string): DashboardReply;
}

const NOT_BUILT = "The dashboard is not built; run `bun run build`";

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Sent on every dashboard reply, refusals included. */
export const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** Vite writes content-hashed files here; every other file keeps its name across builds. */
const HASHED_PREFIX = "/assets/";

/**
 * Our own build never emits a name that needs escaping, so any escape, backslash
 * or dot-led segment is refused before the path touches the file system.
 */
function isPlainPath(rawPath: string): boolean {
  if (rawPath.includes("%") || rawPath.includes("\\")) return false;
  return rawPath.split("/").every((segment) => !segment.startsWith("."));
}

/**
 * A regular file, not a link, whose real path sits inside the folder's real path:
 * a link, or a file under a linked folder, could reach anywhere on disk.
 */
function isServable(file: string, root: string): boolean {
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return false;
  return realpathSync(file).startsWith(realpathSync(root) + path.sep);
}

export function openDashboard(dir: string): Dashboard {
  const root = path.resolve(dir);
  const notFound = (error: string): DashboardReply => ({ status: 404, body: { error }, headers: SECURITY_HEADERS });

  return {
    get built() {
      return existsSync(path.join(root, "index.html"));
    },
    serve(rawPath) {
      if (rawPath === "/" && !this.built) return notFound(NOT_BUILT);
      const noSuchPath = notFound(`No such path: ${rawPath}`);
      if (!isPlainPath(rawPath)) return noSuchPath;
      const file = path.join(root, rawPath === "/" ? "index.html" : rawPath);
      const type = CONTENT_TYPES.get(path.extname(file));
      if (!type || !isServable(file, root)) return noSuchPath;
      const cache = rawPath.startsWith(HASHED_PREFIX) ? "public, max-age=31536000, immutable" : "no-cache";
      return {
        status: 200,
        body: readFileSync(file),
        headers: { ...SECURITY_HEADERS, "content-type": type, "cache-control": cache },
      };
    },
  };
}
