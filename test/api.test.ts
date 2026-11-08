import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Health, HubItem, SourceAdapter } from "../src/core/types.js";
import { HerdrAdapter } from "../src/herdr/adapter.js";
import { HerdrClient } from "../src/herdr/client.js";
import { parseConfig } from "../src/hub/config.js";
import { type Hub, startHub, startHubFromConfig } from "../src/hub/hub.js";
import { FakeHerdrCore, terminal } from "./helpers.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** A real HTTP request to the hub's API; `host` overrides the Host header. */
function request(url: string, opts: { method?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? "GET", headers: opts.host ? { host: opts.host } : {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
}

interface ApiHub {
  server: FakeHerdrCore;
  adapter: HerdrAdapter;
  hub: Hub;
  get(path: string, opts?: { method?: string; host?: string }): Promise<Reply>;
  stop(): Promise<void>;
}

/**
 * A hub with one HerdrAdapter on a FakeHerdrCore reporting `statuses`, any `others`
 * beside it, and the API on a free port, all on `now`.
 */
async function startApiHub(
  now: () => Date,
  statuses: Record<string, string> = {},
  others: SourceAdapter[] = [],
): Promise<ApiHub> {
  const server = await new FakeHerdrCore().listen();
  report(server, statuses);
  const adapter = new HerdrAdapter({
    client: new HerdrClient({ socketPath: server.socketPath, timeoutMs: 200 }),
    intervalMs: 60_000,
    events: false,
    now,
  });
  const hub = await startHub({ dbPath: ":memory:", adapters: [adapter, ...others], eventRetentionDays: 30, api: { port: 0 }, now, log: () => {} });
  return {
    server,
    adapter,
    hub,
    get: (path, opts) => request(`${hub.apiUrl}${path}`, opts),
    stop: async () => {
      await hub.stop();
      await server.close();
    },
  };
}

/** Has Herdr report each terminal id with its status. */
function report(server: FakeHerdrCore, statuses: Record<string, string>): void {
  server.terminals = Object.entries(statuses).map(([id, status]) => terminal({ address: id, status }));
}

describe("API: /api/items", () => {
  const now = new Date("2026-10-19T08:00:00.000Z");
  let api: ApiHub;
  const get = (path: string, opts?: { method?: string; host?: string }) => api.get(path, opts);

  beforeEach(async () => {
    api = await startApiHub(() => now, { working: "working", blocked: "blocked", done: "done" });
  });
  afterEach(() => api.stop());

  it("lists Herdr agents as Items with Attention and freshness, on the hub's clock", async () => {
    const reply = await get("/api/items");

    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toMatch(/^application\/json/);
    expect(reply.body).toEqual({
      now: "2026-10-19T08:00:00.000Z",
      items: [
        expect.objectContaining({ id: "blocked", status: "needs_attention", attention: true, sourceOk: true, lastOkAt: now.toISOString() }),
        expect.objectContaining({ id: "done", status: "finished", attention: true, sourceOk: true, lastOkAt: now.toISOString() }),
        expect.objectContaining({ id: "working", status: "running", attention: false, sourceOk: true, lastOkAt: now.toISOString() }),
      ],
    });
  });

  it.each([
    ["type", "?type=agent", ["blocked", "done", "working"]],
    ["type", "?type=task", []],
    ["status", "?status=running", ["working"]],
    ["attention", "?attention=true", ["blocked", "done"]],
    ["attention", "?attention=false", ["working"]],
    ["every filter at once", "?type=agent&status=finished&attention=true", ["done"]],
  ])("narrows the Items by %s (%s)", async (_name, query, ids) => {
    const reply = await get(`/api/items${query}`);

    expect(reply.status).toBe(200);
    expect((reply.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(ids);
  });

  it.each([
    ["a malformed attention", "?attention=yes", "attention must be true or false"],
    ["an unknown parameter", "?sort=title", "sort is not a known parameter (expected one of: type, status, attention)"],
    ["an empty value", "?status=", "status must not be empty"],
    ["a repeated parameter", "?type=agent&type=task", "type is given more than once"],
  ])("refuses %s with 400 naming the parameter", async (_name, query, error) => {
    const reply = await get(`/api/items${query}`);

    expect(reply).toMatchObject({ status: 400, body: { error } });
  });

  it.each([
    ["localhost", (port: string) => `localhost:${port}`],
    ["127.0.0.1", (port: string) => `127.0.0.1:${port}`],
    ["a tailnet name", () => "mac-mini.tail1234.ts.net"],
  ])("answers a request addressed to %s", async (_name, host) => {
    const reply = await get("/api/items", { host: host(new URL(`${api.hub.apiUrl}`).port) });

    expect(reply.status).toBe(200);
  });

  it.each([
    ["another name", () => "evil.example.com"],
    ["localhost on another port", () => "localhost:1"],
    ["a name merely containing ts.net", () => "ts.net.evil.example.com"],
  ])("refuses a request addressed to %s with 403", async (_name, host) => {
    const reply = await get("/api/items", { host: host() });

    expect(reply).toMatchObject({ status: 403, body: { error: expect.any(String) } });
  });

  it("refuses an unknown path with 404", async () => {
    const reply = await get("/api/nothing");

    expect(reply).toEqual(expect.objectContaining({ status: 404, body: { error: "No such path: /api/nothing" } }));
  });

  it.each(["POST", "PUT", "DELETE"])("refuses %s with 405, as the API is read-only", async (method) => {
    const reply = await get("/api/items", { method });

    expect(reply).toMatchObject({ status: 405, headers: { allow: "GET" }, body: { error: expect.stringContaining(method) } });
  });
});

describe("API: /api/sources", () => {
  const started = new Date("2026-10-19T08:00:00.000Z");
  let clock: Date;
  let api: ApiHub;
  const get = (path: string) => api.get(path);

  beforeEach(async () => {
    clock = started;
    api = await startApiHub(() => clock);
  });
  afterEach(() => api.stop());

  it("reports a reachable Source as Healthy, on the hub's clock", async () => {
    const reply = await get("/api/sources");

    expect(reply).toMatchObject({ status: 200 });
    expect(reply.body).toEqual({
      now: started.toISOString(),
      sources: [
        {
          source: "herdr:local",
          ok: true,
          at: started.toISOString(),
          staleAfterMs: 180_000,
          lastOkAt: started.toISOString(),
          healthy: true,
        },
      ],
    });
  });

  it("reports an unreachable Source as unhealthy with its error, keeping its last success", async () => {
    clock = new Date(started.getTime() + 60_000);
    api.server.mode = "silent";
    await api.adapter.refresh();

    const reply = await get("/api/sources");

    expect(reply.body).toEqual({
      now: clock.toISOString(),
      sources: [
        {
          source: "herdr:local",
          ok: false,
          at: clock.toISOString(),
          error: expect.any(String),
          staleAfterMs: 180_000,
          lastOkAt: started.toISOString(),
          healthy: false,
        },
      ],
    });
  });

  it("reports an ok Source as unhealthy once its report is older than its staleness limit", async () => {
    clock = new Date(started.getTime() + 180_000);
    expect((await get("/api/sources")).body).toMatchObject({ sources: [{ ok: true, healthy: true }] });

    clock = new Date(started.getTime() + 180_001);
    expect((await get("/api/sources")).body).toMatchObject({ sources: [{ ok: true, healthy: false }] });
  });

  it("refuses any parameter with 400 naming it", async () => {
    const reply = await get("/api/sources?source=herdr:local");

    expect(reply).toMatchObject({ status: 400, body: { error: "source is not a known parameter (expected none)" } });
  });
});

describe("API: /api/events", () => {
  let clock: Date;
  let api: ApiHub;
  const get = (path: string) => api.get(path);
  const ids = (reply: Reply) => (reply.body as { events: Array<{ id: number }> }).events.map((e) => e.id);
  /** Moves the hub's clock to `time`, then has Herdr report each terminal id with its status. */
  const at = async (time: string, statuses: Record<string, string>) => {
    clock = new Date(time);
    report(api.server, statuses);
    await api.adapter.refresh();
  };

  beforeEach(async () => {
    clock = new Date("2026-10-19T08:00:00.000Z");
    api = await startApiHub(() => clock, { a: "working", b: "working", c: "working" });
    await at("2026-10-19T08:01:00.000Z", { a: "blocked", b: "working", c: "working" });
    await at("2026-10-19T08:02:00.000Z", { a: "blocked", b: "blocked", c: "blocked" });
  });
  afterEach(() => api.stop());

  it("returns Herdr's transitions as Events in id order, on the hub's clock", async () => {
    const reply = await get("/api/events");

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      now: "2026-10-19T08:02:00.000Z",
      events: [
        expect.objectContaining({ id: 1, at: "2026-10-19T08:01:00.000Z", data: expect.objectContaining({ terminalId: "a", to: "needs_attention" }) }),
        expect.objectContaining({ id: 2, at: "2026-10-19T08:02:00.000Z", data: expect.objectContaining({ terminalId: "b", to: "needs_attention" }) }),
        expect.objectContaining({ id: 3, at: "2026-10-19T08:02:00.000Z", data: expect.objectContaining({ terminalId: "c", to: "needs_attention" }) }),
      ],
      next: 3,
      more: false,
    });
  });

  it.each([
    ["a page that fills the limit", "?limit=2", [1, 2], 2, true],
    ["the page after it", "?after=2&limit=2", [3], 3, false],
    ["a page past the last Event", "?after=3", [], 3, false],
    ["a cursor no Event has reached yet", "?after=99", [], 99, false],
  ])("pages with after and limit: %s (%s)", async (_name, query, expected, next, more) => {
    const reply = await get(`/api/events${query}`);

    expect(reply.status).toBe(200);
    expect(ids(reply)).toEqual(expected);
    expect(reply.body).toMatchObject({ next, more });
  });

  it("sees every Event exactly once when following next until more is false", async () => {
    const seen: number[] = [];
    let page: { next: number; more: boolean } = { next: 0, more: true };
    while (page.more) {
      const reply = await get(`/api/events?after=${page.next}&limit=1`);
      seen.push(...ids(reply));
      page = reply.body as typeof page;
    }

    expect(seen).toEqual([1, 2, 3]);
  });

  it.each([
    ["a time between Events", "2026-10-19T08:01:30.000Z", [2, 3], 3],
    ["the exact time of an Event", "2026-10-19T08:01:00Z", [1, 2, 3], 3],
    ["an offset time", "2026-10-19T10:01:30%2B02:00", [2, 3], 3],
    ["a time after every Event", "2026-10-19T09:00:00Z", [], 3],
  ])("returns only Events at or after since: %s", async (_name, since, expected, next) => {
    const reply = await get(`/api/events?since=${since}`);

    expect(reply.status).toBe(200);
    expect(ids(reply)).toEqual(expected);
    expect(reply.body).toMatchObject({ next, more: false });
  });

  it.each([
    ["a non-integer after", "?after=1.5", "after must be an integer 0 or more"],
    ["a negative after", "?after=-1", "after must be an integer 0 or more"],
    ["a limit of 0", "?limit=0", "limit must be an integer from 1 to 500"],
    ["a limit above 500", "?limit=501", "limit must be an integer from 1 to 500"],
    ["an unparseable since", "?since=yesterday", "since must be an ISO 8601 time, e.g. 2026-10-19T08:00:00Z"],
    ["a since without a time zone", "?since=2026-10-19T08:00:00", "since must be an ISO 8601 time, e.g. 2026-10-19T08:00:00Z"],
    ["after together with since", "?after=1&since=2026-10-19T08:00:00Z", "after cannot be combined with since"],
    ["limit together with since", "?since=2026-10-19T08:00:00Z&limit=5", "limit cannot be combined with since"],
    ["an unknown parameter", "?before=3", "before is not a known parameter (expected one of: after, limit, since)"],
  ])("refuses %s with 400 naming the parameter", async (_name, query, error) => {
    const reply = await get(`/api/events${query}`);

    expect(reply).toMatchObject({ status: 400, body: { error } });
  });
});

/** A Source that reports `items` of one type and `health` once, at start, as an Adapter would through the sink. */
function fixedSource(source: string, type: string, items: HubItem[], health: Health): SourceAdapter {
  return {
    id: source,
    start: async (sink) => {
      await sink.replaceItems(source, type, items);
      await sink.reportHealth(source, health);
    },
    stop: async () => {},
    refresh: async () => {},
  };
}

describe("API: /api/agenda", () => {
  const now = new Date("2026-10-19T08:00:00.000Z");
  const calendar = "google-calendar:primary";
  const todos = "brain-dump:todos";
  const item = (source: string, type: string, id: string, attention: boolean): HubItem => ({
    source,
    type,
    id,
    title: id,
    status: attention ? "ongoing" : "upcoming",
    attention,
    updatedAt: now.toISOString(),
    data: {},
  });
  const ok: Health = { ok: true, at: now.toISOString(), staleAfterMs: 900_000 };
  let api: ApiHub;
  const ids = (list: unknown) => (list as Array<{ source: string; id: string }>).map((i) => `${i.source}/${i.id}`);

  afterEach(() => api.stop());

  it("puts every Item with Attention, from any Source and type, in attention, in a stable order, on the hub's clock", async () => {
    api = await startApiHub(() => now, { working: "working", blocked: "blocked", done: "done" }, [
      fixedSource(calendar, "appointment", [item(calendar, "appointment", "standup", true), item(calendar, "appointment", "lunch", false)], ok),
      fixedSource(todos, "todo", [item(todos, "todo", "write-spec", false)], ok),
    ]);

    const reply = await api.get("/api/agenda");

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ now: now.toISOString(), appointments: [], todos: [], staleSources: [] });
    expect(ids((reply.body as { attention: unknown }).attention)).toEqual([
      `${calendar}/standup`,
      "herdr:local/blocked",
      "herdr:local/done",
    ]);
  });

  it("returns each Item as /api/items does, with sourceOk and lastOkAt", async () => {
    api = await startApiHub(() => now, { blocked: "blocked" });

    const agenda = (await api.get("/api/agenda")).body as { attention: unknown[] };
    const items = (await api.get("/api/items?attention=true")).body as { items: unknown[] };

    expect(agenda.attention).toEqual(items.items);
    expect(agenda.attention).toEqual([expect.objectContaining({ id: "blocked", sourceOk: true, lastOkAt: now.toISOString() })]);
  });

  it("keeps a Stale Source's Items with Attention, marked sourceOk false, and names the Source in staleSources", async () => {
    const failed: Health = { ok: false, at: now.toISOString(), error: "timed out after 10000ms", staleAfterMs: 900_000 };
    api = await startApiHub(() => now, { blocked: "blocked" }, [
      fixedSource(calendar, "appointment", [item(calendar, "appointment", "standup", true)], failed),
    ]);

    const reply = await api.get("/api/agenda");

    expect(reply.body).toMatchObject({
      attention: [
        expect.objectContaining({ source: calendar, id: "standup", sourceOk: false, lastOkAt: null }),
        expect.objectContaining({ source: "herdr:local", id: "blocked", sourceOk: true }),
      ],
      staleSources: [
        { source: calendar, ok: false, at: now.toISOString(), error: "timed out after 10000ms", staleAfterMs: 900_000, lastOkAt: null, healthy: false },
      ],
    });
  });

  it("lists only open Todos in todos, in Weekly Note line order, each keeping its group path and parent", async () => {
    const todo = (id: string, status: string, line: number, groupPath: string[] = [], parentId: string | null = null): HubItem => ({
      ...item(todos, "todo", id, false),
      status,
      data: { note: "Weekly/2026-W43.md", groupPath, line, parentId },
    });
    api = await startApiHub(() => now, {}, [
      fixedSource(
        todos,
        "todo",
        [
          todo("review", "open", 9, ["Work"]),
          todo("ship", "done", 2),
          todo("draft", "open", 7, ["Work"], "spec"),
          todo("spec", "dropped", 6, ["Work"]),
          todo("call", "open", 3),
          todo("errand", "open", 12, ["Home", "Weekend"]),
        ],
        ok,
      ),
    ]);

    const reply = (await api.get("/api/agenda")).body as { todos: Array<{ id: string; status: string; data: unknown }> };

    expect(reply.todos.map((t) => t.id)).toEqual(["call", "draft", "review", "errand"]);
    expect(reply.todos.every((t) => t.status === "open")).toBe(true);
    expect(reply.todos[1]).toMatchObject({
      data: { groupPath: ["Work"], line: 7, parentId: "spec" },
      sourceOk: true,
      lastOkAt: now.toISOString(),
    });
  });

  it("keeps a Stale Source's open Todos, marked sourceOk false", async () => {
    const failed: Health = { ok: false, at: now.toISOString(), error: "brain-dump exited with code 1", staleAfterMs: 180_000 };
    api = await startApiHub(() => now, {}, [
      fixedSource(todos, "todo", [{ ...item(todos, "todo", "call", false), status: "open", data: { groupPath: [], line: 3, parentId: null } }], failed),
    ]);

    const reply = await api.get("/api/agenda");

    expect(reply.body).toMatchObject({
      todos: [expect.objectContaining({ id: "call", sourceOk: false })],
      staleSources: [expect.objectContaining({ source: todos })],
    });
  });

  describe("appointments", () => {
    /** Monday 19 October 2026, 10:00 in the zone the tests run in: the hub's Today is the 19th. */
    const today = new Date(2026, 9, 19, 10);
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const todayOk: Health = { ok: true, at: today.toISOString(), staleAfterMs: 900_000 };
    /** A timed Appointment between two instants, or an all-day one between two dates (end exclusive). */
    const appointment = (id: string, start: string, end: string, attention = false): HubItem => ({
      source: calendar,
      type: "appointment",
      id,
      title: id,
      status: "upcoming",
      attention,
      updatedAt: today.toISOString(),
      data: { allDay: !start.includes("T"), start, end, eventType: "default" },
    });
    const agendaOf = async (appointments: HubItem[], health = todayOk) => {
      api = await startApiHub(() => today, {}, [fixedSource(calendar, "appointment", appointments, health)]);
      return (await api.get("/api/agenda")).body as { attention: unknown; appointments: unknown };
    };

    it.each([
      ["a timed one later Today", at(19, 14), at(19, 15)],
      ["a timed one that ended earlier Today", at(19, 7), at(19, 8)],
      ["an all-day one for Today", "2026-10-19", "2026-10-20"],
      ["a multi-day all-day one covering Today", "2026-10-17", "2026-10-22"],
      ["a meeting that crossed midnight into Today", at(18, 23), at(19, 1)],
      ["a timed one running across all of Today", at(18, 12), at(20, 12)],
    ])("holds %s", async (_name, start, end) => {
      const agenda = await agendaOf([appointment("it", start, end)]);

      expect(ids(agenda.appointments)).toEqual([`${calendar}/it`]);
    });

    it.each([
      ["a timed one Tomorrow", at(20, 9), at(20, 10)],
      ["a timed one starting at midnight", at(20, 0), at(20, 1)],
      ["a timed one that ended at midnight", at(18, 23), at(19, 0)],
      ["an all-day one Tomorrow", "2026-10-20", "2026-10-21"],
      ["an all-day one that ended Yesterday (Google's exclusive end)", "2026-10-18", "2026-10-19"],
    ])("leaves out %s", async (_name, start, end) => {
      const agenda = await agendaOf([appointment("it", start, end)]);

      expect(agenda.appointments).toEqual([]);
    });

    it("orders them all-day first, then by start", async () => {
      const agenda = await agendaOf([
        appointment("late", at(19, 16), at(19, 17)),
        appointment("trip", "2026-10-17", "2026-10-22"),
        appointment("early", at(19, 7), at(19, 8)),
        appointment("holiday", "2026-10-19", "2026-10-20"),
        appointment("overnight", at(18, 23), at(19, 1)),
        appointment("tomorrow", at(20, 9), at(20, 10)),
      ]);

      expect(ids(agenda.appointments)).toEqual([
        `${calendar}/trip`,
        `${calendar}/holiday`,
        `${calendar}/overnight`,
        `${calendar}/early`,
        `${calendar}/late`,
      ]);
    });

    it("lists one with Attention in both attention and appointments, as /api/items returns it", async () => {
      const agenda = await agendaOf([appointment("standup", at(19, 10), at(19, 11), true)]);
      const items = (await api.get("/api/items?type=appointment")).body as { items: unknown[] };

      expect(agenda.attention).toEqual(items.items);
      expect(agenda.appointments).toEqual(items.items);
    });

    it("keeps a Stale Source's Appointments, marked sourceOk false", async () => {
      const failed: Health = { ok: false, at: today.toISOString(), error: "timed out after 10000ms", staleAfterMs: 900_000 };

      const agenda = await agendaOf([appointment("standup", at(19, 14), at(19, 15))], failed);

      expect(agenda.appointments).toEqual([expect.objectContaining({ id: "standup", sourceOk: false })]);
    });
  });

  it("refuses any parameter with 400 naming it", async () => {
    api = await startApiHub(() => now);

    const reply = await api.get("/api/agenda?date=2026-10-20");

    expect(reply).toMatchObject({ status: 400, body: { error: "date is not a known parameter (expected none)" } });
  });

  it.each([
    ["another Host with 403", { host: "evil.example.com" }, 403],
    ["POST with 405", { method: "POST" }, 405],
  ])("passes the shared guards: refuses %s", async (_name, opts, status) => {
    api = await startApiHub(() => now);

    const reply = await api.get("/api/agenda", opts);

    expect(reply).toMatchObject({ status, body: { error: expect.any(String) } });
  });
});

describe("API: /api/measurements", () => {
  const health = "google-health:primary";
  // Local noon, so Today is 2026-10-19 in any system zone.
  const now = new Date(2026, 9, 19, 12);
  const steps = (date: string, value: number) => ({ metric: "steps" as const, date, value });
  let api: ApiHub;

  const start = async (healthReport: Health = { ok: true, at: now.toISOString(), staleAfterMs: 900_000 }) => {
    const source: SourceAdapter = {
      id: health,
      start: async (sink) => {
        await sink.writeMeasurements(health, [
          steps("2026-10-12", 12),
          steps("2026-10-19", 19),
          steps("2026-10-13", 13),
          steps("2026-10-16", 0),
          steps("2026-10-20", 20),
        ]);
        await sink.reportHealth(health, healthReport);
      },
      stop: async () => {},
      refresh: async () => {},
    };
    api = await startApiHub(() => now, {}, [source]);
  };
  const dates = (body: unknown) => (body as { measurements: Array<{ date: string }> }).measurements.map((m) => m.date);

  afterEach(() => api.stop());

  it("returns the 7 days ending Today, by Metric then date, each with its unit and freshness, on the hub's clock", async () => {
    await start();

    const reply = await api.get("/api/measurements");

    expect(reply).toMatchObject({ status: 200 });
    expect(reply.body).toEqual({
      now: now.toISOString(),
      measurements: [
        { source: health, metric: "steps", date: "2026-10-13", value: 13, unit: "count", sourceOk: true, lastOkAt: now.toISOString() },
        { source: health, metric: "steps", date: "2026-10-16", value: 0, unit: "count", sourceOk: true, lastOkAt: now.toISOString() },
        { source: health, metric: "steps", date: "2026-10-19", value: 19, unit: "count", sourceOk: true, lastOkAt: now.toISOString() },
      ],
    });
  });

  it.each([
    ["metric=steps", ["2026-10-13", "2026-10-16", "2026-10-19"]],
    ["from=2026-10-12&to=2026-10-13", ["2026-10-12", "2026-10-13"]],
    ["from=2026-10-16", ["2026-10-16", "2026-10-19"]],
    ["to=2026-10-16", ["2026-10-12", "2026-10-13", "2026-10-16"]],
    ["to=2026-10-12", ["2026-10-12"]],
    ["from=2026-10-16&to=2026-10-16", ["2026-10-16"]],
    ["from=2025-10-20&to=2026-10-20", ["2026-10-12", "2026-10-13", "2026-10-16", "2026-10-19", "2026-10-20"]],
  ])("filters by %s, from and to inclusive, a missing from the 7 days ending to and a missing to Today", async (query, expected) => {
    await start();

    const reply = await api.get(`/api/measurements?${query}`);

    expect(dates(reply.body)).toEqual(expected);
  });

  it("keeps a Stale Source's Measurements, marked sourceOk false", async () => {
    await start({ ok: false, at: now.toISOString(), error: "timed out after 10000ms", staleAfterMs: 900_000 });

    const reply = await api.get("/api/measurements?from=2026-10-19");

    expect(reply.body).toMatchObject({ measurements: [{ date: "2026-10-19", sourceOk: false, lastOkAt: null }] });
  });

  it.each([
    ["metric=weight", "metric must be one of: steps, sleep, resting-heart-rate, active-zone-minutes"],
    ["metric=", "metric must be one of: steps, sleep, resting-heart-rate, active-zone-minutes"],
    ["from=2026-10-1", "from must be a date, e.g. 2026-10-19"],
    ["to=2026-02-30", "to must be a date, e.g. 2026-10-19"],
    ["from=2026-10-19T00:00:00Z", "from must be a date, e.g. 2026-10-19"],
    ["from=2026-10-20&to=2026-10-19", "from must not be after to"],
    ["from=2026-10-20", "from must not be after to"],
    ["from=2025-10-18&to=2026-10-19", "from and to must span at most 366 days"],
    ["to=2026-10-12&from=2026-10-12&day=1", "day is not a known parameter (expected one of: metric, from, to)"],
  ])("refuses %s with 400 naming the parameter", async (query, error) => {
    await start();

    const reply = await api.get(`/api/measurements?${query}`);

    expect(reply).toMatchObject({ status: 400, body: { error } });
  });
});

describe("API: lifecycle", () => {
  let hub: Hub | undefined;
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
  });

  const start = (api: unknown) =>
    startHubFromConfig(parseConfig({ api, sources: {} }), { dbPath: ":memory:", log: () => {} });

  it("starts no server when the config turns the API off", async () => {
    hub = await start(false);

    expect(hub.apiUrl).toBeNull();
  });

  it("listens on 127.0.0.1 only", async () => {
    hub = await start({ port: 0 });

    expect(hub.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("stops listening when the hub stops", async () => {
    const started = await start({ port: 0 });
    await started.stop();

    await expect(request(`${started.apiUrl}/api/items`)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("refuses to start on a taken port, naming it, after stopping what already started", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as net.AddressInfo;
    const stopped: string[] = [];
    const adapter: SourceAdapter = {
      id: "herdr:local",
      start: async () => {},
      stop: async () => void stopped.push("herdr:local"),
      refresh: async () => {},
    };

    try {
      const starting = startHub({ dbPath: ":memory:", adapters: [adapter], eventRetentionDays: 30, api: { port }, log: () => {} });

      await expect(starting).rejects.toThrow(`127.0.0.1:${port}`);
      expect(stopped).toEqual(["herdr:local"]);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });
});
