import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Health, HubEvent, HubItem } from "../src/core/types.js";
import { openStore, type Store } from "../src/store/store.js";

const T0 = "2026-10-19T08:00:00.000Z";
const T1 = "2026-10-19T08:05:00.000Z";

function item(over: Partial<HubItem> = {}): HubItem {
  return {
    source: "herdr:local",
    type: "agent",
    id: "term_a",
    title: "fix the build",
    status: "running",
    attention: false,
    updatedAt: T0,
    data: { cwd: "/work" },
    ...over,
  };
}

/** How a query returns an Item whose Source has never reported Health. */
const unreported = (i: HubItem) => ({ ...i, sourceOk: false, lastOkAt: null });

function event(over: Partial<HubEvent> = {}): HubEvent {
  return { source: "herdr:local", kind: "agent.transition", at: T0, data: {}, ...over };
}

describe("store: Items", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(":memory:", { now: () => new Date(T1) });
  });
  afterEach(() => store.close());

  it("returns the Items a Source replaced, as they were sent", () => {
    const a = item({ id: "a", data: { cwd: "/a", nested: { n: 1 } } });
    const b = item({ id: "b", status: "idle" });
    store.replaceItems("herdr:local", "agent", [a, b]);

    expect(store.items.list()).toEqual([a, b].map(unreported));
  });

  it("replaces the whole set for one Source and type, leaving other sets alone", () => {
    const task = item({ source: "obsidian", type: "task", id: "t1", status: "open" });
    const work = item({ source: "herdr:work", id: "w1" });
    store.replaceItems("obsidian", "task", [task]);
    store.replaceItems("herdr:work", "agent", [work]);
    store.replaceItems("herdr:local", "agent", [item({ id: "a" }), item({ id: "b" })]);

    store.replaceItems("herdr:local", "agent", [item({ id: "c" })]);

    expect(store.items.list().map((i) => `${i.source}/${i.type}/${i.id}`)).toEqual([
      "herdr:local/agent/c",
      "herdr:work/agent/w1",
      "obsidian/task/t1",
    ]);
  });

  it("keeps the previous set when a replace fails part way", () => {
    store.replaceItems("herdr:local", "agent", [item({ id: "a" })]);

    const duplicateIds = [item({ id: "b" }), item({ id: "b" })];
    expect(() => store.replaceItems("herdr:local", "agent", duplicateIds)).toThrow();

    expect(store.items.list().map((i) => i.id)).toEqual(["a"]);
  });

  it("stores an empty list as nothing there", () => {
    store.replaceItems("herdr:local", "agent", [item({ id: "a" })]);

    store.replaceItems("herdr:local", "agent", []);

    expect(store.items.list()).toEqual([]);
  });

  describe("queries", () => {
    beforeEach(() => {
      store.replaceItems("herdr:local", "agent", [
        item({ id: "running" }),
        item({ id: "blocked", status: "needs_attention", attention: true }),
        item({ id: "idle", status: "idle" }),
      ]);
      store.replaceItems("obsidian", "task", [
        item({ source: "obsidian", type: "task", id: "open", status: "open" }),
        item({ source: "obsidian", type: "task", id: "overdue", status: "open", attention: true }),
      ]);
    });
    const ids = (items: HubItem[]) => items.map((i) => i.id);

    it("lists Items of one type", () => {
      expect(ids(store.items.list({ type: "task" }))).toEqual(["open", "overdue"]);
    });

    it("lists Items in one Status", () => {
      expect(ids(store.items.list({ status: "idle" }))).toEqual(["idle"]);
    });

    it("lists Items by type and Status together", () => {
      expect(ids(store.items.list({ type: "task", status: "open" }))).toEqual(["open", "overdue"]);
      expect(ids(store.items.list({ type: "agent", status: "open" }))).toEqual([]);
    });

    it("lists the Items with Attention raised, across Sources", () => {
      expect(ids(store.items.list({ attention: true }))).toEqual(["blocked", "overdue"]);
    });
  });

  describe("updatedAt", () => {
    const resend = (over: Partial<HubItem>) => {
      store.replaceItems("herdr:local", "agent", [item({ updatedAt: T0 })]);
      store.replaceItems("herdr:local", "agent", [item({ updatedAt: T1, ...over })]);
      return store.items.list()[0]?.updatedAt;
    };

    it("keeps the stored time when the Item is unchanged", () => {
      expect(resend({})).toBe(T0);
    });

    it.each<[string, Partial<HubItem>]>([
      ["title", { title: "fix the tests" }],
      ["Status", { status: "idle" }],
      ["Attention only", { attention: true }],
      ["data", { data: { cwd: "/elsewhere" } }],
    ])("takes the incoming time when %s changed", (_what, over) => {
      expect(resend(over)).toBe(T1);
    });
  });
});

describe("store: Health", () => {
  const LIMIT = 60_000;
  let clock: Date;
  let store: Store;

  const report = (over: Partial<Health> = {}) =>
    store.reportHealth("herdr:local", { ok: true, at: clock.toISOString(), staleAfterMs: LIMIT, ...over });
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  beforeEach(() => {
    clock = new Date(T0);
    store = openStore(":memory:", { now: () => clock });
  });
  afterEach(() => store.close());

  it("keeps the latest report per Source, with when it last succeeded", () => {
    report({ note: "protocol 23" });
    advance(10_000);
    report({ ok: false, error: "timed out" });
    store.reportHealth("obsidian", { ok: true, at: clock.toISOString(), staleAfterMs: 5_000 });

    expect(store.health.list()).toEqual([
      {
        source: "herdr:local",
        ok: false,
        at: "2026-10-19T08:00:10.000Z",
        error: "timed out",
        staleAfterMs: LIMIT,
        lastOkAt: T0,
        healthy: false,
      },
      {
        source: "obsidian",
        ok: true,
        at: "2026-10-19T08:00:10.000Z",
        staleAfterMs: 5_000,
        lastOkAt: "2026-10-19T08:00:10.000Z",
        healthy: true,
      },
    ]);
  });

  it("has no last success for a Source that has only failed", () => {
    report({ ok: false, error: "refused" });

    expect(store.health.list()).toMatchObject([{ lastOkAt: null, healthy: false }]);
  });

  describe("Items carry their Source's Health", () => {
    const freshness = () => store.items.list().map(({ sourceOk, lastOkAt }) => ({ sourceOk, lastOkAt }));

    beforeEach(() => {
      store.replaceItems("herdr:local", "agent", [item()]);
    });

    it("marks Items current while the latest report succeeded within its limit", () => {
      report();
      advance(LIMIT);

      expect(freshness()).toEqual([{ sourceOk: true, lastOkAt: T0 }]);
    });

    it("marks Items Stale once the latest report failed", () => {
      report();
      advance(1_000);
      report({ ok: false, error: "timed out" });

      expect(freshness()).toEqual([{ sourceOk: false, lastOkAt: T0 }]);
    });

    it("marks Items Stale once a success is older than its limit", () => {
      report();
      advance(LIMIT + 1);

      expect(freshness()).toEqual([{ sourceOk: false, lastOkAt: T0 }]);
    });

    it("marks Items Stale when their Source never reported Health", () => {
      expect(freshness()).toEqual([{ sourceOk: false, lastOkAt: null }]);
    });

    it("never empties a Source's Items on failure", () => {
      report({ ok: false, error: "timed out" });

      expect(store.items.list().map((i) => i.id)).toEqual(["term_a"]);
    });
  });
});

describe("store: Events", () => {
  let clock: Date;
  let store: Store;

  beforeEach(() => {
    clock = new Date(T1);
    store = openStore(":memory:", { now: () => clock });
  });
  afterEach(() => store.close());

  const ids = () => store.events.after(0).map((e) => e.id);
  const emitAt = (at: string, name: string) => {
    clock = new Date(at);
    store.emitEvents([event({ data: { name } })]);
  };

  it("gives each Event an id that increases across calls, keeping what the Adapter sent", () => {
    const first = event({ kind: "agent.transition", data: { to: "blocked" } });
    store.emitEvents([first, event()]);
    store.emitEvents([event()]);

    const stored = store.events.after(0);
    expect(stored[0]).toEqual({ ...first, at: T1, id: stored[0]?.id });
    const [a, b, c] = ids();
    expect(a).toBeLessThan(b!);
    expect(b).toBeLessThan(c!);
  });

  it("stamps each Event with the time the store recorded it, not the time the Adapter sent", () => {
    store.emitEvents([event({ at: "2020-01-01T00:00:00.000Z" })]);

    expect(store.events.after(0).map((e) => e.at)).toEqual([T1]);
  });

  it("returns only the Events after an id, in order, up to the limit", () => {
    store.emitEvents(["a", "b", "c", "d"].map((name) => event({ data: { name } })));
    const [first] = ids();

    const page = store.events.after(first!, 2);

    expect(page.map((e) => e.data)).toEqual([{ name: "b" }, { name: "c" }]);
  });

  it("pages through Events sharing a timestamp without missing or repeating any", () => {
    const names = ["a", "b", "c", "d", "e"];
    store.emitEvents(names.map((name) => event({ data: { name } })));

    const seen: unknown[] = [];
    let cursor = 0;
    for (let page = store.events.after(cursor, 2); page.length > 0; page = store.events.after(cursor, 2)) {
      seen.push(...page.map((e) => e.data));
      cursor = page.at(-1)!.id;
    }

    expect(seen).toEqual(names.map((name) => ({ name })));
  });

  it("returns the Events observed at or after a time, in the order recorded", () => {
    emitAt("2026-10-19T07:59:59.999Z", "before");
    emitAt(T0, "at");
    emitAt(T1, "later");
    emitAt(T0, "at again");

    const since = store.events.since(new Date(T0));

    expect(since.map((e) => e.data)).toEqual([{ name: "at" }, { name: "later" }, { name: "at again" }]);
  });

  it("reports the newest Event's id, or 0 before any Event", () => {
    expect(store.events.latestId()).toBe(0);

    store.emitEvents([event(), event()]);

    expect(store.events.latestId()).toBe(ids().at(-1));
  });

  it("returns a Source's newest Event of each kind, oldest kind first", () => {
    // #given
    store.emitEvents([
      event({ source: "paper-bot:picks", kind: "scan.daily", data: { n: 1 } }),
      event({ source: "paper-bot:picks", kind: "scan.weekly", data: { n: 2 } }),
      event({ source: "herdr:local", kind: "scan.daily", data: { n: 3 } }),
      event({ source: "paper-bot:picks", kind: "scan.daily", data: { n: 4 } }),
    ]);

    // #when
    const latest = store.events.latestOfEachKind("paper-bot:picks");

    // #then
    expect(latest.map((e) => [e.kind, e.data])).toEqual([
      ["scan.weekly", { n: 2 }],
      ["scan.daily", { n: 4 }],
    ]);
  });

  it("does not record Events of its own when Items change", () => {
    store.replaceItems("herdr:local", "agent", [item()]);
    store.replaceItems("herdr:local", "agent", [item({ status: "idle", updatedAt: T1 })]);
    store.replaceItems("herdr:local", "agent", []);

    expect(store.events.after(0)).toEqual([]);
  });
});

describe("store: Measurements", () => {
  const SOURCE = "google-health:primary";
  let clock: Date;
  let store: Store;

  beforeEach(() => {
    clock = new Date(T1);
    store = openStore(":memory:", { now: () => clock });
  });
  afterEach(() => store.close());

  const steps = (date: string, value: number) => ({ metric: "steps" as const, date, value });

  it("returns the Measurements a Source wrote, each with its unit and its Source's freshness", () => {
    store.writeMeasurements(SOURCE, [steps("2026-10-18", 3416), steps("2026-10-19", 0)]);
    store.reportHealth(SOURCE, { ok: true, at: T1, staleAfterMs: 60_000 });

    expect(store.measurements.list()).toEqual([
      { source: SOURCE, metric: "steps", date: "2026-10-18", value: 3416, unit: "count", sourceOk: true, lastOkAt: T1 },
      { source: SOURCE, metric: "steps", date: "2026-10-19", value: 0, unit: "count", sourceOk: true, lastOkAt: T1 },
    ]);
  });

  it("replaces the days written and keeps every other day", () => {
    store.writeMeasurements(SOURCE, [steps("2026-10-17", 100), steps("2026-10-18", 200)]);

    store.writeMeasurements(SOURCE, [steps("2026-10-18", 250), steps("2026-10-19", 300)]);

    expect(store.measurements.list().map((m) => [m.date, m.value])).toEqual([
      ["2026-10-17", 100],
      ["2026-10-18", 250],
      ["2026-10-19", 300],
    ]);
  });

  it("orders by Metric, then date, and filters by Metric and an inclusive range of dates", () => {
    store.writeMeasurements(SOURCE, [steps("2026-10-19", 3), steps("2026-10-17", 1), steps("2026-10-18", 2)]);

    expect(store.measurements.list().map((m) => m.date)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(store.measurements.list({ metric: "steps", from: "2026-10-18", to: "2026-10-18" }).map((m) => m.value)).toEqual([2]);
    expect(store.measurements.list({ from: "2026-10-18" }).map((m) => m.value)).toEqual([2, 3]);
    expect(store.measurements.list({ to: "2026-10-17" }).map((m) => m.value)).toEqual([1]);
  });

  it("marks Measurements Stale when their Source is not Healthy", () => {
    store.writeMeasurements(SOURCE, [steps("2026-10-19", 3)]);
    store.reportHealth(SOURCE, { ok: true, at: T0, staleAfterMs: 60_000 });

    expect(store.measurements.list()).toEqual([expect.objectContaining({ sourceOk: false, lastOkAt: T0 })]);
  });

  it("knows the date of each Source's latest Measurement", () => {
    expect(store.measurements.latestDate(SOURCE)).toBeNull();

    store.writeMeasurements(SOURCE, [steps("2026-10-19", 3), steps("2026-10-17", 1)]);
    store.writeMeasurements("google-health:other", [steps("2026-10-21", 3)]);

    expect(store.measurements.latestDate(SOURCE)).toBe("2026-10-19");
  });
});

describe("store: upkeep", () => {
  let clock: Date;
  let store: Store;

  beforeEach(() => {
    clock = new Date(T1);
    store = openStore(":memory:", { now: () => clock });
  });
  afterEach(() => store.close());

  const health = (): Health => ({ ok: true, at: T1, staleAfterMs: 60_000 });

  it("removes the Items and Health of Sources outside the kept set, but keeps their Events", () => {
    store.replaceItems("herdr:local", "agent", [item({ id: "kept" })]);
    store.reportHealth("herdr:local", health());
    store.replaceItems("herdr:old", "agent", [item({ source: "herdr:old", id: "gone" })]);
    store.reportHealth("herdr:old", health());
    store.reportHealth("obsidian", health());
    store.emitEvents([event({ source: "herdr:old", data: { name: "old" } })]);

    const removed = store.removeSourcesExcept(["herdr:local"]);

    expect(removed).toEqual(["herdr:old", "obsidian"]);
    expect(store.items.list().map((i) => i.id)).toEqual(["kept"]);
    expect(store.health.list().map((h) => h.source)).toEqual(["herdr:local"]);
    expect(store.events.after(0).map((e) => e.data)).toEqual([{ name: "old" }]);
  });

  it("keeps the Measurements of a removed Source, and never prunes them", () => {
    store.writeMeasurements("google-health:primary", [{ metric: "steps", date: "2026-01-01", value: 1 }]);
    store.reportHealth("google-health:primary", health());

    store.removeSourcesExcept([]);
    store.pruneEvents(1);

    expect(store.health.list()).toEqual([]);
    expect(store.measurements.list()).toEqual([expect.objectContaining({ date: "2026-01-01", value: 1, sourceOk: false, lastOkAt: null })]);
  });

  it("removes nothing when every stored Source is kept", () => {
    store.replaceItems("herdr:local", "agent", [item()]);

    expect(store.removeSourcesExcept(["herdr:local", "obsidian"])).toEqual([]);
    expect(store.items.list()).toHaveLength(1);
  });

  it("prunes Events older than the retention window, keeping the one exactly at its edge", () => {
    const emitAt = (at: string, name: string) => {
      clock = new Date(at);
      store.emitEvents([event({ data: { name } })]);
    };
    emitAt("2026-10-01T11:59:59.999Z", "too old");
    emitAt("2026-10-01T12:00:00.000Z", "edge");
    emitAt("2026-10-31T11:00:00.000Z", "recent");
    clock = new Date("2026-10-31T12:00:00.000Z");

    const pruned = store.pruneEvents(30);

    expect(pruned).toBe(1);
    expect(store.events.after(0).map((e) => e.data)).toEqual([{ name: "edge" }, { name: "recent" }]);
  });
});

describe("store: on disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a missing directory and keeps Items across reopening", () => {
    const file = path.join(dir, "nested", "hub.db");
    const first = openStore(file);
    first.replaceItems("herdr:local", "agent", [item()]);
    first.close();

    const second = openStore(file);
    expect(second.items.list()).toEqual([unreported(item())]);
    second.close();
  });

  it("upgrades a store of the previous schema in place, keeping its Items", () => {
    const file = path.join(dir, "hub.db");
    const first = openStore(file);
    first.replaceItems("herdr:local", "agent", [item()]);
    first.close();
    const previous = new Database(file);
    previous.exec("DROP TABLE measurements");
    previous.pragma("user_version = 1");
    previous.close();

    const upgraded = openStore(file);
    upgraded.writeMeasurements("google-health:primary", [{ metric: "steps", date: "2026-10-19", value: 3 }]);

    expect(upgraded.items.list()).toEqual([unreported(item())]);
    expect(upgraded.measurements.list()).toHaveLength(1);
    upgraded.close();
    const reopened = new Database(file, { readonly: true });
    expect(reopened.pragma("user_version", { simple: true })).toBe(2);
    reopened.close();
  });

  it("refuses to read a store of the previous schema until the hub has upgraded it", () => {
    const file = path.join(dir, "hub.db");
    openStore(file).close();
    const previous = new Database(file);
    previous.pragma("user_version = 1");
    previous.close();

    expect(() => openStore(file, { readOnly: true })).toThrow(
      "schema version 1 is older than this manao reads (2); restart `manao run` to upgrade it",
    );
  });

  describe("read-only, beside the writer", () => {
    let writer: Store;
    let reader: Store;

    beforeEach(() => {
      const file = path.join(dir, "hub.db");
      const now = () => new Date(T1);
      writer = openStore(file, { now });
      reader = openStore(file, { now, readOnly: true });
    });
    afterEach(() => {
      reader.close();
      writer.close();
    });

    it("sees the writer's Items with their Source's Health", () => {
      writer.replaceItems("herdr:local", "agent", [item()]);
      writer.reportHealth("herdr:local", { ok: true, at: T1, staleAfterMs: 60_000 });

      expect(reader.items.list()).toEqual([{ ...item(), sourceOk: true, lastOkAt: T1 }]);
    });

    it("refuses to write", () => {
      expect(() => reader.replaceItems("herdr:local", "agent", [item()])).toThrow(/readonly/);
    });
  });
});
