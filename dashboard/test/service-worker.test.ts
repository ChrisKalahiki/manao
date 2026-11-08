import { describe, expect, it, vi } from "vitest";
import { type Shell, type ShellCaches, shellWorker } from "../sw/shell.js";

const ORIGIN = "https://hub.example.ts.net";

const SHELL: Shell = { version: "a1b2c3", files: ["/", "/assets/index-B1x2c3d4.js", "/assets/index-D5e6f7g8.css", "/manifest.webmanifest"] };

/** CacheStorage as the browser keeps it, recording every touch so a test can prove nothing was read or written. */
function fakeCaches(initial: Record<string, Record<string, string>> = {}) {
  const stores = new Map(Object.entries(initial).map(([name, files]) => [name, new Map(Object.entries(files))]));
  const touched: string[] = [];
  const caches: ShellCaches = {
    async open(name) {
      touched.push(`open ${name}`);
      const store = stores.get(name) ?? new Map<string, string>();
      stores.set(name, store);
      return {
        async match(path) {
          touched.push(`match ${path}`);
          const body = store.get(path);
          return body === undefined ? undefined : new Response(body);
        },
        async addAll(paths) {
          touched.push(`addAll ${paths.join(",")}`);
          for (const p of paths) store.set(p, `network ${p}`);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      touched.push(`delete ${name}`);
      return stores.delete(name);
    },
  };
  return { caches, stores, touched };
}

const network = () => vi.fn(async (request: Request) => new Response(`network ${new URL(request.url).pathname}`));

describe("Service worker: the shell cache", () => {
  it.each(["/api/items", "/api/sources", "/api/events?after=3", "/api"])("never answers or caches %s, even when the shell lists it", async (path) => {
    const { caches, touched } = fakeCaches({ "manao-shell-a1b2c3": { [path]: "cached data" } });
    const worker = shellWorker({ ...SHELL, files: [...SHELL.files, path] }, { caches, fetch: network(), origin: ORIGIN });

    expect(worker.respond(new Request(`${ORIGIN}${path}`))).toBeUndefined();
    expect(touched).toEqual([]);
  });

  it("serves a shell file from the cache before the network", async () => {
    const { caches } = fakeCaches({ "manao-shell-a1b2c3": { "/": "cached page" } });
    const fetch = network();
    const worker = shellWorker(SHELL, { caches, fetch, origin: ORIGIN });

    const response = await worker.respond(new Request(`${ORIGIN}/?from=homescreen`));

    expect(await response?.text()).toBe("cached page");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the network for a shell file missing from the cache, without caching it", async () => {
    const { caches, touched } = fakeCaches({ "manao-shell-a1b2c3": {} });
    const worker = shellWorker(SHELL, { caches, fetch: network(), origin: ORIGIN });

    const response = await worker.respond(new Request(`${ORIGIN}/manifest.webmanifest`));

    expect(await response?.text()).toBe("network /manifest.webmanifest");
    expect(touched.some((t) => t.startsWith("addAll"))).toBe(false);
  });

  it.each([
    ["a path outside the shell", new Request(`${ORIGIN}/icon-512.png`)],
    ["another origin", new Request("https://elsewhere.example.com/")],
    ["a non-GET request", new Request(`${ORIGIN}/`, { method: "POST" })],
  ])("leaves %s to the network", (_name, request) => {
    const { caches, touched } = fakeCaches();
    const worker = shellWorker(SHELL, { caches, fetch: network(), origin: ORIGIN });

    expect(worker.respond(request)).toBeUndefined();
    expect(touched).toEqual([]);
  });

  it("precaches every shell file under a cache named for this build", async () => {
    const { caches, stores } = fakeCaches();

    await shellWorker(SHELL, { caches, fetch: network(), origin: ORIGIN }).install();

    expect([...(stores.get("manao-shell-a1b2c3")?.keys() ?? [])]).toEqual(SHELL.files);
  });

  it("removes older shells on activate and leaves caches it does not own", async () => {
    const { caches, stores } = fakeCaches({ "manao-shell-old999": {}, "manao-shell-a1b2c3": {}, "someone-else": {} });

    await shellWorker(SHELL, { caches, fetch: network(), origin: ORIGIN }).activate();

    expect([...stores.keys()].sort()).toEqual(["manao-shell-a1b2c3", "someone-else"]);
  });
});
