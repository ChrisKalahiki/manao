import { APPOINTMENT_ITEM_TYPE, appointmentIsToday, appointmentTimeSchema, compareAppointments } from "../appointment.js";
import { addDays, daysBetween, localDate } from "../local-time.js";
import { METRIC_IDS } from "../measurement.js";
import type { StoredEvent } from "../store/events.js";
import type { SourceHealth } from "../store/health.js";
import type { StoredItem } from "../store/items.js";
import type { StoredMeasurement } from "../store/measurements.js";
import type { Store } from "../store/store.js";
import { compareTodoLines, TODO_ITEM_TYPE } from "../todo.js";
import { boolean, integer, isoTime, isoDate, oneOf, ParamError, type Params, text } from "./params.js";

/**
 * The reads every consumer shares (the API's routes, the MCP server's tools):
 * each one's parameters, and the query that applies them to the store. A
 * transport reads the parameters with `readParams` or `paramsSchema` and adds `now`.
 */

export const ITEMS_PARAMS = { type: text, status: text, attention: boolean };

export interface ItemsResult {
  items: StoredItem[];
}

export function listItems(store: Store, params: Params<typeof ITEMS_PARAMS>): ItemsResult {
  return { items: store.items.list(params) };
}

export const EVENTS_PARAMS = { after: integer(0), limit: integer(1, 500), since: isoTime };

export interface EventsResult {
  events: StoredEvent[];
  /** The id to pass as `after` to continue. */
  next: number;
  /** The page was full, so another may be waiting. */
  more: boolean;
}

/**
 * A page of Events after an id, or every Event since a time. When `since`
 * matches nothing, `next` is the newest stored Event's id, so polling from it
 * never replays what came before. `pageSize` is the `limit` when none is given.
 */
export function listEvents(store: Store, params: Params<typeof EVENTS_PARAMS>, pageSize: number): EventsResult {
  const { after, limit, since } = params;
  if (since && (after !== undefined || limit !== undefined)) {
    throw new ParamError(`${after !== undefined ? "after" : "limit"} cannot be combined with since`);
  }
  if (since) {
    const page = store.events.since(since);
    return { events: page, next: page.at(-1)?.id ?? store.events.latestId(), more: false };
  }
  const from = after ?? 0;
  const size = limit ?? pageSize;
  const page = store.events.after(from, size);
  return { events: page, next: page.at(-1)?.id ?? from, more: page.length === size };
}

export const SOURCES_PARAMS = {};

export interface SourcesResult {
  sources: SourceHealth[];
}

export function listSources(store: Store, _params: Params<typeof SOURCES_PARAMS>): SourcesResult {
  return { sources: store.health.list() };
}

export const AGENDA_PARAMS = {};

/** What is on the user's plate Today; the Today view and the `agenda` tool show exactly this. */
export interface AgendaResult {
  /** Every Item with Attention, from any Source and of any type, Stale ones included. */
  attention: StoredItem[];
  /** Every Appointment running at any time Today, ended ones included; all-day first, then by start, then by title. */
  appointments: StoredItem[];
  /** Open Todos in Weekly Note line order; each keeps its group path and parent in `data`. */
  todos: StoredItem[];
  /** The Health of every Source that is not Healthy: what the Agenda may be missing. */
  staleSources: SourceHealth[];
}

/**
 * The Agenda for the Today of `now`. An Item may appear in `attention` and in
 * its own list; none is left out because its Source is Stale.
 */
export function agenda(store: Store, _params: Params<typeof AGENDA_PARAMS>, now: Date): AgendaResult {
  return {
    attention: store.items.list({ attention: true }),
    appointments: todaysAppointments(store, now),
    todos: openTodos(store),
    staleSources: store.health.list().filter((source) => !source.healthy),
  };
}

export const MEASUREMENTS_PARAMS = { metric: oneOf(METRIC_IDS), from: isoDate, to: isoDate };

/** The days `from` and `to` may span, inclusive: a leap year. */
const MAX_MEASUREMENT_DAYS = 366;
/** By default, the week ending `to`. */
const DEFAULT_MEASUREMENT_DAYS = 7;

export interface MeasurementsResult {
  measurements: StoredMeasurement[];
}

/**
 * Measurements from `from` through `to`, local dates: `to` defaults to Today
 * of `now`, `from` to `to` minus 6; ordered by Metric, then date. A missing
 * day has none.
 */
export function listMeasurements(store: Store, params: Params<typeof MEASUREMENTS_PARAMS>, now: Date): MeasurementsResult {
  const to = params.to ?? localDate(now);
  const from = params.from ?? addDays(to, 1 - DEFAULT_MEASUREMENT_DAYS);
  const span = daysBetween(from, to) + 1;
  if (span < 1) throw new ParamError("from must not be after to");
  if (span > MAX_MEASUREMENT_DAYS) throw new ParamError(`from and to must span at most ${MAX_MEASUREMENT_DAYS} days`);
  return { measurements: store.measurements.list({ metric: params.metric, from, to }) };
}

/** An Appointment whose `data` does not read as an AppointmentTime cannot be placed on a day, so it is left out. */
function todaysAppointments(store: Store, now: Date): StoredItem[] {
  return store.items
    .list({ type: APPOINTMENT_ITEM_TYPE })
    .flatMap((item) => {
      const time = appointmentTimeSchema.safeParse(item.data);
      return time.success && appointmentIsToday(time.data, now) ? [{ item, title: item.title, data: time.data }] : [];
    })
    .sort(compareAppointments)
    .map(({ item }) => item);
}

/** Open Todos in Weekly Note line order; one without a numeric `line` goes last. */
function openTodos(store: Store): StoredItem[] {
  return store.items.list({ type: TODO_ITEM_TYPE, status: "open" }).sort(compareTodoLines);
}
