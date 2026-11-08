import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrAdapter } from "../src/herdr/adapter.js";
import { HerdrClient, READ_ONLY_METHODS } from "../src/herdr/client.js";
import { FakeHerdrCore, MemorySink, terminal } from "./helpers.js";

describe("HerdrAdapter", () => {
  let server: FakeHerdrCore;
  let sink: MemorySink;
  let adapter: HerdrAdapter;

  const make = (opts: ConstructorParameters<typeof HerdrAdapter>[0] = {}) =>
    new HerdrAdapter({
      client: new HerdrClient({ socketPath: server.socketPath, timeoutMs: 500 }),
      intervalMs: 60_000, // polling is not what these tests exercise
      eventBackoffMs: 20,
      events: false,
      ...opts,
    });

  beforeEach(async () => {
    server = await new FakeHerdrCore().listen();
    sink = new MemorySink();
  });
  afterEach(async () => {
    await adapter?.stop();
    await server.close();
  });

  it("publishes the full item list as herdr:local and primes silently on the first pass", async () => {
    server.terminals = [terminal({ address: "t1", status: "working" })];
    adapter = make();
    await adapter.start(sink);

    expect(sink.items).toEqual([expect.objectContaining({ source: "herdr:local", type: "agent", id: "t1", status: "running" })]);
    // Existing agents at startup are state, not news.
    expect(sink.events).toEqual([]);
    expect(sink.lastHealth).toMatchObject({ ok: true });
  });

  it("can be told to announce agents that already exist at startup", async () => {
    server.terminals = [terminal({ address: "t1", status: "working" })];
    adapter = make({ emitInitial: true });
    await adapter.start(sink);
    expect(sink.events).toEqual([expect.objectContaining({ kind: "agent.transition", source: "herdr:local" })]);
  });

  it("emits transition events as agents change state", async () => {
    server.terminals = [terminal({ address: "t1", status: "working" })];
    adapter = make();
    await adapter.start(sink);

    server.terminals = [terminal({ address: "t1", status: "blocked", turn: 1 })];
    await adapter.refresh();

    expect(sink.items[0]?.status).toBe("needs_attention");
    expect(sink.events.map((e) => e.data)).toEqual([expect.objectContaining({ kind: "changed", from: "running", to: "needs_attention" })]);
  });

  it("keeps last known items and reports unhealthy when herdr-core stops answering, then recovers", async () => {
    server.terminals = [terminal({ address: "t1", status: "working" })];
    adapter = make();
    await adapter.start(sink);
    const callsBefore = sink.replaceCalls;

    server.mode = "silent";
    await adapter.refresh();
    expect(sink.lastHealth).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) });
    expect(sink.replaceCalls).toBe(callsBefore);
    expect(sink.items).toHaveLength(1);

    server.mode = "normal";
    await adapter.refresh();
    expect(sink.lastHealth).toMatchObject({ ok: true });
  });

  it("reports a generation it does not speak as unhealthy, naming both", async () => {
    server.generation = 2;
    adapter = make();
    await adapter.start(sink);

    expect(sink.lastHealth).toMatchObject({ ok: false, error: expect.stringMatching(/generation 1.*generation 2/) });
    expect(sink.replaceCalls).toBe(0);
  });

  it("re-emits a transition whose write was refused on the next pass", async () => {
    server.terminals = [terminal({ address: "t1", status: "working" })];
    adapter = make();
    await adapter.start(sink);
    server.terminals = [terminal({ address: "t1", status: "done", turn: 1 })];
    const emit = sink.emitEvents.bind(sink);
    sink.emitEvents = () => {
      throw new Error("db locked");
    };
    await adapter.refresh();
    expect(sink.lastHealth).toMatchObject({ ok: false, error: "db locked" });

    sink.emitEvents = emit;
    await adapter.refresh();

    expect(sink.events.map((e) => e.data)).toEqual([expect.objectContaining({ kind: "changed", to: "finished", completed: true })]);
  });

  it("gives every Health report a staleness limit of 3x its refresh interval", async () => {
    adapter = make({ intervalMs: 2000 });
    await adapter.start(sink);
    server.mode = "silent";
    await adapter.refresh();

    expect(sink.health.map((h) => h.staleAfterMs)).toEqual([6000, 6000]);
  });

  it("coalesces overlapping refresh calls into at most one extra pass", async () => {
    adapter = make();
    await adapter.start(sink);
    const before = server.lists;

    await Promise.all([adapter.refresh(), adapter.refresh(), adapter.refresh(), adapter.refresh()]);
    expect(server.lists - before).toBe(2);
  });

  it("survives a sink that throws on health reports", async () => {
    adapter = make();
    sink.reportHealth = () => {
      throw new Error("db locked");
    };
    await expect(adapter.start(sink)).resolves.toBeUndefined();
    await expect(adapter.refresh()).resolves.toBeUndefined();
  });

  it("only ever sends read-only methods", async () => {
    server.terminals = [terminal({ address: "t1", status: "working" })];
    adapter = make();
    await adapter.start(sink);
    await adapter.refresh();

    expect(server.methods.length).toBeGreaterThan(0);
    for (const m of server.methods) expect(READ_ONLY_METHODS.has(m)).toBe(true);
  });
});
