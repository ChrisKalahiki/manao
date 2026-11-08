import { METRICS, type Measurement, type Metric, type MetricUnit } from "../measurement.js";
import type { StoreContext } from "./context.js";
import { type HealthColumns, isHealthy } from "./health.js";

// No upkeep removes or prunes these rows: Measurements are kept forever, even once their Source is turned off.
export const MEASUREMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS measurements (
    source     TEXT NOT NULL,
    metric     TEXT NOT NULL,
    date       TEXT NOT NULL,
    value      REAL NOT NULL,
    written_at TEXT NOT NULL,
    PRIMARY KEY (source, metric, date)
  );
`;

/** Every field left out matches any Measurement; `from` and `to` are inclusive local dates. */
export interface MeasurementFilter {
  metric?: Metric;
  from?: string;
  to?: string;
}

/** A Measurement as queries return it: what the Adapter wrote, its unit, and its Source's freshness. */
export interface StoredMeasurement extends Measurement {
  source: string;
  unit: MetricUnit;
  /** Whether the Measurement's Source is Healthy now; false means it is Stale. */
  sourceOk: boolean;
  /** When the Measurement's Source last reported success; null if it never has, or no longer reports. */
  lastOkAt: string | null;
}

export interface MeasurementQueries {
  /** Ordered by Metric, then date, then Source. */
  list(filter?: MeasurementFilter): StoredMeasurement[];
  /** The date of `source`'s latest Measurement of any Metric, or null when it has none. */
  latestDate(source: string): string | null;
}

/** The Measurements slice of the Store. */
export interface MeasurementsPart {
  readonly measurements: MeasurementQueries;
  /** Replaces the value of each Source, Metric and date written; every other day stays as it was. */
  writeMeasurements(source: string, measurements: readonly Measurement[]): void;
}

interface QueriedRow extends HealthColumns {
  source: string;
  metric: string;
  date: string;
  value: number;
  last_ok_at: string | null;
}

export function measurementsPart({ db, now }: StoreContext): MeasurementsPart {
  const upsert = db.prepare(
    `INSERT INTO measurements (source, metric, date, value, written_at)
     VALUES (@source, @metric, @date, @value, @writtenAt)
     ON CONFLICT (source, metric, date) DO UPDATE SET value = excluded.value, written_at = excluded.written_at`,
  );
  const select = db.prepare<[{ metric: string | null; from: string | null; to: string | null }], QueriedRow>(
    `SELECT measurements.source, metric, date, value, health.ok, health.at, health.stale_after_ms, health.last_ok_at
     FROM measurements LEFT JOIN health USING (source)
     WHERE (@metric IS NULL OR metric = @metric)
       AND (@from IS NULL OR date >= @from)
       AND (@to IS NULL OR date <= @to)
     ORDER BY metric, date, measurements.source`,
  );
  const selectLatest = db.prepare<[string], string | null>("SELECT MAX(date) FROM measurements WHERE source = ?").pluck();

  const write = db.transaction((source: string, measurements: readonly Measurement[]) => {
    const writtenAt = now().toISOString();
    for (const { metric, date, value } of measurements) upsert.run({ source, metric, date, value, writtenAt });
  });

  return {
    measurements: {
      list: ({ metric, from, to } = {}) => {
        const at = now();
        // A Metric this version does not know, written by a newer one, has no unit here, so it is left out.
        return select.all({ metric: metric ?? null, from: from ?? null, to: to ?? null }).flatMap((row) =>
          isKnown(row.metric)
            ? [
                {
                  source: row.source,
                  metric: row.metric,
                  date: row.date,
                  value: row.value,
                  unit: METRICS[row.metric].unit,
                  sourceOk: isHealthy(row, at),
                  lastOkAt: row.last_ok_at,
                },
              ]
            : [],
        );
      },
      latestDate: (source) => selectLatest.get(source) ?? null,
    },
    writeMeasurements: (source, measurements) => write(source, measurements),
  };
}

function isKnown(metric: string): metric is Metric {
  return Object.hasOwn(METRICS, metric);
}
