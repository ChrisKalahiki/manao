import { useEffect, useState } from "preact/hooks";
import {
  type AgendaResponse,
  getJson,
  type ItemsResponse,
  type MeasurementsResponse,
  type SourceHealth,
  type SourcesResponse,
  type StoredItem,
  type StoredMeasurement,
} from "./hub.js";
import type { View } from "./view.js";

const POLL_INTERVAL_MS = 10_000;

/** What the hub last said for the All view, read in one tick. */
export interface HubSnapshot {
  /** The hub's clock at that read; the only one ages are measured against. */
  now: string;
  items: StoredItem[];
  sources: SourceHealth[];
  measurements: StoredMeasurement[];
}

export interface Poll {
  /** The last successful read of the Agenda, for Today; null until one succeeds. */
  agenda: AgendaResponse | null;
  /** The last successful read for All; null until one succeeds. Each stays on screen while the hub cannot be reached. */
  all: HubSnapshot | null;
  /** Why the latest tick failed; null once a tick succeeds. */
  error: string | null;
}

async function readAll(): Promise<HubSnapshot> {
  const [items, sources, measurements] = await Promise.all([
    getJson<ItemsResponse>("/api/items"),
    getJson<SourcesResponse>("/api/sources"),
    getJson<MeasurementsResponse>("/api/measurements"),
  ]);
  return { now: sources.now, items: items.items, sources: sources.sources, measurements: measurements.measurements };
}

const readAgenda = () => getJson<AgendaResponse>("/api/agenda");

/** What each view reads, and where in the Poll its last good read is kept. */
const VIEW_READS = {
  today: { read: readAgenda, slot: "agenda" },
  all: { read: readAll, slot: "all" },
} as const satisfies Record<View, { read: () => Promise<unknown>; slot: keyof Poll }>;

type Tick<T> = { value: T } | { error: string };

/**
 * Calls `read` now and whenever the page becomes visible, then every `intervalMs` while it
 * stays visible, never while hidden. The next tick is timed from the end of the last one, so a
 * slow hub delays polling instead of stacking requests. Returns a function that stops it.
 */
function pollHub<T>(read: () => Promise<T>, onTick: (tick: Tick<T>) => void, intervalMs = POLL_INTERVAL_MS): () => void {
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => document.visibilityState === "visible";

  async function tick() {
    if (stopped || inFlight || !visible()) return;
    clearTimeout(timer);
    inFlight = true;
    try {
      const value = await read();
      if (!stopped) onTick({ value });
    } catch (err) {
      if (!stopped) onTick({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = false;
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  }

  function onVisibility() {
    if (visible()) void tick();
    else clearTimeout(timer);
  }

  document.addEventListener("visibilitychange", onVisibility);
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * The dashboard's one poller, as state. It reads only what `view` shows, and reads at once when
 * the view changes, so a view never waits a whole interval for its data nor shows another
 * view's failure.
 */
export function useHubPoll(view: View): Poll {
  const [poll, setPoll] = useState<Poll>({ agenda: null, all: null, error: null });
  useEffect(() => {
    setPoll((prev) => ({ ...prev, error: null }));
    const { read, slot } = VIEW_READS[view];
    return pollHub<AgendaResponse | HubSnapshot>(read, (tick) =>
      setPoll((prev) => ("value" in tick ? { ...prev, [slot]: tick.value, error: null } : { ...prev, error: tick.error })),
    );
  }, [view]);
  return poll;
}
