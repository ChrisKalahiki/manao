import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEMPLATE = fileURLToPath(new URL("../launchd/dev.manao.hub.plist", import.meta.url));
const FILLED_IN = { __NODE__: "/opt/node/bin/node", __NODE_DIR__: "/opt/node/bin", __REPO__: "/srv/manao", __HOME__: "/srv/home" };

type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

/** Just enough of the XML plist format for a LaunchAgent: dict, array, string, key, true, false. */
function parsePlist(xml: string): PlistValue {
  const tokens = [...xml.matchAll(/<(?<closing>\/?)(?<tag>\w+)(?<selfClosed>\/?)>(?<text>[^<]*)/g)].map((m) => ({
    closing: m.groups?.closing === "/",
    tag: m.groups?.tag ?? "",
    selfClosed: m.groups?.selfClosed === "/",
    text: m.groups?.text ?? "",
  }));
  let at = 0;
  const value = (): PlistValue => {
    const { tag, selfClosed, text } = tokens[at++];
    if (selfClosed) return tag === "true";
    if (tag === "string") {
      at++;
      return text;
    }
    const items: PlistValue[] = [];
    while (!tokens[at].closing) {
      if (tokens[at].tag === "key") {
        items.push(tokens[at++].text);
        at++;
      }
      items.push(value());
    }
    at++;
    if (tag === "array") return items;
    const dict: { [key: string]: PlistValue } = {};
    for (let i = 0; i < items.length; i += 2) dict[asString(items[i])] = items[i + 1];
    return dict;
  };
  while (tokens[at].tag !== "dict") at++;
  return value();
}

function asString(v: PlistValue | undefined): string {
  if (typeof v !== "string") throw new Error(`expected a plist string, got ${JSON.stringify(v)}`);
  return v;
}

function asDict(v: PlistValue | undefined): { [key: string]: PlistValue } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`expected a plist dict, got ${JSON.stringify(v)}`);
  return v;
}

function leaksUsername(text: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/(Users|home)/${escaped}(/|$)`).test(text);
}

function fillIn(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((text, [placeholder, value]) => text.replaceAll(placeholder, value), template);
}

describe("the LaunchAgent template", () => {
  const template = readFileSync(TEMPLATE, "utf8");
  const plist = asDict(parsePlist(fillIn(template, FILLED_IN)));

  it("has the label the README commands use", () => {
    expect(plist.Label).toBe("dev.manao.hub");
  });

  it("starts at load and restarts only after a failed exit, so a deliberate stop stays stopped", () => {
    expect(plist.RunAtLoad).toBe(true);
    expect(plist.KeepAlive).toEqual({ SuccessfulExit: false });
  });

  it("runs node on the built CLI with run, from the checkout", () => {
    expect(plist.ProgramArguments).toEqual(["/opt/node/bin/node", "/srv/manao/dist/cli.js", "run"]);
    expect(plist.WorkingDirectory).toBe("/srv/manao");
  });

  it("writes output and errors to separate files under the logs folder", () => {
    expect(plist.StandardOutPath).toMatch(/^\/srv\/home\/Library\/Logs\/manao\/[^/]+\.log$/);
    expect(plist.StandardErrorPath).toMatch(/^\/srv\/home\/Library\/Logs\/manao\/[^/]+\.log$/);
    expect(plist.StandardErrorPath).not.toBe(plist.StandardOutPath);
  });

  it("finds node, bun and brain-dump on PATH", () => {
    const dirs = asString(asDict(plist.EnvironmentVariables).PATH).split(":");
    expect(dirs).toEqual(["/opt/node/bin", "/srv/home/.bun/bin", "/srv/home/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  });

  it("sets no config or store override, so the normal lookup applies", () => {
    expect(Object.keys(asDict(plist.EnvironmentVariables))).toEqual(["PATH"]);
  });

  it("holds no username or home path once its placeholders are taken out", () => {
    const bare = fillIn(template, { __NODE__: "", __NODE_DIR__: "", __REPO__: "", __HOME__: "" });
    expect(bare).not.toMatch(/\/(Users|home)\//);
    expect(leaksUsername(bare, os.userInfo().username)).toBe(false);
  });

  it("flags a username only as a path segment, so short names in the label or keys pass", () => {
    const bare = fillIn(template, { __NODE__: "", __NODE_DIR__: "", __REPO__: "", __HOME__: "" });
    expect(leaksUsername(bare, "dev")).toBe(false);
    expect(leaksUsername(bare, "hub")).toBe(false);
    expect(leaksUsername(bare, "manao")).toBe(false);
    expect(leaksUsername("/Users/dev/Library", "dev")).toBe(true);
    expect(leaksUsername("/home/dev", "dev")).toBe(true);
  });

  it.runIf(process.platform === "darwin")("passes plutil -lint once filled in", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "manao-plist-"));
    try {
      const file = path.join(dir, "dev.manao.hub.plist");
      writeFileSync(file, fillIn(template, FILLED_IN));
      expect(execFileSync("plutil", ["-lint", file], { encoding: "utf8" })).toContain("OK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
