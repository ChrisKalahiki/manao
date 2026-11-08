/**
 * The Measurement, no Source's own: one value of one Metric for one local
 * date. Each Metric's unit is fixed here, so a consumer never guesses what a
 * number means; adding a Metric is adding an entry.
 */
export const METRICS = {
  steps: { unit: "count" },
  sleep: { unit: "minutes" },
  "resting-heart-rate": { unit: "bpm" },
  "active-zone-minutes": { unit: "minutes" },
} as const satisfies Record<string, { unit: string }>;

export type Metric = keyof typeof METRICS;
export type MetricUnit = (typeof METRICS)[Metric]["unit"];

export const METRIC_IDS = Object.keys(METRICS) as [Metric, ...Metric[]];

/** What an Adapter writes. A day with no data has no Measurement, which is not a Measurement of zero. */
export interface Measurement {
  metric: Metric;
  /** A local date, `YYYY-MM-DD`; a night's sleep belongs to the day the user woke up. */
  date: string;
  value: number;
}
