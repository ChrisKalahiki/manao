import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Hub, startHub } from "../src/hub/hub.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** A real HTTP request sending `rawPath` exactly as given, so traversal attempts reach the server unnormalized. */
function request(apiUrl: string, rawPath: string, opts: { method?: string; host?: string } = {}): Promise<Reply> {
  const { hostname, port } = new URL(apiUrl);
  return new Promise((resolve, reject) => {
    const headers = opts.host ? { host: opts.host } : {};
    const req = http.request({ hostname, port, path: rawPath, method: opts.method ?? "GET", headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

const PAGE = "<!doctype html><title>Manaʻo</title>";

/** A built dashboard as Vite would emit it, next to a file that must never be served and links out to it. */
function fixtureDashboard(root: string): string {
  writeFileSync(path.join(root, "secret.json"), '{"token":"do-not-serve"}');
  const dir = path.join(root, "dashboard");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), PAGE);
  writeFileSync(path.join(dir, "assets", "index-B1x2c3d4.js"), "console.log('hi')");
  writeFileSync(path.join(dir, "assets", "index-D5e6f7g8.css"), "body{}");
  writeFileSync(path.join(dir, "manifest.webmanifest"), '{"name":"Manaʻo"}');
  writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {})");
  writeFileSync(path.join(dir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(path.join(dir, "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(dir, "favicon.ico"), Buffer.from([0, 0, 1, 0]));
  writeFileSync(path.join(dir, "notes.txt"), "not a dashboard file");
  symlinkSync(path.join(root, "secret.json"), path.join(dir, "linked.json"));
  symlinkSync(path.join(dir, "manifest.webmanifest"), path.join(dir, "inside.webmanifest"));
  symlinkSync(root, path.join(dir, "outside"));
  return dir;
}

const now = new Date("2026-10-19T08:00:00.000Z");

describe("Dashboard: serving the built files", () => {
  let root: string;
  let hub: Hub;
  const get = (rawPath: string, opts?: { method?: string; host?: string }) => request(`${hub.apiUrl}`, rawPath, opts);

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "manao-dashboard-"));
    const dashboardDir = fixtureDashboard(root);
    hub = await startHub({ dbPath: ":memory:", adapters: [], eventRetentionDays: 30, api: { port: 0 }, dashboardDir, now: () => now, log: () => {} });
  });
  afterEach(async () => {
    await hub.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the page at /, never cached without revalidating", async () => {
    const reply = await get("/");

    expect(reply).toMatchObject({ status: 200, text: PAGE });
    expect(reply.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("no-cache");
  });

  it.each([
    ["/assets/index-B1x2c3d4.js", "text/javascript; charset=utf-8", "public, max-age=31536000, immutable"],
    ["/assets/index-D5e6f7g8.css", "text/css; charset=utf-8", "public, max-age=31536000, immutable"],
    ["/manifest.webmanifest", "application/manifest+json; charset=utf-8", "no-cache"],
    ["/sw.js", "text/javascript; charset=utf-8", "no-cache"],
    ["/icon.svg", "image/svg+xml", "no-cache"],
    ["/icon-192.png", "image/png", "no-cache"],
    ["/favicon.ico", "image/x-icon", "no-cache"],
  ])("serves %s as %s with cache-control %s", async (file, type, cache) => {
    const reply = await get(file);

    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe(type);
    expect(reply.headers["cache-control"]).toBe(cache);
  });

  it.each(["/", "/assets/index-B1x2c3d4.js", "/nothing"])("sends the security headers on %s", async (file) => {
    const reply = await get(file);

    expect(reply.headers).toMatchObject({
      "content-security-policy": expect.stringContaining("default-src 'self'"),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    expect(reply.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it.each([
    ["an unknown path", "/nothing"],
    ["a path with no file", "/assets/"],
    ["a file of a type it does not serve", "/notes.txt"],
    ["a dot segment out of the folder", "/../secret.json"],
    ["a nested dot segment out of the folder", "/assets/../../secret.json"],
    ["an encoded dot segment", "/%2e%2e/secret.json"],
    ["an upper-case encoded dot segment", "/%2E%2E/secret.json"],
    ["an encoded slash", "/..%2fsecret.json"],
    ["an encoded slash inside the folder", "/assets%2Findex-B1x2c3d4.js"],
    ["an encoded backslash", "/..%5csecret.json"],
    ["a backslash", "/..\\secret.json"],
    ["a symlink to a file outside the folder", "/linked.json"],
    ["a symlink to a file inside the folder", "/inside.webmanifest"],
    ["a file under a symlinked folder", "/outside/secret.json"],
  ])("refuses %s (%s) with 404 and { error }", async (_name, rawPath) => {
    const reply = await get(rawPath);

    expect(reply.status).toBe(404);
    expect(reply.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(reply.text)).toEqual({ error: expect.any(String) });
    expect(reply.text).not.toContain("do-not-serve");
  });

  it("refuses a dashboard path addressed to another Host with 403", async () => {
    const reply = await get("/", { host: "evil.example.com" });

    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.text)).toEqual({ error: expect.any(String) });
  });

  it.each([
    ["403", "/", { host: "evil.example.com" }],
    ["405", "/", { method: "POST" }],
  ])("sends the security headers on a dashboard %s", async (_status, rawPath, opts) => {
    const reply = await get(rawPath, opts);

    expect(reply.headers).toMatchObject({
      "content-security-policy": expect.stringContaining("default-src 'self'"),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
  });

  it("leaves the security headers off /api refusals", async () => {
    const reply = await get("/api/sources", { method: "POST" });

    expect(reply.status).toBe(405);
    expect(reply.headers["content-security-policy"]).toBeUndefined();
  });

  it("answers a dashboard path addressed to a tailnet name", async () => {
    const reply = await get("/", { host: "mac-mini.tail1234.ts.net" });

    expect(reply).toMatchObject({ status: 200, text: PAGE });
  });

  it.each(["POST", "PUT", "DELETE"])("refuses %s on a dashboard path with 405", async (method) => {
    const reply = await get("/", { method });

    expect(reply).toMatchObject({ status: 405, headers: { allow: "GET" } });
    expect(JSON.parse(reply.text)).toEqual({ error: expect.stringContaining(method) });
  });

  it("leaves /api as it was: JSON, no-store, the hub's clock", async () => {
    const reply = await get("/api/sources");

    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(reply.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(reply.text)).toEqual({ now: now.toISOString(), sources: [] });
  });

  it("answers an unknown /api path as the API does, not as a dashboard file", async () => {
    const reply = await get("/api/index.html");

    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.text)).toEqual({ error: "No such path: /api/index.html" });
  });
});

describe("Dashboard: not built", () => {
  let root: string;
  let hub: Hub;
  let logged: string[];

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "manao-dashboard-"));
    logged = [];
    hub = await startHub({
      dbPath: ":memory:",
      adapters: [],
      eventRetentionDays: 30,
      api: { port: 0 },
      dashboardDir: path.join(root, "missing"),
      now: () => now,
      log: (line) => logged.push(line),
    });
  });
  afterEach(async () => {
    await hub.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("answers / with a 404 that says to run bun run build, logged once at startup", async () => {
    const first = await request(`${hub.apiUrl}`, "/");
    await request(`${hub.apiUrl}`, "/");

    expect(first.status).toBe(404);
    expect(JSON.parse(first.text)).toEqual({ error: expect.stringContaining("bun run build") });
    expect(logged.filter((line) => line.includes("bun run build"))).toHaveLength(1);
  });

  it("keeps the API answering", async () => {
    const reply = await request(`${hub.apiUrl}`, "/api/sources");

    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual({ now: now.toISOString(), sources: [] });
  });
});
