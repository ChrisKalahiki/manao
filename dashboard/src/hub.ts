/** The `/api` bodies the dashboard reads, as the hub sends them. */

export interface SourceHealth {
  source: string;
  ok: boolean;
  /** When the Source last reported. */
  at: string;
  error?: string;
  note?: string;
  staleAfterMs: number;
  /** null if the Source has never reported success. */
  lastOkAt: string | null;
  healthy: boolean;
}

/** One Item from `/api/items`, with whether its Source is Healthy now: the store's `StoredItem` on the wire. */
export interface StoredItem {
  source: string;
  type: string;
  id: string;
  title: string;
  status: string;
  attention: boolean;
  updatedAt: string;
  data: unknown;
  /** false means the Item is Stale: render it as last known. */
  sourceOk: boolean;
  lastOkAt: string | null;
}

export interface ItemsResponse {
  now: string;
  items: StoredItem[];
}

export interface SourcesResponse {
  /** The hub's clock; the only one ages are measured against. */
  now: string;
  sources: SourceHealth[];
}

/** One Metric's value for one local date, from `/api/measurements`. A day with no data has none. */
export interface StoredMeasurement {
  source: string;
  metric: string;
  /** A local date, `YYYY-MM-DD`; a night's sleep belongs to the day the user woke up. */
  date: string;
  value: number;
  unit: string;
  /** false means the Measurement is Stale: render it as last known. */
  sourceOk: boolean;
  lastOkAt: string | null;
}

/** `/api/measurements` with its defaults: the 7 days ending Today, by Metric, then date. */
export interface MeasurementsResponse {
  now: string;
  measurements: StoredMeasurement[];
}

/** `/api/agenda`: what is on the user's plate Today, already selected by the hub. */
export interface AgendaResponse {
  now: string;
  /** Every Item with Attention, from any Source. */
  attention: StoredItem[];
  appointments: StoredItem[];
  todos: StoredItem[];
  /** Every Source that is not Healthy. */
  staleSources: SourceHealth[];
}

/** An Item's `data` as a record to read fields from; anything that is not an object reads as empty. */
export function fields(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? { ...data } : {};
}

/** GETs one `/api` path; a non-OK answer is an error naming its status. */
export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}
