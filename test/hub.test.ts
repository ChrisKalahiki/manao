import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceAdapter } from "../src/core/types.js";
import { HerdrAdapter } from "../src/herdr/adapter.js";
import { HerdrClient, READ_ONLY_METHODS } from "../src/herdr/client.js";
import { type Hub, type HubOptions, startHub } from "../src/hub/hub.js";
import { openStore, type Store } from "../src/store/store.js";
import { FakeHerdrCore, terminal, waitFor } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const start = (opts: Partial<HubOptions>) =>
  startHub({ dbPath: ":memory:", adapters: [], eventRetentionDays: 30, log: () => {}, ...opts });

describe("hub", () => {
  let server: FakeHerdrCore;
  let hub: Hub | undefined;

  const herdr = (intervalMs = 60_000) =>
    new HerdrAdapter({
      client: new HerdrClient({ socketPath: server.socketPath, timeoutMs: 500 }),
      intervalMs,
      events: false,
    });

  beforeEach(async () => {
    server = await new FakeHerdrCore().listen();
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    await server.close();
  });

  it("stores Herdr agents as Items, with Attention on blocked and done ones", async () => {
    server.terminals = [
      terminal({ address: "working", status: "working" }),
      terminal({ address: "blocked", status: "blocked" }),
      terminal({ address: "done", status: "done" }),
      terminal({ address: "idle", status: "idle" }),
    ];

    hub = await start({ adapters: [herdr()] });

    const agents = hub.store.items.list({ type: "agent" });
    expect(agents.map((i) => [i.source, i.id, i.status, i.attention]).sort()).toEqual([
      ["herdr:local", "blocked", "needs_attention", true],
      ["herdr:local", "done", "finished", true],
      ["herdr:local", "idle", "idle", false],
      ["herdr:local", "working", "running", false],
    ]);
    expect(hub.store.items.list({ attention: true }).map((i) => i.id).sort()).toEqual(["blocked", "done"]);
  });

  it("keeps Herdr's Items as Stale while it is unreachable, and current again once it recovers", async () => {
    server.terminals = [terminal({ address: "a" })];
    const adapter = herdr();
    hub = await start({ adapters: [adapter] });
    const lastOkAt = hub.store.health.list()[0]?.lastOkAt;
    expect(lastOkAt).toEqual(expect.any(String));

    server.mode = "silent";
    await adapter.refresh();
    expect(hub.store.items.list().map((i) => [i.id, i.sourceOk, i.lastOkAt])).toEqual([["a", false, lastOkAt]]);

    server.mode = "normal";
    await adapter.refresh();
    expect(hub.store.items.list().map((i) => [i.id, i.sourceOk])).toEqual([["a", true]]);
  });

  it("records a Herdr agent changing state as a transition Event", async () => {
    server.terminals = [terminal({ address: "a", status: "working" })];
    const adapter = herdr();
    hub = await start({ adapters: [adapter] });

    server.terminals = [terminal({ address: "a", status: "blocked" })];
    await adapter.refresh();

    const events = hub.store.events.after(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "herdr:local",
      kind: "agent.transition",
      data: { kind: "changed", terminalId: "a", from: "running", to: "needs_attention" },
    });
  });

  it("stops polling Herdr and closes the store when stopped", async () => {
    server.terminals = [terminal({ address: "t1" })];
    const started = await start({ adapters: [herdr(10)] });
    await waitFor(() => snapshotReads() >= 3);

    await started.stop();
    const readsAtStop = snapshotReads();
    await new Promise((r) => setTimeout(r, 50));

    expect(snapshotReads()).toBe(readsAtStop);
    expect(() => started.store.items.list()).toThrow(/not open/);
  });

  it("stops the Adapters already started and its own pruning when another Adapter fails to start", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const stopped: string[] = [];
      const adapter = (id: string, start: () => Promise<void>): SourceAdapter => ({
        id,
        start,
        stop: async () => void stopped.push(id),
        refresh: async () => {},
      });

      const starting = start({
        adapters: [
          adapter("first", async () => {}),
          adapter("broken", () => Promise.reject(new Error("cannot reach it"))),
          adapter("never started", async () => {}),
        ],
      });

      await expect(starting).rejects.toThrow("cannot reach it");
      expect(stopped).toEqual(["first"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  const snapshotReads = () => server.lists;
});

describe("hub: upkeep", () => {
  let dir: string;
  let dbPath: string;
  let hub: Hub | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-hub-"));
    dbPath = path.join(dir, "hub.db");
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes to the store as an earlier hub run would have. */
  const before = (write: (store: Store) => void, now?: () => Date) => {
    const store = openStore(dbPath, { now });
    write(store);
    store.close();
  };

  it("removes a Source the config no longer enables at startup, logging it and keeping its Events", async () => {
    const server = await new FakeHerdrCore().listen();
    try {
      server.terminals = [terminal({ address: "now" })];
      before((store) => {
        store.replaceItems("herdr:default", "agent", [
          {
            source: "herdr:default",
            type: "agent",
            id: "then",
            title: "Herdr 0.9.5 agent",
            status: "idle",
            attention: false,
            updatedAt: new Date().toISOString(),
            data: {},
          },
        ]);
        store.reportHealth("herdr:default", { ok: true, at: new Date().toISOString(), staleAfterMs: 15_000 });
        store.emitEvents([{ source: "herdr:default", kind: "agent.transition", at: new Date().toISOString(), data: {} }]);
      });
      const log: string[] = [];

      hub = await start({
        dbPath,
        adapters: [
          new HerdrAdapter({
            client: new HerdrClient({ socketPath: server.socketPath, timeoutMs: 500 }),
            intervalMs: 60_000,
            events: false,
          }),
        ],
        log: (line) => log.push(line),
      });

      expect(hub.store.items.list().map((i) => `${i.source}/${i.id}`)).toEqual(["herdr:local/now"]);
      expect(hub.store.health.list().map((h) => h.source)).toEqual(["herdr:local"]);
      expect(hub.store.events.after(0).map((e) => e.source)).toEqual(["herdr:default"]);
      expect(log).toEqual([expect.stringContaining("herdr:default")]);
    } finally {
      await hub?.stop();
      hub = undefined;
      await server.close();
    }
  });

  it("prunes Events older than the configured retention at startup", async () => {
    const now = new Date("2026-10-19T08:00:00.000Z");
    const emitDaysAgo = (days: number, name: string) =>
      before(
        (store) => store.emitEvents([{ source: "herdr:local", kind: "k", at: now.toISOString(), data: { name } }]),
        () => new Date(now.getTime() - days * DAY_MS),
      );
    emitDaysAgo(8, "old");
    emitDaysAgo(6, "recent");

    hub = await start({ dbPath, eventRetentionDays: 7, now: () => now });

    expect(hub.store.events.after(0).map((e) => e.data)).toEqual([{ name: "recent" }]);
  });

  it("prunes Events daily while running, and stops when the hub stops", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = new Date("2026-10-19T08:00:00.000Z");
    const emit = (name: string) =>
      hub!.store.emitEvents([{ source: "s", kind: "k", at: now.toISOString(), data: { name } }]);
    const names = (store: Store) => store.events.after(0).map((e) => (e.data as { name: string }).name);
    hub = await start({ dbPath, eventRetentionDays: 1, now: () => now });
    emit("first");

    now = new Date(now.getTime() + DAY_MS + 1);
    emit("second");
    vi.advanceTimersByTime(DAY_MS);
    expect(names(hub.store)).toEqual(["second"]);

    const stopped = hub;
    hub = undefined;
    await stopped.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("hub: herdr-core events", () => {
  let server: FakeHerdrCore;
  let hub: Hub | undefined;
  let adapter: HerdrAdapter;

  const startWithEvents = async () => {
    adapter = new HerdrAdapter({
      client: new HerdrClient({ socketPath: server.socketPath, timeoutMs: 500 }),
      intervalMs: 60_000, // only events can re-read within a test
      eventBackoffMs: 20,
    });
    hub = await start({ adapters: [adapter] });
    // Subscribing nudges once, for whatever changed before the subscription began.
    await waitFor(() => server.subscribeCount === 1 && server.lists === 2);
  };
  const statusOf = (id: string) => hub?.store.items.list().find((i) => i.id === id)?.status;
  const settle = () => new Promise((r) => setTimeout(r, 400));

  beforeEach(async () => {
    server = await new FakeHerdrCore().listen();
    server.terminals = [terminal({ address: "t1", status: "working" })];
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    await server.close();
  });

  it.each(["event", "missed"])("re-reads on %s before the next poll, recording the transition once", async (method) => {
    await startWithEvents();

    server.terminals = [terminal({ address: "t1", status: "done", turn: 1 })];
    server.notify(method, { type: "status", terminal: "t1", data: {} });
    await waitFor(() => statusOf("t1") === "finished");
    await adapter.refresh();

    expect(hub?.store.events.after(0).map((e) => e.data)).toEqual([
      expect.objectContaining({ kind: "changed", from: "running", to: "finished", completed: true }),
    ]);
  });

  it("does not re-read on a heartbeat", async () => {
    await startWithEvents();

    server.notify("heartbeat");
    await settle();

    expect(server.lists).toBe(2);
  });

  // A working Codex retitles its terminal about every 100ms; none of these change what manao stores.
  it.each(["title", "size", "doc", "keep"])("does not re-read on a %s event", async (type) => {
    await startWithEvents();

    server.notify("event", { type, terminal: "t1", data: {} });
    await settle();

    expect(server.lists).toBe(2);
  });

  it("coalesces a burst of events into one re-read", async () => {
    await startWithEvents();

    for (let i = 0; i < 10; i++) server.notify("event", { type: "status", terminal: "t1", data: {} });
    await settle();

    expect(server.lists).toBe(3);
  });

  it("never trusts an event's payload, storing only what terminal.list says", async () => {
    await startWithEvents();

    server.notify("event", { type: "status", terminal: "t1", data: { status: { app: "claude-code", state: "blocked" } } });
    await waitFor(() => server.lists === 3);
    await adapter.refresh();

    expect(statusOf("t1")).toBe("running");
  });

  it("subscribes again after the core drops the connection, re-reading what changed meanwhile", async () => {
    await startWithEvents();

    server.terminals = [terminal({ address: "t1", status: "blocked" })];
    server.dropConnections();

    await waitFor(() => server.subscribeCount === 2);
    await waitFor(() => statusOf("t1") === "needs_attention");
  });

  it("retries a refused subscription", async () => {
    server.failNextSubscribe = "internal";
    adapter = new HerdrAdapter({
      client: new HerdrClient({ socketPath: server.socketPath, timeoutMs: 500 }),
      intervalMs: 60_000,
      eventBackoffMs: 20,
    });
    hub = await start({ adapters: [adapter] });

    await waitFor(() => server.subscribeCount === 2);
    server.terminals = [terminal({ address: "t1", status: "idle", turn: 1 })];
    server.notify("event", { type: "status", terminal: "t1", data: {} });
    await waitFor(() => statusOf("t1") === "idle");
  });

  it("closes the subscription when stopped", async () => {
    await startWithEvents();
    await hub?.stop();
    hub = undefined;
    const lists = server.lists;

    server.notify("event", { type: "status", terminal: "t1", data: {} });
    await settle();

    expect(server.lists).toBe(lists);
  });

  it("only ever sends read-only methods, the subscription's included", async () => {
    await startWithEvents();
    server.notify("event", { type: "status", terminal: "t1", data: {} });
    await waitFor(() => server.lists === 3);

    expect(new Set(server.methods)).toEqual(new Set(["hello", "terminal.list", "events.subscribe"]));
    for (const method of server.methods) expect(READ_ONLY_METHODS.has(method)).toBe(true);
  });
});
