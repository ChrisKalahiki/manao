import { createRequire } from "node:module";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { METRIC_IDS } from "../measurement.js";
import { paramsSchema } from "../query/params.js";
import {
  AGENDA_PARAMS,
  agenda,
  EVENTS_PARAMS,
  ITEMS_PARAMS,
  listEvents,
  listItems,
  listMeasurements,
  listSources,
  MEASUREMENTS_PARAMS,
  SOURCES_PARAMS,
} from "../query/queries.js";
import type { StoredEvent } from "../store/events.js";
import type { SourceHealth } from "../store/health.js";
import type { StoredItem } from "../store/items.js";
import type { StoredMeasurement } from "../store/measurements.js";
import type { Store } from "../store/store.js";
import { type LazyStore, lazyStore } from "./store.js";

export interface McpOptions {
  /**
   * Finds the hub's store, which is opened read-only (ADR 0001). Called on
   * each tool call until the store opens; what it throws, such as a config
   * that cannot be read, is that call's tool error.
   */
  dbPath: () => string;
  /** The server's clock; every result carries it as `now`. */
  now?: () => Date;
}

/** The read-only MCP server over the hub's store. */
export interface ManaoMcp {
  /** Builds a server instance; every instance shares one lazily opened store. */
  newServer(): McpServer;
  /** Closes the store if it was opened. */
  close(): void;
}

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };

/** Names every field of `T`, so a field the store adds and the schema leaves out fails typecheck. */
type ShapeOf<T> = Record<keyof T, z.ZodType>;

const ITEM = z.object({
  source: z.string(),
  type: z.string(),
  id: z.string(),
  title: z.string(),
  status: z.string(),
  attention: z.boolean(),
  updatedAt: z.string(),
  data: z.unknown(),
  sourceOk: z.boolean(),
  lastOkAt: z.string().nullable(),
} satisfies ShapeOf<StoredItem>) satisfies z.ZodType<StoredItem>;

const EVENT = z.object({
  id: z.number(),
  source: z.string(),
  kind: z.string(),
  at: z.string(),
  data: z.unknown(),
} satisfies ShapeOf<StoredEvent>) satisfies z.ZodType<StoredEvent>;

/** Smaller than the API's 100, so a page arrives whole: Claude Code cuts tool text beyond about 11k characters. */
const EVENTS_PAGE_SIZE = 25;

const SOURCE = z.object({
  source: z.string(),
  ok: z.boolean(),
  at: z.string(),
  error: z.string().optional(),
  note: z.string().optional(),
  staleAfterMs: z.number(),
  lastOkAt: z.string().nullable(),
  healthy: z.boolean(),
} satisfies ShapeOf<SourceHealth>) satisfies z.ZodType<SourceHealth>;

const MEASUREMENT = z.object({
  source: z.string(),
  metric: z.enum(METRIC_IDS),
  date: z.string(),
  value: z.number(),
  unit: z.string(),
  sourceOk: z.boolean(),
  lastOkAt: z.string().nullable(),
} satisfies ShapeOf<StoredMeasurement>);

export function manaoMcp(opts: McpOptions): ManaoMcp {
  const clock = opts.now ?? (() => new Date());
  let store: LazyStore | undefined;
  const openStore = (): Store => {
    store ??= lazyStore(opts.dbPath(), clock);
    return store.get();
  };

  /**
   * Runs `query` against the store as of one reading of the clock and shapes
   * its result: that `now` added, and the text led by a Stale warning when a
   * Source is not Healthy. `stale` names any further Sources the result itself
   * shows as Stale. A store that cannot be opened throws, which the SDK
   * returns as a tool error.
   */
  const answer = <R extends object>(
    query: (store: Store, now: Date) => R,
    stale: (result: R) => StaleSource[] = () => [],
  ): CallToolResult => {
    const open = openStore();
    const now = clock();
    const result = query(open, now);
    const body = { now: now.toISOString(), ...result };
    const warning = staleWarning([...open.health.list().filter((s) => !s.healthy), ...stale(result)]);
    const json = JSON.stringify(body);
    return { structuredContent: body, content: [{ type: "text", text: warning ? `${warning}\n\n${json}` : json }] };
  };

  return {
    newServer: () => {
      const server = new McpServer({ name: "manao", version });
      server.registerTool(
        "list_items",
        {
          title: "List Items",
          description:
            "What is on the user's plate now: agents, tasks and other Items from every Source, optionally filtered. " +
            "Attention marks an Item that needs the user now. sourceOk false means the Item is Stale (its Source is not Healthy) " +
            "and shows last known state, not current state; lastOkAt is when its Source last reported success.",
          inputSchema: paramsSchema(ITEMS_PARAMS),
          outputSchema: z.object({ now: z.string(), items: z.array(ITEM) }),
          annotations: { readOnlyHint: true },
        },
        (params) => answer(
          (s) => listItems(s, params),
          ({ items }) => items.filter((item) => !item.sourceOk),
        ),
      );
      server.registerTool(
        "list_events",
        {
          title: "List Events",
          description:
            "What changed: Events, such as an agent's Status changing, in id order. Page with after (an Event id, default 0) " +
            `and limit (1 to 500, default ${EVENTS_PAGE_SIZE}, smaller than the API's because clients cut long tool results); ` +
            "pass next as after to continue, and more is true when the page was full, so another may be waiting. " +
            "Or pass since alone (an ISO 8601 time with Z or an offset) for every Event at or after it.",
          inputSchema: paramsSchema(EVENTS_PARAMS),
          outputSchema: z.object({ now: z.string(), events: z.array(EVENT), next: z.number(), more: z.boolean() }),
          annotations: { readOnlyHint: true },
        },
        (params) => answer((s) => listEvents(s, params, EVENTS_PAGE_SIZE)),
      );
      server.registerTool(
        "list_sources",
        {
          title: "List Sources",
          description:
            "Whether the hub is working: each Source that has reported, with its latest Health report (ok, at, error), " +
            "lastOkAt (its last success) and healthy. A Source is Healthy when its latest report is ok and no older than staleAfterMs; " +
            "Items from a Source that is not Healthy are Stale.",
          inputSchema: paramsSchema(SOURCES_PARAMS),
          outputSchema: z.object({ now: z.string(), sources: z.array(SOURCE) }),
          annotations: { readOnlyHint: true },
        },
        (params) => answer((s) => listSources(s, params)),
      );
      server.registerTool(
        "agenda",
        {
          title: "Agenda",
          description:
            "What is on the user's plate Today, exactly as their dashboard's Today view shows it: attention (every Item that needs " +
            "the user now, from any Source), appointments (Today's), todos (open ones) and staleSources (the Health of each Source " +
            "that is not Healthy, so the Agenda may be missing what it knows). An Item may appear in attention and in its own list. " +
            "sourceOk false means the Item is Stale and shows last known state, not current state.",
          inputSchema: paramsSchema(AGENDA_PARAMS),
          outputSchema: z.object({
            now: z.string(),
            attention: z.array(ITEM),
            appointments: z.array(ITEM),
            todos: z.array(ITEM),
            staleSources: z.array(SOURCE),
          }),
          annotations: { readOnlyHint: true },
        },
        (params) =>
          answer(
            (s, now) => agenda(s, params, now),
            ({ attention, appointments, todos }) => [...attention, ...appointments, ...todos].filter((item) => !item.sourceOk),
          ),
      );
      server.registerTool(
        "list_measurements",
        {
          title: "List Measurements",
          description:
            "The user's daily health values: one Measurement per Metric per day (a local date, YYYY-MM-DD), each with its unit. " +
            `Metrics: ${METRIC_IDS.join(", ")}. Optionally filter by metric; from and to are inclusive dates, to by default Today and ` +
            "from the 7 days ending to, at most 366 days apart. Ordered by metric, then date. A day with no data has no Measurement, which is " +
            "not a value of zero; Today's value can still grow. sourceOk false means the Measurement is Stale (its Source is not Healthy).",
          inputSchema: paramsSchema(MEASUREMENTS_PARAMS),
          outputSchema: z.object({ now: z.string(), measurements: z.array(MEASUREMENT) }),
          annotations: { readOnlyHint: true },
        },
        (params) =>
          answer(
            (s, now) => listMeasurements(s, params, now),
            ({ measurements }) => measurements.filter((measurement) => !measurement.sourceOk),
          ),
      );
      return server;
    },
    close: () => store?.close(),
  };
}

interface StaleSource {
  source: string;
  lastOkAt: string | null;
}

/** One sentence per Source that is not Healthy, saying since when; empty when there is none. */
function staleWarning(stale: readonly StaleSource[]): string {
  const lastOk = new Map<string, string | null>();
  for (const { source, lastOkAt } of stale) if (!lastOk.has(source)) lastOk.set(source, lastOkAt);
  if (lastOk.size === 0) return "";
  const sentences = [...lastOk].map(([source, at]) =>
    at ? `${source} is not Healthy; it last reported success at ${at}.` : `${source} has never reported success.`,
  );
  return `Stale: ${sentences.join(" ")} Data from ${lastOk.size === 1 ? "it" : "them"} below is last known, not current.`;
}
