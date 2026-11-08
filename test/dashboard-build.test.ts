import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { shellVersion } from "../dashboard/shell-plugin.js";
import { type Hub, startHub } from "../src/hub/hub.js";

/** The `__SHELL__` literal the build writes into sw.js. */
function builtShell(swSource: string): { version: string; files: string[] } {
  const match = /\{"version":"[^"]+","files":\[[^\]]*\]\}/.exec(swSource);
  if (!match) throw new Error("sw.js carries no shell list");
  return JSON.parse(match[0]);
}

describe("Dashboard build: an installable PWA", () => {
  let outDir: string;
  let hub: Hub;
  let shell: { version: string; files: string[] };

  beforeAll(async () => {
    outDir = mkdtempSync(path.join(os.tmpdir(), "manao-dashboard-build-"));
    // As `bun run build` runs it: under vitest's NODE_ENV=test, Vite would build with import.meta.env.PROD false.
    vi.stubEnv("NODE_ENV", "production");
    await build({ configFile: path.resolve("dashboard/vite.config.ts"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
    vi.unstubAllEnvs();
    shell = builtShell(readFileSync(path.join(outDir, "sw.js"), "utf8"));
    const now = new Date("2026-10-19T08:00:00.000Z");
    hub = await startHub({ dbPath: ":memory:", adapters: [], eventRetentionDays: 30, api: { port: 0 }, dashboardDir: outDir, now: () => now, log: () => {} });
  }, 60_000);
  afterAll(async () => {
    await hub?.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it("emits the manifest, the icons and the service worker beside the page", () => {
    for (const file of ["index.html", "manifest.webmanifest", "sw.js", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) {
      expect(existsSync(path.join(outDir, file)), file).toBe(true);
    }
  });

  it("builds the service worker as one classic script, since it registers without type: module", () => {
    expect(readFileSync(path.join(outDir, "sw.js"), "utf8")).not.toMatch(/^\s*(import|export)\b|\bimport\s*\(/m);
  });

  it("lists the page and every built asset in the shell, and nothing from /api", () => {
    const assets = readdirSync(path.join(outDir, "assets")).map((name) => `/assets/${name}`);

    expect(shell.files).toEqual(expect.arrayContaining(["/", "/manifest.webmanifest", "/icon.svg", ...assets]));
    expect(shell.files).not.toContain("/sw.js");
    expect(shell.files.filter((file) => file.startsWith("/api"))).toEqual([]);
  });

  it("names installable icons in the manifest, each one a file the build emitted", () => {
    const manifest = JSON.parse(readFileSync(path.join(outDir, "manifest.webmanifest"), "utf8"));

    expect(manifest).toMatchObject({ name: "Manaʻo", short_name: "Manaʻo", display: "standalone", start_url: "/", scope: "/" });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ sizes: "512x512", type: "image/png", purpose: "any" }),
        expect.objectContaining({ sizes: "512x512", type: "image/png", purpose: "maskable" }),
      ]),
    );
    for (const icon of manifest.icons) expect(existsSync(path.join(outDir, icon.src)), icon.src).toBe(true);
  });

  it("links the manifest from a page with no inline script or style, so the CSP holds", () => {
    const page = readFileSync(path.join(outDir, "index.html"), "utf8");

    expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(page).not.toMatch(/<style|\sstyle=/);
  });

  it("registers the service worker at /sw.js from the built page script", () => {
    const scripts = readdirSync(path.join(outDir, "assets")).filter((name) => name.endsWith(".js"));

    expect(scripts.some((name) => readFileSync(path.join(outDir, "assets", name), "utf8").includes('"/sw.js"'))).toBe(true);
  });

  it.each([
    ["/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
    ["/sw.js", "text/javascript; charset=utf-8"],
    ["/icon.svg", "image/svg+xml"],
    ["/icon-512.png", "image/png"],
    ["/icon-maskable-512.png", "image/png"],
  ])("is served by the hub: %s as %s, revalidated on every load", async (file, type) => {
    const reply = await fetch(`${hub.apiUrl}${file}`);

    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toBe(type);
    expect(reply.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("Dashboard build: the shell version", () => {
  const files = [
    { name: "index.html", content: "<!doctype html>" },
    { name: "assets/index-B1x2c3d4.js", content: "console.log(1)" },
  ];

  it("stays the same for the same files in any order", () => {
    expect(shellVersion([...files].reverse())).toBe(shellVersion(files));
  });

  it.each([
    ["a file's content changes", [files[0], { ...files[1], content: "console.log(2)" }]],
    ["a file is renamed", [files[0], { ...files[1], name: "assets/index-Z9y8x7w6.js" }]],
    ["a file is added", [...files, { name: "icon.svg", content: "<svg/>" }]],
  ])("changes when %s", (_name, changed) => {
    expect(shellVersion(changed)).not.toBe(shellVersion(files));
  });
});
