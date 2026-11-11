import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store/store.js";
import { buildDist } from "./helpers.js";

/** `node dist/cli.js digest` as launchd starts it, against a temp config and store. */
describe("manao digest as a process", () => {
  let dir: string;
  let dbPath: string;
  let configPath: string;

  beforeAll(() => buildDist(), 60_000);
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-digest-cli-"));
    dbPath = path.join(dir, "hub.db");
    configPath = path.join(dir, "config.json");
    writeFileSync(configPath, "{}");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const digest = (...args: string[]) =>
    spawnSync(process.execPath, ["dist/cli.js", "digest", ...args], {
      env: { ...process.env, MANAO_DB: dbPath, MANAO_CONFIG: configPath },
      encoding: "utf8",
    });
  const withStore = () => {
    const store = openStore(dbPath);
    store.replaceItems("brain-dump:todos", "todo", [
      { source: "brain-dump:todos", type: "todo", id: "t1", title: "Send the draft", status: "open", attention: false, updatedAt: new Date().toISOString(), data: { groupPath: [], line: 1, parentId: null } },
    ]);
    store.close();
  };

  it("prints the digest when given neither --out nor --drive", () => {
    withStore();

    const run = digest();

    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^# Manaʻo daily: /);
    expect(run.stdout).toContain("\n- Send the draft\n");
  });

  it("writes the digest to --out and says where, printing nothing else", () => {
    withStore();
    const out = path.join(dir, "today.md");

    const run = digest("--out", out);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`manao digest: wrote ${out}\n`);
    expect(readFileSync(out, "utf8")).toContain("\n- Send the draft\n");
  });

  it("refuses --drive without google.client before writing anything", () => {
    withStore();
    const out = path.join(dir, "today.md");

    const run = digest("--drive", "--out", out);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`manao digest: --drive needs google.client in ${configPath}`);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses --out without a path", () => {
    const run = digest("--out");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("manao digest: --out needs a path.");
  });

  it("exits non-zero naming the store when there is none, so launchd's log says why", () => {
    const run = digest();

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`manao digest: no store at ${dbPath}`);
  });
});
