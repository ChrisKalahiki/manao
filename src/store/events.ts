import type { HubEvent } from "../core/types.js";
import type { StoreContext } from "./context.js";

// AUTOINCREMENT so ids are never reused once retention prunes the newest rows.
export const EVENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT    NOT NULL,
    kind   TEXT    NOT NULL,
    at     TEXT    NOT NULL,
    data   TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_at ON events (at);
`;

/** An Event as the store holds it: what the Adapter sent, stamped with the store's time and id. */
export type StoredEvent = HubEvent & {
  /** Assigned by the store; increases with every Event recorded. */
  id: number;
};

export interface EventQueries {
  /**
   * At most `limit` Events with an id greater than `afterId`, oldest first.
   * Start from 0 and pass the last id seen to get the next page.
   */
  after(afterId: number, limit?: number): StoredEvent[];
  /** Every Event observed at or after `time`, in the order recorded. */
  since(time: Date): StoredEvent[];
  /** The id of the newest stored Event, or 0 when there is none. */
  latestId(): number;
  /** The newest Event of each kind one Source recorded, in the order recorded. */
  latestOfEachKind(source: string): StoredEvent[];
}

/** The Events slice of the Store. */
export interface EventsPart {
  readonly events: EventQueries;
  /** Records the Events in order, each under a new id and observed now by the store's clock. */
  emitEvents(events: readonly HubEvent[]): void;
}

const DEFAULT_PAGE_SIZE = 100;

interface EventRow {
  id: number;
  source: string;
  kind: string;
  at: string;
  data: string;
}

export function eventsPart({ db, now }: StoreContext): EventsPart {
  const insert = db.prepare("INSERT INTO events (source, kind, at, data) VALUES (@source, @kind, @at, @data)");
  const selectAfter = db.prepare<[number, number], EventRow>("SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?");
  const selectSince = db.prepare<[string], EventRow>("SELECT * FROM events WHERE at >= ? ORDER BY id");
  const selectLatestId = db.prepare<[], number>("SELECT COALESCE(MAX(id), 0) FROM events").pluck();
  const selectLatestOfEachKind = db.prepare<[string], EventRow>(
    "SELECT * FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE source = ? GROUP BY kind) ORDER BY id",
  );

  // `at` is stored in toISOString form so text order is time order for `since` and pruning.
  const append = db.transaction((events: readonly HubEvent[]) => {
    const at = now().toISOString();
    for (const e of events) {
      insert.run({ source: e.source, kind: e.kind, at, data: JSON.stringify(e.data ?? null) });
    }
  });

  return {
    events: {
      after: (afterId, limit = DEFAULT_PAGE_SIZE) => selectAfter.all(afterId, limit).map(fromRow),
      since: (time) => selectSince.all(time.toISOString()).map(fromRow),
      latestId: () => selectLatestId.get() ?? 0,
      latestOfEachKind: (source) => selectLatestOfEachKind.all(source).map(fromRow),
    },
    emitEvents: (events) => append(events),
  };
}

/** What upkeep uses to prune: removes the Events observed before `time` and returns how many. */
export function eventPruner({ db }: StoreContext): (time: Date) => number {
  const removeBefore = db.prepare("DELETE FROM events WHERE at < ?");
  return (time) => removeBefore.run(time.toISOString()).changes;
}

function fromRow(row: EventRow): StoredEvent {
  return { id: row.id, source: row.source, kind: row.kind, at: row.at, data: JSON.parse(row.data) as unknown };
}
