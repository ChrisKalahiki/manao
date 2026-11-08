import { readParams } from "../query/params.js";
import {
  AGENDA_PARAMS,
  type AgendaResult,
  agenda,
  EVENTS_PARAMS,
  type EventsResult,
  ITEMS_PARAMS,
  type ItemsResult,
  listEvents,
  listItems,
  listMeasurements,
  listSources,
  MEASUREMENTS_PARAMS,
  type MeasurementsResult,
  SOURCES_PARAMS,
  type SourcesResult,
} from "../query/queries.js";
import type { Store } from "../store/store.js";

/**
 * Answers a GET that passed every guard. Reads its parameters with
 * `readParams` and returns the body as of `now`, the hub's clock; the server
 * adds `now` to it.
 */
export type Route = (
  query: URLSearchParams,
  store: Store,
  now: Date,
) => ItemsResult | EventsResult | SourcesResult | AgendaResult | MeasurementsResult;

const EVENTS_PAGE_SIZE = 100;

/** Every endpoint, by exact path. All are read-only. */
export const ROUTES = new Map<string, Route>([
  ["/api/items", (query, store) => listItems(store, readParams(query, ITEMS_PARAMS))],
  ["/api/events", (query, store) => listEvents(store, readParams(query, EVENTS_PARAMS), EVENTS_PAGE_SIZE)],
  ["/api/sources", (query, store) => listSources(store, readParams(query, SOURCES_PARAMS))],
  ["/api/agenda", (query, store, now) => agenda(store, readParams(query, AGENDA_PARAMS), now)],
  ["/api/measurements", (query, store, now) => listMeasurements(store, readParams(query, MEASUREMENTS_PARAMS), now)],
]);
