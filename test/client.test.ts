import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HerdrClient,
  HerdrError,
  READ_ONLY_METHODS,
  ReadOnlyViolationError,
  resolveSocketPath,
} from "../src/herdr/client.js";
import { FakeHerdrCore, terminal } from "./helpers.js";

describe("resolveSocketPath", () => {
  const home = "/home/test";

  it("defaults to herdr-core's default core under ~/.local/state", () => {
    expect(resolveSocketPath({ homeDir: home, env: {} })).toBe(
      path.join(home, ".local", "state", "herdr-core", "default", "default.sock"),
    );
  });

  it("follows XDG_STATE_HOME", () => {
    expect(resolveSocketPath({ homeDir: home, env: { XDG_STATE_HOME: "/state" } })).toBe("/state/herdr-core/default/default.sock");
  });

  it("honours an explicit path above everything else", () => {
    expect(resolveSocketPath({ socketPath: "/x.sock", homeDir: home, env: { XDG_STATE_HOME: "/state" } })).toBe("/x.sock");
  });

  it("ignores HC_TERMINAL_SOCKET, which only herdr-core's own terminals carry", () => {
    expect(resolveSocketPath({ homeDir: home, env: { HC_TERMINAL_SOCKET: "/elsewhere.sock" } })).toBe(
      path.join(home, ".local", "state", "herdr-core", "default", "default.sock"),
    );
  });
});

describe("HerdrClient against a fake herdr-core", () => {
  let server: FakeHerdrCore;
  let client: HerdrClient;

  beforeEach(async () => {
    server = await new FakeHerdrCore().listen();
    client = new HerdrClient({ socketPath: server.socketPath, timeoutMs: 300 });
  });
  afterEach(async () => {
    await server.close();
  });

  it("says hello with its generation, then lists the terminals", async () => {
    server.terminals = [terminal({ address: "t1", status: "working" })];

    const terminals = await client.list();

    expect(server.methods).toEqual(["hello", "terminal.list"]);
    expect(terminals).toEqual([expect.objectContaining({ address: "t1", status: expect.objectContaining({ state: "working" }) })]);
  });

  it("strips command lines and the foreground process from what it returns", async () => {
    server.terminals = [terminal({ address: "t1" })];

    const [listed] = await client.list();

    expect(listed).not.toHaveProperty("argv");
    expect(listed).not.toHaveProperty("foreground");
    expect(JSON.stringify(listed)).not.toContain("secret");
  });

  it("names both generations when herdr-core speaks another one", async () => {
    server.generation = 2;

    const failure = client.list();

    await expect(failure).rejects.toBeInstanceOf(HerdrError);
    await expect(failure).rejects.toMatchObject({ kind: "unsupported_generation" });
    await expect(failure).rejects.toThrow(/generation 1.*generation 2/);
    expect(server.methods).toEqual(["hello"]);
  });

  it("surfaces herdr-core's error kind", async () => {
    await expect(client.request("terminal.get", { terminal: "t99" })).rejects.toMatchObject({
      name: "HerdrError",
      kind: "unknown_method",
    });
  });

  it("refuses a terminal list it cannot read", async () => {
    server.terminals = [{ address: 7 }];

    await expect(client.list()).rejects.toThrow(/terminal\.list is not in the shape manao reads/);
  });

  it("times out instead of hanging when the server never answers", async () => {
    server.mode = "silent";
    await expect(client.list()).rejects.toThrow(/timed out/);
  });

  it("gives a useful message when the socket does not exist", async () => {
    const lonely = new HerdrClient({ socketPath: path.join(server.stateHome, "missing.sock") });
    await expect(lonely.list()).rejects.toThrow(/herdr-core socket not reachable at .*missing\.sock \(ENOENT\).*hc server status/s);
  });

  it("refuses every method that is not a read before any bytes reach the server", async () => {
    const dangerous = [
      "terminal.read",
      "terminal.attach",
      "terminal.send",
      "terminal.keys",
      "terminal.interrupt",
      "terminal.kill",
      "terminal.run",
      "terminal.put",
      "terminal.label",
      "terminal.keep",
      "terminal.rm",
      "terminal.wait",
      "machine.exec",
      "machine.add",
      "file.read",
      "file.write",
      "file.edit",
      "doc.get",
      "doc.set",
      "server.stop",
      "server.restart",
      "templates.list",
      "rpc.discover",
    ];
    for (const method of dangerous) {
      await expect(client.request(method, {})).rejects.toBeInstanceOf(ReadOnlyViolationError);
    }
    expect(server.methods).toEqual([]);
  });

  it("allows exactly the reviewed read-only methods (CLAUDE.md hard rule 1)", () => {
    expect([...READ_ONLY_METHODS].sort()).toEqual(["events.subscribe", "hello", "server.status", "terminal.get", "terminal.list"]);
  });
});
