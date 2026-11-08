import { z } from "zod";
import { forbidden, type GoogleConnection, GoogleError, type GoogleResponse, unexpected } from "../google/oauth.js";
import { addDays } from "../local-time.js";
import type { Measurement } from "../measurement.js";

/** Steps and active zone minutes. */
const ACTIVITY_SCOPE = "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly";
const SLEEP_SCOPE = "https://www.googleapis.com/auth/googlehealth.sleep.readonly";
/** Resting heart rate. */
const METRICS_SCOPE = "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly";

/** Read-only; each request checks only the scope of the Metric it reads, but the sign-in asks for all three at once. */
export const HEALTH_SCOPES: readonly string[] = [ACTIVITY_SCOPE, SLEEP_SCOPE, METRICS_SCOPE];

/** Local dates, both inclusive. */
export interface DayRange {
  from: string;
  to: string;
}

/**
 * Every Metric's Measurements for each day of `range` that has data; all or
 * nothing, so any one Metric's failure fails the read.
 */
export async function readMeasurements(google: GoogleConnection, range: DayRange): Promise<Measurement[]> {
  // One Metric after another, so a failure always names the first Metric that failed.
  return [
    ...(await readSteps(google, range)),
    ...(await readActiveZoneMinutes(google, range)),
    ...(await readRestingHeartRate(google, range)),
    ...(await readSleep(google, range)),
  ];
}

async function readSteps(google: GoogleConnection, range: DayRange): Promise<Measurement[]> {
  const points = await dailyRollUp(google, "steps", ACTIVITY_SCOPE, range, stepsPointSchema);
  return points.flatMap(({ civilStartTime, steps }) =>
    steps ? [{ metric: "steps", date: dateOf(civilStartTime.date), value: steps.countSum }] : [],
  );
}

async function readActiveZoneMinutes(google: GoogleConnection, range: DayRange): Promise<Measurement[]> {
  const points = await dailyRollUp(google, "active-zone-minutes", ACTIVITY_SCOPE, range, zonesPointSchema);
  return points.flatMap(({ civilStartTime, activeZoneMinutes: zones }) =>
    zones
      ? [
          {
            metric: "active-zone-minutes",
            date: dateOf(civilStartTime.date),
            value: zones.sumInFatBurnHeartZone + zones.sumInCardioHeartZone + zones.sumInPeakHeartZone,
          },
        ]
      : [],
  );
}

async function readRestingHeartRate(google: GoogleConnection, range: DayRange): Promise<Measurement[]> {
  const field = "daily_resting_heart_rate.date";
  const filter = `${field} >= "${range.from}" AND ${field} < "${addDays(range.to, 1)}"`;
  const points = await listDataPoints(google, "daily-resting-heart-rate", METRICS_SCOPE, filter, restingHeartRatePointSchema);
  return points.flatMap(({ dailyRestingHeartRate: { date, beatsPerMinute } }) =>
    beatsPerMinute === undefined ? [] : [{ metric: "resting-heart-rate", date: dateOf(date), value: beatsPerMinute }],
  );
}

/**
 * A night's sleep belongs to the day the user woke up: each date's value is the
 * minutes asleep of every session ending on it, naps included, so the `nap`
 * and `mainSleep` flags are ignored.
 */
async function readSleep(google: GoogleConnection, range: DayRange): Promise<Measurement[]> {
  const field = "sleep.interval.civil_end_time";
  const filter = `${field} >= "${range.from}T00:00:00" AND ${field} < "${addDays(range.to, 1)}T00:00:00"`;
  const sessions = await listDataPoints(google, "sleep", SLEEP_SCOPE, filter, sleepPointSchema);
  const minutesByDate = new Map<string, number>();
  for (const { sleep } of sessions) {
    const minutes = sleep.summary?.minutesAsleep;
    if (minutes === undefined) continue;
    const date = wakeDate(sleep.interval.endTime, sleep.interval.endUtcOffset);
    minutesByDate.set(date, (minutesByDate.get(date) ?? 0) + minutes);
  }
  return [...minutesByDate].map(([date, value]) => ({ metric: "sleep", date, value }));
}

/** Google's own civil day of the end, since the response carries no civil fields. */
function wakeDate(endTime: string, endUtcOffsetSeconds: number): string {
  return new Date(Date.parse(endTime) + endUtcOffsetSeconds * 1000).toISOString().slice(0, 10);
}

const civilDateSchema = z.object({ year: z.int(), month: z.int().min(1).max(12), day: z.int().min(1).max(31) });
type CivilDate = z.infer<typeof civilDateSchema>;

/** Google sends int64 values as strings. */
const int64 = z
  .string()
  .regex(/^\d{1,15}$/)
  .transform(Number);

/** A day's roll-up; Google leaves a day with no data out, and an unset value means the same. */
const stepsPointSchema = z.object({
  civilStartTime: z.object({ date: civilDateSchema }),
  steps: z.object({ countSum: int64 }).optional(),
});

/**
 * Google already counts each cardio and peak minute twice, as the Fitbit app
 * does (the API probe checked the per-minute records), so the
 * Metric is the plain sum. A zone left unset is proto3's zero.
 */
const zonesPointSchema = z.object({
  civilStartTime: z.object({ date: civilDateSchema }),
  activeZoneMinutes: z
    .object({
      sumInFatBurnHeartZone: int64.default(0),
      sumInCardioHeartZone: int64.default(0),
      sumInPeakHeartZone: int64.default(0),
    })
    .optional(),
});

/** A day's resting heart rate; Google leaves a day with no data out, and an unset value means the same. */
const restingHeartRatePointSchema = z.object({
  dailyRestingHeartRate: z.object({ date: civilDateSchema, beatsPerMinute: int64.optional() }),
});

/**
 * A sleep session, which carries instants and UTC offsets (`"-14400s"`), never
 * civil times. Google leaves out a zero offset (a proto3 default), so UTC is
 * the default. One whose minutes asleep are unset counts for nothing.
 */
const sleepPointSchema = z.object({
  sleep: z.object({
    interval: z.object({
      endTime: z.iso.datetime({ offset: true }),
      endUtcOffset: z
        .string()
        .regex(/^-?\d{1,6}s$/)
        .default("0s")
        .transform((offset) => Number.parseInt(offset, 10)),
    }),
    summary: z.object({ minutesAsleep: int64.optional() }).optional(),
  }),
});

/**
 * One point per civil day of `range`, newest first, following every page.
 * Google's days are the user's civil days, taken as given; its end is exclusive.
 */
function dailyRollUp<T>(
  google: GoogleConnection,
  dataType: string,
  scope: string,
  range: DayRange,
  pointSchema: z.ZodType<T>,
): Promise<T[]> {
  const url = `${google.endpoints.health}/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`;
  const request = {
    range: { start: civilStart(range.from), end: civilStart(addDays(range.to, 1)) },
    windowSizeDays: 1,
  };
  return everyPage(dataType, rollUpPage(pointSchema), (pageToken) =>
    google.postJson(url, pageToken ? { ...request, pageToken } : request, [scope]),
  );
}

/** The data points `filter` selects, following every page. */
function listDataPoints<T>(
  google: GoogleConnection,
  dataType: string,
  scope: string,
  filter: string,
  pointSchema: z.ZodType<T>,
): Promise<T[]> {
  return everyPage(dataType, dataPointsPage(pointSchema), (pageToken) => {
    const url = new URL(`${google.endpoints.health}/users/me/dataTypes/${dataType}/dataPoints`);
    url.searchParams.set("filter", filter);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return google.getJson(url.href, [scope]);
  });
}

interface Page<T> {
  points: T[];
  nextPageToken?: string | undefined;
}

/** A roll-up's page; Google leaves the list out when no day has data. */
const rollUpPage = <T>(point: z.ZodType<T>): z.ZodType<Page<T>> =>
  z
    .object({ rollupDataPoints: z.array(point).default([]), nextPageToken: z.string().optional() })
    .transform(({ rollupDataPoints, nextPageToken }) => ({ points: rollupDataPoints, nextPageToken }));

const dataPointsPage = <T>(point: z.ZodType<T>): z.ZodType<Page<T>> =>
  z
    .object({ dataPoints: z.array(point).default([]), nextPageToken: z.string().optional() })
    .transform(({ dataPoints, nextPageToken }) => ({ points: dataPoints, nextPageToken }));

async function everyPage<T>(
  dataType: string,
  pageSchema: z.ZodType<Page<T>>,
  fetchPage: (pageToken: string | undefined) => Promise<GoogleResponse>,
): Promise<T[]> {
  const points: T[] = [];
  let pageToken: string | undefined;
  do {
    const { status, body } = await fetchPage(pageToken);
    if (status !== 200) throw failure(dataType, status, errorReason(body));
    const page = pageSchema.safeParse(body);
    if (!page.success) throw unexpected(`${dataType}: ${z.prettifyError(page.error)}`);
    points.push(...page.data.points);
    pageToken = page.data.nextPageToken;
  } while (pageToken);
  return points;
}

/** A non-200 named by Google's reason code; a rate limit is `unreachable`, since the next poll retries it. */
function failure(dataType: string, status: number, reason: string | undefined): GoogleError {
  if (status === 403) return forbidden(dataType, reason, REASON_HINTS);
  const detail = reason ? ` (${reason})` : "";
  if (status === 429) return new GoogleError("unreachable", `${dataType}: rate limited${detail}`);
  return unexpected(`${dataType} answered HTTP ${status}${detail}`);
}

/** Midnight starting a local date, as a Google CivilDateTime. */
function civilStart(date: string): { date: CivilDate; time: { hours: number } } {
  const [year, month, day] = date.split("-").map(Number);
  return { date: { year: year!, month: month!, day: day! }, time: { hours: 0 } };
}

function dateOf({ year, month, day }: CivilDate): string {
  return [String(year).padStart(4, "0"), String(month).padStart(2, "0"), String(day).padStart(2, "0")].join("-");
}

/** `SERVICE_DISABLED` is the reason Google documents for an API not enabled; the API probe could not capture one. */
const REASON_HINTS = new Map([["SERVICE_DISABLED", "enable the Google Health API in your Cloud project"]]);

const errorInfoSchema = z.object({
  error: z.object({
    details: z.array(z.looseObject({ "@type": z.string(), reason: z.string().optional() })),
  }),
});

/** The `google.rpc.ErrorInfo` reason code, from the Health API's own error shape. */
function errorReason(body: unknown): string | undefined {
  const parsed = errorInfoSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const info = parsed.data.error.details.find((detail) => detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo");
  return info?.reason && /^[A-Z_]{1,64}$/.test(info.reason) ? info.reason : undefined;
}
