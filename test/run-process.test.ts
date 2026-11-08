import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store/store.js";
import { buildDist, waitFor } from "./helpers.js";

interface Exit {
  code: number | null;
  stderr: string;
}

/** `node dist/cli.js run` as launchd starts it, against a temp config and store. */
class RunProcess {
  private stdout = "";
  private stderr = "";
  private readonly child: ChildProcess;
  private readonly closed: Promise<Exit>;

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, ["dist/cli.js", "run"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stdout += chunk;
    });
    this.child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.closed = new Promise((resolve, reject) => {
      this.child.on("error", reject);
      this.child.on("close", (code) => resolve({ code, stderr: this.stderr }));
    });
  }

  async startupLine(): Promise<string> {
    const find = () => this.stdout.split("\n").find((l) => l.startsWith("manao: hub running"));
    await waitFor(() => find() !== undefined, 10_000, 20).catch(() => undefined);
    const line = find();
    if (!line) throw new Error(`no startup line; stderr: ${this.stderr}`);
    return line;
  }

  exited(): Promise<Exit> {
    return this.closed;
  }

  terminate(): Promise<Exit> {
    this.child.kill("SIGTERM");
    return this.closed;
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }
}

describe("manao run as a process (the contract launchd relies on)", () => {
  let dir: string;
  let started: RunProcess | undefined;
  let blocker: net.Server | undefined;

  const dbPath = () => path.join(dir, "hub.db");
  const configPath = () => path.join(dir, "config.json");
  const start = (config: object, env: Record<string, string> = {}) => {
    writeFileSync(configPath(), JSON.stringify(config));
    started = new RunProcess({ MANAO_DB: dbPath(), MANAO_CONFIG: configPath(), ...env });
    return started;
  };

  beforeAll(() => {
    buildDist();
  }, 60_000);
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-run-"));
  });
  afterEach(() => {
    started?.kill();
    blocker?.close();
    started = undefined;
    blocker = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints its startup line, exits 0 on SIGTERM and leaves a store that opens cleanly", async () => {
    const hub = start({ api: { port: 0 }, sources: {} });

    expect(await hub.startupLine()).toContain(`store at ${dbPath()}`);
    expect((await hub.terminate()).code).toBe(0);

    const store = openStore(dbPath(), { readOnly: true });
    expect(store.items.list({})).toEqual([]);
    store.close();
  });

  it("exits non-zero naming the field when the config is invalid", async () => {
    const exit = await start({ eventRetentionDays: 0 }).exited();

    expect(exit.code).not.toBe(0);
    expect(exit.stderr).toContain("eventRetentionDays");
  });

  it("shows paths under the home directory as ~/ on stdout and stderr", async () => {
    const hub = start({ api: false, sources: {} }, { HOME: dir });
    expect(await hub.startupLine()).toBe("manao: hub running, config at ~/config.json, store at ~/hub.db");
    await hub.terminate();

    const exit = await start({ eventRetentionDays: 0 }, { HOME: dir }).exited();
    expect(exit.stderr).toContain("Invalid config ~/config.json: ");
  });

  it("exits non-zero naming the port when another listener holds it", async () => {
    blocker = net.createServer();
    await new Promise<void>((resolve) => blocker?.listen(0, "127.0.0.1", resolve));
    const { port } = blocker.address() as net.AddressInfo;

    const exit = await start({ api: { port }, sources: {} }).exited();

    expect(exit.code).not.toBe(0);
    expect(exit.stderr).toContain(String(port));
  });
});
