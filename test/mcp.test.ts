import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import Database from "better-sqlite3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startApi } from "../src/api/server.js";
import type { HubItem } from "../src/core/types.js";
import { type ManaoMcp, manaoMcp } from "../src/mcp/server.js";
import { PaperBotAdapter } from "../src/paper-bot/adapter.js";
import { openStore, type Store } from "../src/store/store.js";
import { buildDist } from "./helpers.js";
import { fakePaperBot, T0 as PAPER_T0 } from "./paper-bot-helper.js";

const T0 = "2026-10-19T08:00:00.000Z";
const STALE_AFTER_MS = 15_000;

function agent(id: string, status: string, attention: boolean): HubItem {
  return { source: "herdr:local", type: "agent", id, title: id, status, attention, updatedAt: T0, data: {} };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/**
 * A store on disk written as the hub would, and the MCP server reading it
 * read-only through an in-process client, both on a clock the test moves.
 */
class Harness {
  readonly dir = mkdtempSync(path.join(os.tmpdir(), "manao-mcp-"));
  readonly dbPath = path.join(this.dir, "hub.db");
  clock = new Date(T0);
  /** How the server finds the store; a test replaces it to stand in for a config that cannot be read. */
  dbPathOf: () => string = () => this.dbPath;
  private readonly now = () => this.clock;
  private hub?: Store;
  private mcp?: ManaoMcp;
  private client?: Client;
  private handler?: ReturnType<typeof createMcpHandler>;

  /** Stands in for the hub: creates the store and keeps it open for writing. */
  writer(): Store {
    this.hub ??= openStore(this.dbPath, { now: this.now });
    return this.hub;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return (await (await this.connect()).callTool({ name, arguments: args })) as ToolResult;
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    const mcp = manaoMcp({ dbPath: () => this.dbPathOf(), now: this.now });
    this.mcp = mcp;
    this.handler = createMcpHandler(() => mcp.newServer());
    const handler = this.handler;
    const transport = new StreamableHTTPClientTransport(new URL("http://manao.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client({ name: "manao-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  async close(): Promise<void> {
    await this.client?.close();
    await this.handler?.close();
    this.mcp?.close();
    this.hub?.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

describe("MCP: opening the store", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness();
  });
  afterEach(() => h.close());

  it("returns a tool error naming the path while there is no store", async () => {
    const result = await h.call("list_items");

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: `no store at ${h.dbPath}; has \`manao run\` ever run?` }],
    });
  });

  it("answers once the hub has created the store, without restarting", async () => {
    await h.call("list_items");
    h.writer().replaceItems("herdr:local", "agent", [agent("working", "running", false)]);

    const result = await h.call("list_items");

    expect(result.structuredContent).toMatchObject({ items: [expect.objectContaining({ id: "working" })] });
  });

  it("returns a tool error naming the path while the hub has not written the schema yet, then answers once it has", async () => {
    new Database(h.dbPath).close();

    const early = await h.call("list_items");
    h.writer().replaceItems("herdr:local", "agent", [agent("working", "running", false)]);
    const later = await h.call("list_items");

    expect(early).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining(`cannot read the store at ${h.dbPath}: it has no schema yet`) }],
    });
    expect(later.structuredContent).toMatchObject({ items: [expect.objectContaining({ id: "working" })] });
  });

  it("returns the error that finding the store raised as a tool error, then answers once it can find it", async () => {
    h.writer().replaceItems("herdr:local", "agent", [agent("working", "running", false)]);
    h.dbPathOf = () => {
      throw new Error("Invalid config /etc/manao.json: dbPath must be an absolute path");
    };

    const early = await h.call("list_items");
    h.dbPathOf = () => h.dbPath;
    const later = await h.call("list_items");

    expect(early).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("Invalid config /etc/manao.json: dbPath must be an absolute path") }],
    });
    expect(later.structuredContent).toMatchObject({ items: [expect.objectContaining({ id: "working" })] });
  });

  it("returns a tool error naming the path for a store newer than it reads", async () => {
    h.writer().close();
    const newer = new Database(h.dbPath);
    newer.pragma("user_version = 3");
    newer.close();

    const result = await h.call("list_items");

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining(`cannot read the store at ${h.dbPath}: schema version 3 is newer than this manao reads (2)`) }],
    });
  });
});

describe("MCP: list_items", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness();
    const hub = h.writer();
    hub.replaceItems("herdr:local", "agent", [
      agent("blocked", "needs_attention", true),
      agent("done", "finished", true),
      agent("working", "running", false),
    ]);
    hub.reportHealth("herdr:local", { ok: true, at: T0, staleAfterMs: STALE_AFTER_MS });
  });
  afterEach(() => h.close());

  it("lists Items with Attention and freshness, on the server's clock", async () => {
    const result = await h.call("list_items");

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      now: T0,
      items: [
        expect.objectContaining({ id: "blocked", status: "needs_attention", attention: true, sourceOk: true, lastOkAt: T0 }),
        expect.objectContaining({ id: "done", status: "finished", attention: true, sourceOk: true, lastOkAt: T0 }),
        expect.objectContaining({ id: "working", status: "running", attention: false, sourceOk: true, lastOkAt: T0 }),
      ],
    });
  });

  it.each([
    ["type", { type: "agent" }, ["blocked", "done", "working"]],
    ["type", { type: "task" }, []],
    ["status", { status: "running" }, ["working"]],
    ["attention", { attention: true }, ["blocked", "done"]],
    ["attention", { attention: false }, ["working"]],
    ["every filter at once", { type: "agent", status: "finished", attention: true }, ["done"]],
  ])("narrows the Items by %s (%o)", async (_name, args, ids) => {
    const result = await h.call("list_items", args);

    expect((result.structuredContent as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(ids);
  });

  it.each([
    ["a non-boolean attention", { attention: "true" }, "attention: must be true or false"],
    ["an unknown argument", { sort: "title" }, "sort is not a known parameter (expected one of: type, status, attention)"],
    ["an empty value", { status: "" }, "status: must not be empty"],
  ])("refuses %s with an error naming the parameter", async (_name, args, error) => {
    const result = await h.call("list_items", args);

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining(error) }] });
  });

  it("starts its text with the JSON when every Source is Healthy", async () => {
    const result = await h.call("list_items");

    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
  });

  it("warns first, naming the Source and its last success, once its Health goes old", async () => {
    h.clock = new Date(Date.parse(T0) + STALE_AFTER_MS + 1);

    const result = await h.call("list_items");

    expect(result.content[0]?.text).toMatch(
      /^Stale: herdr:local is not Healthy; it last reported success at 2026-10-19T08:00:00\.000Z\. Data from it below is last known, not current\.\n\n\{/,
    );
  });

  it("names a Source that has never been Healthy", async () => {
    h.writer().reportHealth("herdr:work", { ok: false, at: T0, error: "socket gone", staleAfterMs: STALE_AFTER_MS });

    const result = await h.call("list_items");

    expect(result.content[0]?.text).toMatch(/^Stale: herdr:work has never reported success\./);
  });

  it("is listed as read-only, with input and output schemas", async () => {
    const { tools } = await (await h.connect()).listTools();

    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "list_items",
        annotations: expect.objectContaining({ readOnlyHint: true }),
        inputSchema: expect.objectContaining({ properties: expect.objectContaining({ attention: { type: "boolean" } }) }),
        outputSchema: expect.objectContaining({ required: ["now", "items"] }),
      }),
    );
  });
});

describe("MCP: list_events", () => {
  let h: Harness;
  const ids = (result: ToolResult) => (result.structuredContent as { events: Array<{ id: number }> }).events.map((e) => e.id);
  /** Moves the clock to `time`, then has the hub record one Event per terminal id. */
  const recordAt = (time: string, ...terminalIds: string[]) => {
    h.clock = new Date(time);
    h.writer().emitEvents(terminalIds.map((terminalId) => ({ source: "herdr:local", kind: "agent.status", at: time, data: { terminalId } })));
  };

  beforeEach(() => {
    h = new Harness();
    recordAt("2026-10-19T08:01:00.000Z", "a");
    recordAt("2026-10-19T08:02:00.000Z", "b", "c");
    h.writer().reportHealth("herdr:local", { ok: true, at: h.clock.toISOString(), staleAfterMs: STALE_AFTER_MS });
  });
  afterEach(() => h.close());

  it("returns the Events in id order, on the server's clock", async () => {
    const result = await h.call("list_events");

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      now: "2026-10-19T08:02:00.000Z",
      events: [
        { id: 1, source: "herdr:local", kind: "agent.status", at: "2026-10-19T08:01:00.000Z", data: { terminalId: "a" } },
        { id: 2, source: "herdr:local", kind: "agent.status", at: "2026-10-19T08:02:00.000Z", data: { terminalId: "b" } },
        { id: 3, source: "herdr:local", kind: "agent.status", at: "2026-10-19T08:02:00.000Z", data: { terminalId: "c" } },
      ],
      next: 3,
      more: false,
    });
  });

  it.each([
    ["a page that fills the limit", { limit: 2 }, [1, 2], 2, true],
    ["the page after it", { after: 2, limit: 2 }, [3], 3, false],
    ["a page past the last Event", { after: 3 }, [], 3, false],
    ["a cursor no Event has reached yet", { after: 99 }, [], 99, false],
  ])("pages with after and limit: %s (%o)", async (_name, args, expected, next, more) => {
    const result = await h.call("list_events", args);

    expect(ids(result)).toEqual(expected);
    expect(result.structuredContent).toMatchObject({ next, more });
  });

  it("sees every Event exactly once when following next until more is false", async () => {
    const seen: number[] = [];
    let page = { next: 0, more: true };
    while (page.more) {
      const result = await h.call("list_events", { after: page.next, limit: 1 });
      seen.push(...ids(result));
      page = result.structuredContent as typeof page;
    }

    expect(seen).toEqual([1, 2, 3]);
  });

  it("returns at most 25 Events without a limit, and says more may be waiting", async () => {
    recordAt("2026-10-19T08:03:00.000Z", ...Array.from({ length: 30 }, (_, i) => `t${i}`));

    const result = await h.call("list_events");

    expect(ids(result)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(result.structuredContent).toMatchObject({ next: 25, more: true });
  });

  it.each([
    ["a time between Events", "2026-10-19T08:01:30.000Z", [2, 3], 3],
    ["the exact time of an Event", "2026-10-19T08:01:00Z", [1, 2, 3], 3],
    ["an offset time", "2026-10-19T10:01:30+02:00", [2, 3], 3],
    ["a time after every Event", "2026-10-19T09:00:00Z", [], 3],
  ])("returns only Events at or after since: %s", async (_name, since, expected, next) => {
    const result = await h.call("list_events", { since });

    expect(ids(result)).toEqual(expected);
    expect(result.structuredContent).toMatchObject({ next, more: false });
  });

  it.each([
    ["a non-integer after", { after: 1.5 }, "after: must be an integer 0 or more"],
    ["a negative after", { after: -1 }, "after: must be an integer 0 or more"],
    ["a limit of 0", { limit: 0 }, "limit: must be an integer from 1 to 500"],
    ["a limit above 500", { limit: 501 }, "limit: must be an integer from 1 to 500"],
    ["an unparseable since", { since: "yesterday" }, "since: must be an ISO 8601 time, e.g. 2026-10-19T08:00:00Z"],
    ["after together with since", { after: 1, since: "2026-10-19T08:00:00Z" }, "after cannot be combined with since"],
    ["limit together with since", { since: "2026-10-19T08:00:00Z", limit: 5 }, "limit cannot be combined with since"],
    ["an unknown argument", { before: 3 }, "before is not a known parameter (expected one of: after, limit, since)"],
  ])("refuses %s with an error naming the parameter", async (_name, args, error) => {
    const result = await h.call("list_events", args);

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining(error) }] });
  });

  it("warns first when a Source is not Healthy", async () => {
    h.clock = new Date(Date.parse("2026-10-19T08:02:00.000Z") + STALE_AFTER_MS + 1);

    const result = await h.call("list_events");

    expect(result.content[0]?.text).toMatch(/^Stale: herdr:local is not Healthy; it last reported success at 2026-10-19T08:02:00\.000Z\./);
  });

  it("is listed as read-only, with input and output schemas", async () => {
    const { tools } = await (await h.connect()).listTools();

    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "list_events",
        description: expect.stringContaining("default 25"),
        annotations: expect.objectContaining({ readOnlyHint: true }),
        inputSchema: expect.objectContaining({ properties: expect.objectContaining({ after: expect.anything(), limit: expect.anything(), since: expect.anything() }) }),
        outputSchema: expect.objectContaining({ required: ["now", "events", "next", "more"] }),
      }),
    );
  });
});

describe("MCP: list_sources", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness();
    h.writer().reportHealth("herdr:local", { ok: true, at: T0, staleAfterMs: STALE_AFTER_MS });
  });
  afterEach(() => h.close());

  it("shows a Source with a recent ok report as Healthy, with no warning", async () => {
    const result = await h.call("list_sources");

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      now: T0,
      sources: [{ source: "herdr:local", ok: true, at: T0, staleAfterMs: STALE_AFTER_MS, lastOkAt: T0, healthy: true }],
    });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
  });

  it("shows a failed report as not Healthy with its error, keeps the last success, and warns naming the Source", async () => {
    const failedAt = "2026-10-19T08:00:05.000Z";
    h.clock = new Date(failedAt);
    h.writer().reportHealth("herdr:local", { ok: false, at: failedAt, error: "socket gone", staleAfterMs: STALE_AFTER_MS });

    const result = await h.call("list_sources");

    expect(result.structuredContent).toEqual({
      now: failedAt,
      sources: [
        { source: "herdr:local", ok: false, at: failedAt, error: "socket gone", staleAfterMs: STALE_AFTER_MS, lastOkAt: T0, healthy: false },
      ],
    });
    expect(result.content[0]?.text).toMatch(
      /^Stale: herdr:local is not Healthy; it last reported success at 2026-10-19T08:00:00\.000Z\./,
    );
  });

  it("shows an ok report older than its staleness limit as not Healthy", async () => {
    h.clock = new Date(Date.parse(T0) + STALE_AFTER_MS + 1);

    const result = await h.call("list_sources");

    expect(result.structuredContent).toMatchObject({ sources: [{ source: "herdr:local", ok: true, healthy: false }] });
    expect(result.content[0]?.text).toMatch(/^Stale: herdr:local is not Healthy;/);
  });

  it("refuses any argument with an error naming it", async () => {
    const result = await h.call("list_sources", { source: "herdr:local" });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("source is not a known parameter (expected none)") }],
    });
  });

  it("is listed as read-only, with input and output schemas", async () => {
    const { tools } = await (await h.connect()).listTools();

    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "list_sources",
        annotations: expect.objectContaining({ readOnlyHint: true }),
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ required: ["now", "sources"] }),
      }),
    );
  });
});

describe("MCP: agenda", () => {
  let h: Harness;
  const calendar = "google-calendar:primary";

  beforeEach(() => {
    h = new Harness();
    const hub = h.writer();
    hub.replaceItems("herdr:local", "agent", [agent("blocked", "needs_attention", true), agent("working", "running", false)]);
    hub.reportHealth("herdr:local", { ok: true, at: T0, staleAfterMs: STALE_AFTER_MS });
    hub.replaceItems(calendar, "appointment", [
      { source: calendar, type: "appointment", id: "standup", title: "Standup", status: "ongoing", attention: true, updatedAt: T0, data: {} },
    ]);
    hub.reportHealth(calendar, { ok: false, at: T0, error: "timed out after 10000ms", staleAfterMs: 900_000 });
  });
  afterEach(() => h.close());

  it("returns the same Agenda as GET /api/agenda for the same store and clock", async () => {
    const api = await startApi({ store: h.writer(), port: 0, now: () => h.clock, dashboardDir: h.dir, log: () => {} });
    try {
      const endpoint = await (await fetch(`${api.url}/api/agenda`)).json();

      const result = await h.call("agenda");

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(endpoint);
      expect(result.structuredContent).toMatchObject({
        now: T0,
        attention: [
          expect.objectContaining({ source: calendar, id: "standup", sourceOk: false }),
          expect.objectContaining({ source: "herdr:local", id: "blocked", sourceOk: true }),
        ],
        appointments: [],
        todos: [],
        staleSources: [expect.objectContaining({ source: calendar, healthy: false })],
      });
    } finally {
      await api.close();
    }
  });

  it("starts its text with the Stale warning naming each Source that is not Healthy", async () => {
    const result = await h.call("agenda");

    expect(result.content[0]?.text).toMatch(
      /^Stale: google-calendar:primary has never reported success\. Data from it below is last known, not current\.\n\n\{/,
    );
  });

  it("refuses any argument with an error naming it", async () => {
    const result = await h.call("agenda", { date: "2026-10-20" });

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("date is not a known parameter (expected none)") }],
    });
  });

  it("is listed as read-only, with input and output schemas", async () => {
    const { tools } = await (await h.connect()).listTools();

    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "agenda",
        annotations: expect.objectContaining({ readOnlyHint: true }),
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ required: ["now", "attention", "appointments", "todos", "staleSources"] }),
      }),
    );
  });
});

describe("MCP: paper-bot's Picks", () => {
  let h: Harness;
  let adapter: PaperBotAdapter;

  beforeEach(async () => {
    h = new Harness();
    h.clock = new Date(PAPER_T0);
    adapter = new PaperBotAdapter({ command: fakePaperBot(h.dir).command, now: () => h.clock });
    await adapter.start(h.writer());
  });
  afterEach(async () => {
    await adapter.stop();
    await h.close();
  });

  it("lists this week's Picks as paper Items through list_items", async () => {
    // #when
    const result = await h.call("list_items", { type: "paper" });

    // #then
    expect(result.structuredContent).toEqual({
      now: PAPER_T0,
      items: [
        expect.objectContaining({ source: "paper-bot:picks", id: "paper-bot:arxiv:2610.32109", status: "picked", attention: false, sourceOk: true }),
        expect.objectContaining({ source: "paper-bot:picks", id: "paper-bot:arxiv:2610.30001", status: "kept", attention: false, sourceOk: true }),
      ],
    });
  });

  it("keeps the Picks out of agenda", async () => {
    // #when
    const result = await h.call("agenda");

    // #then
    expect(result.structuredContent).toEqual({ now: PAPER_T0, attention: [], appointments: [], todos: [], staleSources: [] });
  });
});

describe("MCP: list_measurements", () => {
  let h: Harness;
  const health = "google-health:primary";

  beforeEach(() => {
    h = new Harness();
    // Local noon, so Today is 2026-10-19 in any system zone.
    h.clock = new Date(2026, 9, 19, 12);
    const hub = h.writer();
    hub.writeMeasurements(health, [
      { metric: "steps", date: "2026-10-12", value: 12 },
      { metric: "steps", date: "2026-10-18", value: 0 },
      { metric: "steps", date: "2026-10-19", value: 3416 },
    ]);
    hub.reportHealth(health, { ok: false, at: h.clock.toISOString(), error: "timed out after 10000ms", staleAfterMs: 900_000 });
  });
  afterEach(() => h.close());

  it.each([
    ["no arguments", {}, "", ["2026-10-18", "2026-10-19"]],
    ["a range", { metric: "steps", from: "2026-10-12", to: "2026-10-18" }, "?metric=steps&from=2026-10-12&to=2026-10-18", ["2026-10-12", "2026-10-18"]],
  ])("returns the same body as GET /api/measurements for %s", async (_name, args, query, dates) => {
    const api = await startApi({ store: h.writer(), port: 0, now: () => h.clock, dashboardDir: h.dir, log: () => {} });
    try {
      const endpoint = await (await fetch(`${api.url}/api/measurements${query}`)).json();

      const result = await h.call("list_measurements", args);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual(endpoint);
      expect(endpoint).toMatchObject({
        measurements: dates.map((date) => expect.objectContaining({ date, unit: "count", sourceOk: false })),
      });
    } finally {
      await api.close();
    }
  });

  it("starts its text with the Stale warning naming the Source", async () => {
    const result = await h.call("list_measurements");

    expect(result.content[0]?.text).toMatch(
      /^Stale: google-health:primary has never reported success\. Data from it below is last known, not current\.\n\n\{/,
    );
  });

  it.each([
    ["an unknown Metric", { metric: "weight" }, "metric: must be one of: steps, sleep, resting-heart-rate, active-zone-minutes"],
    ["a malformed date", { from: "2026-10-1" }, "from: must be a date, e.g. 2026-10-19"],
    ["from after to", { from: "2026-10-19", to: "2026-10-18" }, "from must not be after to"],
    ["a range over 366 days", { from: "2025-10-18", to: "2026-10-19" }, "from and to must span at most 366 days"],
    ["an unknown argument", { day: "2026-10-19" }, "day is not a known parameter (expected one of: metric, from, to)"],
  ])("refuses %s with an error naming the parameter", async (_name, args, error) => {
    const result = await h.call("list_measurements", args);

    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining(error) }] });
  });

  it("is listed as read-only, with input and output schemas", async () => {
    const { tools } = await (await h.connect()).listTools();

    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "list_measurements",
        annotations: expect.objectContaining({ readOnlyHint: true }),
        inputSchema: expect.objectContaining({ type: "object" }),
        outputSchema: expect.objectContaining({ required: ["now", "measurements"] }),
      }),
    );
  });
});

/**
 * Runs `node <args>`, writes each message to its stdin as one line, and
 * returns every line of its stdout once a whole line answers `lastId`.
 */
function converse(args: string[], env: Record<string, string>, messages: object[], lastId: number): Promise<string[]> {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const whole = stdout.split("\n").slice(0, -1);
    if (whole.some((line) => line.includes(`"id":${lastId}`))) child.stdin.end();
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve(stdout.split("\n").filter((line) => line !== "")));
  });
}

describe("MCP: manao mcp over stdio", () => {
  let h: Harness;

  beforeAll(() => {
    buildDist();
  }, 60_000);
  beforeEach(() => {
    h = new Harness();
    h.writer().replaceItems("herdr:local", "agent", [agent("working", "running", false)]);
  });
  afterEach(() => h.close());

  it("serves list_items from the store MANAO_DB names, writing only protocol messages to stdout", async () => {
    const lines = await converse(["dist/cli.js", "mcp"], { MANAO_DB: h.dbPath, MANAO_CONFIG: path.join(h.dir, "config.json") }, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "manao-test", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_items", arguments: {} } },
    ], 2);

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ jsonrpc: "2.0", id: 1, result: expect.objectContaining({ serverInfo: expect.objectContaining({ name: "manao" }) }) }),
      expect.objectContaining({
        jsonrpc: "2.0",
        id: 2,
        result: expect.objectContaining({ structuredContent: expect.objectContaining({ items: [expect.objectContaining({ id: "working" })] }) }),
      }),
    ]);
  });

  it("starts with a config it cannot read, and names the config and the field in each tool result", async () => {
    const configPath = path.join(h.dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ eventRetentionDays: 0 }));

    const lines = await converse(["dist/cli.js", "mcp"], { MANAO_CONFIG: configPath }, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "manao-test", version: "1.0.0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_items", arguments: {} } },
    ], 2);

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ id: 1, result: expect.objectContaining({ serverInfo: expect.objectContaining({ name: "manao" }) }) }),
      expect.objectContaining({
        id: 2,
        result: expect.objectContaining({
          isError: true,
          content: [{ type: "text", text: expect.stringContaining(`Invalid config ${configPath}: eventRetentionDays`) }],
        }),
      }),
    ]);
  });
});
