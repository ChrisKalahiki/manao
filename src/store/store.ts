import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ItemSink } from "../core/types.js";
import type { StoreContext } from "./context.js";
import { EVENTS_SCHEMA, type EventsPart, eventsPart } from "./events.js";
import { HEALTH_SCHEMA, type HealthPart, healthPart } from "./health.js";
import { ITEMS_SCHEMA, type ItemsPart, itemsPart } from "./items.js";
import { MEASUREMENTS_SCHEMA, type MeasurementsPart, measurementsPart } from "./measurements.js";
import { type UpkeepPart, upkeepPart } from "./upkeep.js";

/**
 * The hub's memory. The hub process writes through the ItemSink half; every
 * consumer reads through the query groups. Each kind of data is one part that
 * brings its own schema, sink method and query group.
 */
export type Store = ItemSink &
  ItemsPart &
  EventsPart &
  HealthPart &
  MeasurementsPart &
  UpkeepPart & {
    close(): void;
  };

export interface StoreOptions {
  now?: () => Date;
  /**
   * Open an existing store without writing anything, as every process but
   * the hub does (ADR 0001). Writes through the returned Store throw.
   */
  readOnly?: boolean;
}

/**
 * Bump when a part's schema changes. Each part's `CREATE ... IF NOT EXISTS`
 * statements upgrade an older store in place: version 2 added Measurements.
 */
const SCHEMA_VERSION = 2;
const SCHEMA = [ITEMS_SCHEMA, EVENTS_SCHEMA, HEALTH_SCHEMA, MEASUREMENTS_SCHEMA];

/**
 * Opens (creating if needed) the store at `file`, or an in-memory one for
 * ":memory:"; `readOnly` needs an existing file with a schema this version reads.
 */
export function openStore(file: string, opts: StoreOptions = {}): Store {
  const db = opts.readOnly ? openForReading(file) : openForWriting(file);

  const ctx: StoreContext = { db, now: opts.now ?? (() => new Date()) };

  return {
    ...itemsPart(ctx),
    ...eventsPart(ctx),
    ...healthPart(ctx),
    ...measurementsPart(ctx),
    ...upkeepPart(ctx),
    close: () => db.close(),
  };
}

function openForReading(file: string): Database.Database {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`schema version ${version} is newer than this manao reads (${SCHEMA_VERSION}); update manao`);
  }
  if (version === 0) {
    db.close();
    throw new Error("it has no schema yet; is `manao run` still starting?");
  }
  // A newer part's queries cannot be prepared against an older store; only the hub, its writer, upgrades it.
  if (version < SCHEMA_VERSION) {
    db.close();
    throw new Error(`schema version ${version} is older than this manao reads (${SCHEMA_VERSION}); restart \`manao run\` to upgrade it`);
  }
  return db;
}

function openForWriting(file: string): Database.Database {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL lets read-only processes read while the hub writes (ADR 0001).
  db.pragma("journal_mode = WAL");
  db.transaction(() => {
    for (const ddl of SCHEMA) db.exec(ddl);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
  return db;
}
