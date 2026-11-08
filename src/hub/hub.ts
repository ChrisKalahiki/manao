import { fileURLToPath } from "node:url";
import { type Api, startApi } from "../api/server.js";
import type { SourceAdapter } from "../core/types.js";
import { openStore, type Store } from "../store/store.js";
import { DAY_MS } from "../store/upkeep.js";
import { type AdapterEnvironment, type ApiConfig, createAdapters, type HubConfig } from "./config.js";

/** Vite builds the dashboard into dist/dashboard, beside the built hub's dist/hub. */
const DEFAULT_DASHBOARD_DIR = fileURLToPath(new URL("../dashboard", import.meta.url));

export interface HubOptions {
  /** Where the store lives; ":memory:" for a throwaway one. */
  dbPath: string;
  /** One per enabled Source; any other Source in the store is removed at startup. */
  adapters: SourceAdapter[];
  /** Events older than this are pruned at startup and daily. */
  eventRetentionDays: number;
  /** Started after the Adapters; left out or `false` runs no API. */
  api?: ApiConfig | false;
  /** The built dashboard the API serves; defaults to the one built next to the hub. */
  dashboardDir?: string;
  /** The clock for the store and every Adapter. */
  now?: () => Date;
  log?: (line: string) => void;
}

export type ConfiguredHubOptions = Pick<HubOptions, "dbPath" | "dashboardDir" | "now" | "log"> & AdapterEnvironment;

/** The single writer (ADR 0001): owns the store and every Adapter feeding it. */
export interface Hub {
  readonly store: Store;
  /** Where the API listens, e.g. `http://127.0.0.1:7420`; null when it is off. */
  readonly apiUrl: string | null;
  /** Closes the API, stops pruning and every Adapter, then closes the store. */
  stop(): Promise<void>;
}

/** If an Adapter or the API fails to start, stops what already started, closes the store and rethrows. */
export async function startHub(opts: HubOptions): Promise<Hub> {
  const log = opts.log ?? console.log;
  const now = opts.now ?? (() => new Date());
  const store = openStore(opts.dbPath, { now });

  for (const source of store.removeSourcesExcept(opts.adapters.map((a) => a.id))) {
    log(`manao: removed ${source} from the store; it is no longer in the config`);
  }
  const prune = () => store.pruneEvents(opts.eventRetentionDays);
  prune();
  const pruneTimer = setInterval(prune, DAY_MS);

  const started: SourceAdapter[] = [];
  let api: Api | undefined;
  const stop = async () => {
    await api?.close();
    clearInterval(pruneTimer);
    await Promise.all(started.map((a) => a.stop()));
    store.close();
  };

  try {
    for (const adapter of opts.adapters) {
      await adapter.start(store, {
        items: store.items.list().filter((item) => item.source === adapter.id),
        latestMeasurementDate: store.measurements.latestDate(adapter.id),
        latestEvents: store.events.latestOfEachKind(adapter.id),
      });
      started.push(adapter);
    }
    if (opts.api) {
      const dashboardDir = opts.dashboardDir ?? DEFAULT_DASHBOARD_DIR;
      api = await startApi({ store, port: opts.api.port, now, dashboardDir, log });
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return { store, apiUrl: api?.url ?? null, stop };
}

/** Starts the hub `config` describes: one Adapter per enabled Source, all on the hub's clock. */
export function startHubFromConfig(config: HubConfig, opts: ConfiguredHubOptions): Promise<Hub> {
  const { googleEndpoints, googleTimeoutMs, ...hubOptions } = opts;
  return startHub({
    ...hubOptions,
    adapters: createAdapters(config, opts.now, { googleEndpoints, googleTimeoutMs }),
    eventRetentionDays: config.eventRetentionDays,
    api: config.api,
  });
}
