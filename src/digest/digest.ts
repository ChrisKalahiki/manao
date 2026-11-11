import { z } from "zod";
import { appointmentTimeSchema } from "../appointment.js";
import { HERDR_SOURCE_ID } from "../herdr/adapter.js";
import { AGENT_ITEM_TYPE } from "../herdr/normalize.js";
import { addDays, localDate, startOfLocalDay } from "../local-time.js";
import { lazyStore } from "../mcp/store.js";
import { PAPER_ITEM_TYPE } from "../paper.js";
import { PAPER_BOT_SOURCE_ID } from "../paper-bot/normalize.js";
import { type AgendaResult, agenda, listMeasurements } from "../query/queries.js";
import type { SourceHealth } from "../store/health.js";
import type { StoredItem } from "../store/items.js";
import type { StoredMeasurement } from "../store/measurements.js";
import type { Store } from "../store/store.js";

/** Where `manao digest --drive` writes: one fixed file in one folder at the top of the user's Drive. */
export const DIGEST_DRIVE_FOLDER = "Manao";
export const DIGEST_DRIVE_FILE = "Manao daily.md";

/** Enough to keep the digest under about 60 lines; the rest is counted, not listed. */
const MAX_ATTENTION = 5;
const MAX_APPOINTMENTS = 8;
/** Todo lines, the Todo Groups' bold lines included. */
const MAX_TODO_LINES = 16;
/** How far back the latest of a Metric is looked for; its trend needs the 7 days before it as well. */
const MEASUREMENT_LOOKBACK_DAYS = 14;
const TREND_DAYS = 7;
/** Fewer days than this before the latest is too little to call an average. */
const MIN_TREND_DAYS = 4;

/** Everything the digest shows, read from the store at once. */
export interface DigestInput {
  now: Date;
  agenda: AgendaResult;
  /** The last `MEASUREMENT_LOOKBACK_DAYS` days and Today. */
  measurements: StoredMeasurement[];
  /** Every Source that has reported, which is every one the hub's config enables. */
  sources: SourceHealth[];
  agents: StoredItem[];
  papers: StoredItem[];
}

/** The digest for the Today of `now`, from the store at `dbPath` opened read-only, as `manao mcp` opens it. */
export function digestFromStore(dbPath: string, now: Date): string {
  const store = lazyStore(dbPath, () => now);
  try {
    return renderDigest(readDigest(store.get(), now));
  } finally {
    store.close();
  }
}

export function readDigest(store: Store, now: Date): DigestInput {
  const today = localDate(now);
  return {
    now,
    agenda: agenda(store, {}, now),
    measurements: listMeasurements(store, { from: addDays(today, -MEASUREMENT_LOOKBACK_DAYS), to: today }, now).measurements,
    sources: store.health.list(),
    agents: store.items.list({ type: AGENT_ITEM_TYPE }),
    papers: store.items.list({ type: PAPER_ITEM_TYPE }),
  };
}

/** One short Markdown page for the Today of `input.now`, in the system zone. */
export function renderDigest(input: DigestInput): string {
  const { now } = input;
  const today = localDate(now);
  const lines = [`# Manaʻo daily: ${longDate(today)}`, "", `Generated at ${clockTime(now)} (${utcOffset(now)}) on ${today}.`];
  const stale = input.sources.filter((source) => !source.healthy);
  if (stale.length > 0) {
    const named = stale.map((source) => `${source.source} (last ok ${okAt(source.lastOkAt, today)})`).join(", ");
    lines.push("", `**Stale:** ${named}. What they show below is last known.`);
  }
  const section = (title: string, body: string[]) => {
    if (body.length > 0) lines.push("", `## ${title}`, "", ...body);
  };
  section("Needs you", capped(input.agenda.attention.map(attentionLine), MAX_ATTENTION));
  section("Agenda", orEmpty(capped(input.agenda.appointments.map((item) => appointmentLine(item, now)), MAX_APPOINTMENTS), "Nothing on the calendar today."));
  section("Todos", orEmpty(todoLines(input.agenda.todos), "No open Todos."));
  section("Health", healthLines(input.measurements, today));
  section("Also", alsoLines(input, today));
  return `${lines.join("\n")}\n`;
}

function attentionLine(item: StoredItem): string {
  return `- ${oneLine(item.title)} (${item.type}, ${item.status.replaceAll("_", " ")})`;
}

const appointmentExtrasSchema = z.object({ response: z.string().nullable().optional() });

const RESPONSE_LABELS: Record<string, string> = { tentative: " (tentative)", needsAction: " (not answered)" };

function appointmentLine(item: StoredItem, now: Date): string {
  const time = appointmentTimeSchema.parse(item.data);
  const extras = appointmentExtrasSchema.safeParse(item.data);
  const response = (extras.success && extras.data.response && RESPONSE_LABELS[extras.data.response]) || "";
  return `- ${time.allDay ? "All day" : timedSpan(new Date(time.start), new Date(time.end), now)} ${oneLine(item.title)}${response}`;
}

/** A span that began before Today or ends after it shows only the part that falls in it. */
function timedSpan(start: Date, end: Date, now: Date): string {
  const startsToday = start >= startOfLocalDay(now);
  const endsToday = end <= startOfLocalDay(now, 1);
  if (startsToday && endsToday) return `${clockTime(start)}–${clockTime(end)}`;
  if (startsToday) return `from ${clockTime(start)}`;
  return endsToday ? `until ${clockTime(end)}` : "All day";
}

const todoDataSchema = z.object({
  groupPath: z.array(z.string()).catch([]),
  parentId: z.string().nullable().catch(null),
});

/** The Agenda's open Todos as an outline: a bold line per Todo Group, subtodos indented under an open parent. */
function todoLines(todos: StoredItem[]): string[] {
  const data = new Map(todos.map((todo) => [todo.id, todoDataSchema.parse(todo.data ?? {})]));
  const depth = (id: string): number => {
    let level = 0;
    for (let parent = data.get(id)?.parentId; parent && data.has(parent) && level < todos.length; parent = data.get(parent)?.parentId) {
      level++;
    }
    return level;
  };
  const lines: string[] = [];
  let group: string | undefined;
  let shown = 0;
  for (const todo of todos) {
    const path = data.get(todo.id)?.groupPath.join(" / ") ?? "";
    const heading = path !== group && path !== "" ? [`**${oneLine(path)}**`] : [];
    if (lines.length + heading.length + 1 > MAX_TODO_LINES) break;
    lines.push(...heading, `${"  ".repeat(depth(todo.id))}- ${oneLine(todo.title)}`);
    group = path;
    shown++;
  }
  if (shown < todos.length) lines.push(`- …and ${todos.length - shown} more`);
  return lines;
}

const COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface MetricView {
  name: string;
  format: (value: number) => string;
  /** A running total, so Today's value is not yet the day's: the latest whole day is yesterday. */
  runningTotal: boolean;
}

/** The Metrics the digest knows, in the order the dashboard lists them; a newer one shows by its id and unit. */
const METRIC_VIEWS: Record<string, MetricView> = {
  sleep: { name: "Sleep", format: hoursAndMinutes, runningTotal: false },
  steps: { name: "Steps", format: (v) => COUNT.format(v), runningTotal: true },
  "resting-heart-rate": { name: "Resting heart rate", format: (v) => `${COUNT.format(v)} bpm`, runningTotal: false },
  "active-zone-minutes": { name: "Active zone minutes", format: (v) => `${COUNT.format(v)} min`, runningTotal: true },
};

function metricView(metric: string, unit: string): MetricView {
  return METRIC_VIEWS[metric] ?? { name: metric, format: (v) => `${COUNT.format(v)} ${unit}`, runningTotal: false };
}

/** Each Metric's latest whole day, with how it compares to the 7 days before it when there are enough of them. */
function healthLines(measurements: StoredMeasurement[], today: string): string[] {
  const known = Object.keys(METRIC_VIEWS);
  const metrics = [...new Set(measurements.map((m) => m.metric))].sort(
    (a, b) => rank(known, a) - rank(known, b) || a.localeCompare(b),
  );
  return metrics.flatMap((metric) => {
    const series = measurements.filter((m) => m.metric === metric);
    const view = metricView(metric, series[0]?.unit ?? "");
    const latest = series.filter((m) => !view.runningTotal || m.date < today).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (!latest) return [];
    const reading = `${view.format(latest.value)}${trend(series, latest, view)}`;
    if (metric !== "sleep") return [`- ${view.name} ${dayLabel(latest.date, today)}: ${reading}`];
    return latest.date === today
      ? [`- Sleep last night: ${reading}`]
      : [`- Sleep last night: none recorded; ${dayLabel(latest.date, today)} ${reading}`];
  });
}

function trend(series: StoredMeasurement[], latest: StoredMeasurement, view: MetricView): string {
  const since = addDays(latest.date, -TREND_DAYS);
  const prior = series.filter((m) => m.date >= since && m.date < latest.date);
  if (prior.length < MIN_TREND_DAYS) return "";
  const average = prior.reduce((sum, m) => sum + m.value, 0) / prior.length;
  const delta = latest.value - average;
  const change = Math.round(delta) === 0 ? "level with" : `${delta > 0 ? "+" : "−"}${view.format(Math.abs(delta))} vs`;
  return ` (${change} 7-day avg ${view.format(average)})`;
}

const paperDateSchema = z.object({ date: z.string() });

const AGENT_STATUS_WORDS: Record<string, string> = {
  needs_attention: "need you",
  finished: "finished",
  running: "running",
  idle: "idle",
  unknown: "unknown",
};

/** A line for each other enabled Source worth one: Herdr's agents and paper-bot's Picks. */
function alsoLines(input: DigestInput, today: string): string[] {
  const enabled = new Set(input.sources.map((source) => source.source));
  const lines: string[] = [];
  if (enabled.has(HERDR_SOURCE_ID)) {
    const counts = Object.entries(AGENT_STATUS_WORDS)
      .map(([status, words]) => [input.agents.filter((agent) => agent.status === status).length, words] as const)
      .filter(([count]) => count > 0)
      .map(([count, words]) => `${count} ${words}`);
    lines.push(`- Agents: ${counts.length > 0 ? counts.join(", ") : "none"}`);
  }
  if (enabled.has(PAPER_BOT_SOURCE_ID)) {
    const kept = input.papers.filter((paper) => paper.status === "kept").length;
    const todays = input.papers.filter((paper) => paperDateSchema.safeParse(paper.data).data?.date === today).length;
    lines.push(`- Papers: ${input.papers.length} Picks this week, ${todays} today, ${kept} kept`);
  }
  return lines;
}

function capped(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `- …and ${lines.length - max} more`] : lines;
}

function orEmpty(lines: string[], empty: string): string[] {
  return lines.length > 0 ? lines : [empty];
}

function rank(order: string[], metric: string): number {
  const at = order.indexOf(metric);
  return at === -1 ? order.length : at;
}

/** Titles come from calendars and notes, so a stray newline must not start a new Markdown block. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hoursAndMinutes(minutes: number): string {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / 60);
  return hours > 0 ? `${hours}h ${whole % 60}m` : `${whole}m`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Calendar dates read in UTC, where every day is whole, as `addDays` does. */
function parts(date: string): { weekday: string; day: number; month: string; year: number } {
  const d = new Date(`${date}T00:00:00Z`);
  return { weekday: WEEKDAYS[d.getUTCDay()]!, day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()]!, year: d.getUTCFullYear() };
}

function longDate(date: string): string {
  const { weekday, day, month, year } = parts(date);
  return `${weekday} ${day} ${month} ${year}`;
}

function dayLabel(date: string, today: string): string {
  if (date === today) return "today";
  if (date === addDays(today, -1)) return "yesterday";
  const { weekday, day, month } = parts(date);
  return `${weekday.slice(0, 3)} ${day} ${month.slice(0, 3)}`;
}

function okAt(lastOkAt: string | null, today: string): string {
  if (!lastOkAt) return "never";
  const at = new Date(lastOkAt);
  return `${dayLabel(localDate(at), today)} ${clockTime(at)}`;
}

function clockTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function utcOffset(date: Date): string {
  const east = -date.getTimezoneOffset();
  const abs = Math.abs(east);
  return `UTC${east < 0 ? "−" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
