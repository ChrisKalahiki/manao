import type { StoredMeasurement } from "../hub.js";
import { addDays, dateAt, localDate } from "../time.js";
import { LastKnown, Widget } from "./widget.js";

export interface HealthWidgetProps {
  /** `/api/measurements` with its defaults: the 7 days ending Today, by Metric, then date. */
  measurements: StoredMeasurement[];
  /** The hub's clock: Today and every day word are read from it. */
  now: string;
}

interface MetricView {
  name: string;
  format: (value: number) => string;
  /** What the latest value's day reads when it is Today. */
  today: string;
}

const COUNT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const NUMBER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function hoursAndMinutes(minutes: number): string {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  return hours > 0 ? `${hours}h ${whole % 60}m` : `${whole}m`;
}

/** The Metrics the widget knows, in the order it lists them. A running day's steps and minutes are not its total. */
const METRICS: Record<string, MetricView> = {
  steps: { name: "Steps", format: (v) => COUNT.format(v), today: "so far today" },
  sleep: { name: "Sleep", format: hoursAndMinutes, today: "last night" },
  "resting-heart-rate": { name: "Resting heart rate", format: (v) => `${COUNT.format(v)} bpm`, today: "today" },
  "active-zone-minutes": { name: "Active zone minutes", format: (v) => `${COUNT.format(v)} min`, today: "so far today" },
};

const METRIC_ORDER = Object.keys(METRICS);

/** A Metric newer than this page still shows, by its id and unit. */
function metricView(metric: string, unit: string): MetricView {
  return METRICS[metric] ?? { name: metric, format: (v) => `${NUMBER.format(v)} ${unit}`, today: "today" };
}

const STRIP_DAYS = 7;
/** A zero is a real reading, so it still gets a sliver of bar; only a missing day has none. */
const MIN_BAR = 6;

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const NARROW_WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });

interface MetricRow {
  metric: string;
  view: MetricView;
  /** By date, oldest first. */
  measurements: StoredMeasurement[];
}

/** Each Metric's latest value and its day, over a strip of the week ending Today. */
export function HealthWidget({ measurements, now }: HealthWidgetProps) {
  const today = localDate(now);
  return (
    <Widget
      name="health"
      title="Health"
      count="last 7 days"
      empty={measurements.length === 0 ? "No Measurements in the last 7 days." : null}
    >
      <LastKnown items={measurements} now={now} />
      <ul class="rows">
        {byMetric(measurements).map((row) => (
          <MetricRowView key={row.metric} row={row} today={today} />
        ))}
      </ul>
    </Widget>
  );
}

function byMetric(measurements: StoredMeasurement[]): MetricRow[] {
  const rows = new Map<string, MetricRow>();
  for (const m of measurements) {
    const row = rows.get(m.metric) ?? { metric: m.metric, view: metricView(m.metric, m.unit), measurements: [] };
    row.measurements.push(m);
    rows.set(m.metric, row);
  }
  const rank = (metric: string) => {
    const index = METRIC_ORDER.indexOf(metric);
    return index === -1 ? METRIC_ORDER.length : index;
  };
  return [...rows.values()]
    .map((row) => ({ ...row, measurements: [...row.measurements].sort((a, b) => a.date.localeCompare(b.date)) }))
    .sort((a, b) => rank(a.metric) - rank(b.metric) || a.metric.localeCompare(b.metric));
}

function MetricRowView({ row: { metric, view, measurements }, today }: { row: MetricRow; today: string }) {
  const id = `health-${metric}`;
  const latest = measurements[measurements.length - 1];
  if (!latest) return null;
  return (
    <li class="row health-metric" data-stale={!latest.sourceOk} aria-labelledby={id}>
      <div class="row-line">
        <h3 id={id} class="health-name">
          {view.name}
        </h3>
        <p class="health-latest">
          <span class="health-value">{view.format(latest.value)}</span>{" "}
          <span class="health-day">{dayWord(latest.date, today, view)}</span>
        </p>
      </div>
      <Strip view={view} measurements={measurements} today={today} />
    </li>
  );
}

function dayWord(date: string, today: string, view: MetricView): string {
  if (date === today) return view.today;
  if (date === addDays(today, -1)) return "yesterday";
  return WEEKDAY.format(dateAt(date));
}

/**
 * The week ending Today as bars, scaled to the Metric's own highest day. Drawn in SVG because the
 * CSP allows no inline styles to size them; a screen reader hears each day's value instead.
 */
function Strip({ view, measurements, today }: { view: MetricView; measurements: StoredMeasurement[]; today: string }) {
  const values = new Map(measurements.map((m) => [m.date, m.value]));
  const highest = Math.max(0, ...values.values());
  const days = Array.from({ length: STRIP_DAYS }, (_, i) => addDays(today, i + 1 - STRIP_DAYS));
  return (
    <ol class="health-strip" aria-label={`${view.name}, last 7 days`}>
      {days.map((date) => {
        const value = values.get(date);
        const height = value === undefined ? null : barHeight(value, highest);
        const name = date === today ? "Today" : WEEKDAY.format(dateAt(date));
        return (
          <li key={date} class="health-day-slot" data-today={date === today} data-missing={value === undefined}>
            <svg class="health-bar" viewBox="0 0 10 100" preserveAspectRatio="none" aria-hidden="true">
              {height !== null && <rect x="0" y={100 - height} width="10" height={height} />}
            </svg>
            <span class="health-letter" aria-hidden="true">
              {NARROW_WEEKDAY.format(dateAt(date))}
            </span>
            <span class="visually-hidden">{`${name}: ${value === undefined ? "no data" : view.format(value)}`}</span>
          </li>
        );
      })}
    </ol>
  );
}

function barHeight(value: number, highest: number): number {
  const percent = highest > 0 ? (value / highest) * 100 : 0;
  return Math.round(Math.max(MIN_BAR, percent) * 100) / 100;
}
