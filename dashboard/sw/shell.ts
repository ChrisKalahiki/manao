/** One build of the app shell: its version and the paths to precache, as the Vite build emits them (shell-plugin.ts). */
export interface Shell {
  readonly version: string;
  readonly files: readonly string[];
}

/** The parts of CacheStorage the shell uses; the browser's `caches` fits it. */
export interface ShellCaches {
  open(name: string): Promise<{
    match(path: string): Promise<Response | undefined>;
    addAll(paths: string[]): Promise<void>;
  }>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export interface ShellWorkerEnv {
  caches: ShellCaches;
  fetch(request: Request): Promise<Response>;
  /** The worker's own origin; requests to any other go untouched. */
  origin: string;
}

export interface ShellWorker {
  install(): Promise<void>;
  activate(): Promise<void>;
  /** A response for a shell request, or undefined to leave the request to the network untouched. */
  respond(request: Request): Promise<Response> | undefined;
}

const CACHE_PREFIX = "manao-shell-";

function isApi(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function shellWorker(shell: Shell, env: ShellWorkerEnv): ShellWorker {
  const cacheName = CACHE_PREFIX + shell.version;

  return {
    async install() {
      const cache = await env.caches.open(cacheName);
      await cache.addAll([...shell.files]);
    },
    async activate() {
      const old = (await env.caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && name !== cacheName);
      await Promise.all(old.map((name) => env.caches.delete(name)));
    },
    respond(request) {
      if (request.method !== "GET") return undefined;
      const url = new URL(request.url);
      // Checked before the shell list so hub data can never come from a cache, whatever a build lists.
      if (url.origin !== env.origin || isApi(url.pathname) || !shell.files.includes(url.pathname)) return undefined;
      return env.caches
        .open(cacheName)
        .then((cache) => cache.match(url.pathname))
        .then((hit) => hit ?? env.fetch(request));
    },
  };
}
