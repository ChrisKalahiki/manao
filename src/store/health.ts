import type { Health } from "../core/types.js";
import { homeRelative } from "../home-path.js";
import type { SourceRows, StoreContext } from "./context.js";

export const HEALTH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS health (
    source         TEXT    PRIMARY KEY,
    ok             INTEGER NOT NULL,
    at             TEXT    NOT NULL,
    error          TEXT,
    note           TEXT,
    stale_after_ms INTEGER NOT NULL,
    last_ok_at     TEXT
  );
`;

/** A Source's latest Health report, judged against the store's clock. */
export interface SourceHealth extends Health {
  source: string;
  /** When the Source last reported success; null if it never has. */
  lastOkAt: string | null;
  healthy: boolean;
}

export interface HealthQueries {
  /** The latest report of each Source that has reported, ordered by Source. */
  list(): SourceHealth[];
}

/** The Health slice of the Store. */
export interface HealthPart {
  readonly health: HealthQueries;
  /** Keeps only the latest report per Source, paths under the home directory as `~/...`; `lastOkAt` survives failures. */
  reportHealth(source: string, health: Health): void;
}

/** The columns that judge a Source Healthy; all null when it never reported. */
export interface HealthColumns {
  ok: number | null;
  at: string | null;
  stale_after_ms: number | null;
}

/** Healthy: the latest report succeeded and is no older than its own limit. */
export function isHealthy({ ok, at, stale_after_ms }: HealthColumns, now: Date): boolean {
  if (ok !== 1 || at === null || stale_after_ms === null) return false;
  return now.getTime() - Date.parse(at) <= stale_after_ms;
}

interface StoredHealthRow {
  source: string;
  ok: number;
  at: string;
  stale_after_ms: number;
  error: string | null;
  note: string | null;
  last_ok_at: string | null;
}

export function healthPart({ db, now }: StoreContext): HealthPart {
  const upsert = db.prepare(
    `INSERT INTO health (source, ok, at, error, note, stale_after_ms, last_ok_at)
     VALUES (@source, @ok, @at, @error, @note, @staleAfterMs, CASE WHEN @ok = 1 THEN @at END)
     ON CONFLICT (source) DO UPDATE SET
       ok = excluded.ok,
       at = excluded.at,
       error = excluded.error,
       note = excluded.note,
       stale_after_ms = excluded.stale_after_ms,
       last_ok_at = COALESCE(excluded.last_ok_at, health.last_ok_at)`,
  );
  const select = db.prepare<[], StoredHealthRow>("SELECT * FROM health ORDER BY source");

  return {
    health: {
      list: () => {
        const at = now();
        return select.all().map((row) => fromRow(row, at));
      },
    },
    reportHealth: (source, health) => {
      upsert.run({
        source,
        ok: health.ok ? 1 : 0,
        at: health.at,
        error: health.error === undefined ? null : homeRelative(health.error),
        note: health.note === undefined ? null : homeRelative(health.note),
        staleAfterMs: health.staleAfterMs,
      });
    },
  };
}

export function healthSourceRows({ db }: StoreContext): SourceRows {
  const selectSources = db.prepare<[], { source: string }>("SELECT source FROM health");
  const removeSource = db.prepare("DELETE FROM health WHERE source = ?");
  return {
    sources: () => selectSources.all().map((row) => row.source),
    remove: (source) => void removeSource.run(source),
  };
}

function fromRow(row: StoredHealthRow, now: Date): SourceHealth {
  return {
    source: row.source,
    ok: row.ok === 1,
    at: row.at,
    ...(row.error !== null && { error: row.error }),
    ...(row.note !== null && { note: row.note }),
    staleAfterMs: row.stale_after_ms,
    lastOkAt: row.last_ok_at,
    healthy: isHealthy(row, now),
  };
}
