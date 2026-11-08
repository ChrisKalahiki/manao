import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SCOPES } from "../src/google-calendar/api.js";
import { HEALTH_SCOPES } from "../src/google-health/api.js";
import { writeToken } from "../src/google/oauth.js";
import { createAdapters, type GoogleHealthConfig, parseConfig } from "../src/hub/config.js";
import { type Hub, startHub } from "../src/hub/hub.js";
import type { Metric } from "../src/measurement.js";
import { FakeGoogle, REFRESH_TOKEN, writeClientFile } from "./google-helper.js";

const SOURCE = "google-health:primary";
const ROLL_UP = "/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp";
const AZM_ROLL_UP = "/v4/users/me/dataTypes/active-zone-minutes/dataPoints:dailyRollUp";
const RESTING_HEART_RATE = "/v4/users/me/dataTypes/daily-resting-heart-rate/dataPoints";
const SLEEP = "/v4/users/me/dataTypes/sleep/dataPoints";
const local = (month: number, day: number, hour: number) => new Date(2026, month - 1, day, hour);

describe("Google Health hub seam", () => {
  let dir: string;
  let fake: FakeGoogle;
  let hub: Hub | undefined;
  let clock: Date;
  let clientFile: string;
  let tokenFile: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-health-"));
    fake = await new FakeGoogle().listen();
    // The token lives under XDG_DATA_HOME, so this keeps every test off the real one.
    vi.stubEnv("XDG_DATA_HOME", dir);
    clientFile = path.join(dir, "google.client.json");
    tokenFile = path.join(dir, "manao", "google-token.json");
    writeClientFile(clientFile, fake.endpoints);
    // Today is 2026-10-24 in any system zone.
    clock = local(10, 24, 9);
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    await fake.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = (scopes: readonly string[] = [...CALENDAR_SCOPES, ...HEALTH_SCOPES]) => {
    // A refresh is granted what the sign-in was, as Google does.
    fake.grantedScopes = scopes;
    return writeToken(tokenFile, {
      accessToken: fake.issueAccessToken(),
      refreshToken: REFRESH_TOKEN,
      expiresAt: new Date(clock.getTime() + 24 * 3_600_000).toISOString(),
      scopes: [...scopes],
    });
  };
  const start = async (sources: object = { googleHealth: {} }, api: false | { port: number } = false) => {
    await hub?.stop();
    const config = parseConfig({ google: { client: clientFile }, sources, api });
    const adapters = createAdapters(config, () => clock, { googleEndpoints: fake.endpoints, googleTimeoutMs: 500 });
    hub = await startHub({
      dbPath: path.join(dir, "hub.db"),
      adapters,
      eventRetentionDays: 30,
      api,
      now: () => clock,
      log: () => {},
    });
    return adapters.find((adapter) => adapter.id === SOURCE);
  };
  const startHealth = (health: Partial<GoogleHealthConfig> = {}) => start({ googleHealth: health });
  const stored = (metric?: Metric) => hub!.store.measurements.list({ metric }).map((m) => [m.date, m.value]);
  const health = (source = SOURCE) => hub!.store.health.list().find((h) => h.source === source);
  /** The days each roll-up asked for, `[first, day after last]`, as Google's exclusive end. */
  const ranges = () =>
    fake.requestsTo(ROLL_UP).map(({ json }) => {
      const { range } = json as { range: Record<"start" | "end", { date: { year: number; month: number; day: number } }> };
      const date = ({ year, month, day }: { year: number; month: number; day: number }) =>
        `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return [date(range.start.date), date(range.end.date)];
    });

  it("backfills 30 days on the first run and serves the steps through the API, Healthy", async () => {
    await connect();
    for (const [date, count] of [["2026-09-23", 1], ["2026-09-24", 2], ["2026-10-01", 3], ["2026-10-24", 4]] as const) {
      fake.steps.set(date, count);
    }

    await start({ googleHealth: {} }, { port: 0 });
    const reply = await (await fetch(`${hub!.apiUrl}/api/measurements?from=2026-09-01`)).json();

    expect(ranges()).toEqual([["2026-09-24", "2026-10-25"]]);
    expect(fake.requestsTo(ROLL_UP)[0]?.json).toMatchObject({
      range: { start: { time: { hours: 0 } }, end: { time: { hours: 0 } } },
      windowSizeDays: 1,
    });
    expect(reply).toMatchObject({
      measurements: [
        { source: SOURCE, metric: "steps", date: "2026-09-24", value: 2, unit: "count", sourceOk: true },
        { source: SOURCE, metric: "steps", date: "2026-10-01", value: 3, unit: "count", sourceOk: true },
        { source: SOURCE, metric: "steps", date: "2026-10-24", value: 4, unit: "count", sourceOk: true },
      ],
    });
    expect(health()).toMatchObject({ ok: true, healthy: true, staleAfterMs: 10_800_000 });
  });

  it("reaches back only backfillDays on the first run", async () => {
    await connect();

    await startHealth({ backfillDays: 3 });

    expect(ranges()).toEqual([["2026-10-21", "2026-10-25"]]);
  });

  it("reads yesterday and Today on each later refresh, picking up a late sync", async () => {
    await connect();
    fake.steps.set("2026-10-23", 100);
    fake.steps.set("2026-10-24", 50);
    const adapter = await startHealth();

    fake.steps.set("2026-10-23", 4000);
    fake.steps.set("2026-10-24", 900);
    clock = local(10, 24, 10);
    await adapter!.refresh();

    expect(ranges().at(-1)).toEqual(["2026-10-23", "2026-10-25"]);
    expect(stored()).toEqual([
      ["2026-10-23", 4000],
      ["2026-10-24", 900],
    ]);
  });

  it("stores nothing for a day with no data, and keeps a reported zero", async () => {
    await connect();
    fake.steps.set("2026-10-21", 7);
    fake.steps.set("2026-10-23", 0);

    await startHealth();

    expect(stored()).toEqual([
      ["2026-10-21", 7],
      ["2026-10-23", 0],
    ]);
  });

  it("keeps a stored day that a later read has no data for", async () => {
    await connect();
    fake.steps.set("2026-10-24", 50);
    const adapter = await startHealth();

    fake.steps.delete("2026-10-24");
    await adapter!.refresh();

    expect(stored()).toEqual([["2026-10-24", 50]]);
  });

  it("follows every page of the roll-up", async () => {
    await connect();
    for (let day = 18; day <= 24; day++) fake.steps.set(`2026-10-${day}`, day);
    fake.healthPageSize = 3;

    await startHealth();

    expect(stored()).toHaveLength(7);
    expect(fake.requestsTo(ROLL_UP).map(({ json }) => (json as { pageToken?: string }).pageToken)).toEqual([undefined, "3", "6"]);
    expect(new Set(ranges().map(String)).size).toBe(1);
  });

  it("catches up after a restart from the day after the latest Measurement, keeping what it stored", async () => {
    await connect();
    fake.steps.set("2026-10-24", 50);
    await startHealth();

    clock = local(10, 29, 9);
    fake.steps.set("2026-10-26", 60);
    await startHealth();

    expect(ranges().at(-1)).toEqual(["2026-10-25", "2026-10-30"]);
    expect(stored()).toEqual([
      ["2026-10-24", 50],
      ["2026-10-26", 60],
    ]);
  });

  it("catches up at most backfillDays back", async () => {
    await connect();
    clock = local(8, 1, 9);
    fake.steps.set("2026-08-01", 50);
    await startHealth();

    clock = local(10, 24, 9);
    await startHealth();

    expect(ranges().at(-1)).toEqual(["2026-09-24", "2026-10-25"]);
  });

  it("writes nothing and keeps the Measurements, Stale, when any one Metric's read fails", async () => {
    await connect();
    fake.steps.set("2026-10-24", 50);
    const adapter = await startHealth();

    fake.steps.set("2026-10-24", 900);
    // Sleep is read last, so the steps above were read before the failure.
    fake.faults.set(SLEEP, { status: 503 });
    clock = local(10, 24, 10);
    await adapter!.refresh();

    expect(fake.requestsTo(ROLL_UP)).toHaveLength(2);
    expect(health()).toMatchObject({ ok: false, error: "unreachable: HTTP 503", lastOkAt: local(10, 24, 9).toISOString() });
    expect(hub!.store.measurements.list()).toEqual([expect.objectContaining({ date: "2026-10-24", value: 50, sourceOk: false })]);
  });

  it.each<[string, () => unknown, string]>([
    ["no token", () => rmSync(tokenFile), "not connected: run `manao auth google`"],
    [
      "a revoked refresh token",
      () => {
        fake.refreshTokens.clear();
        // Past the access token's expiry, so the refresh token is used.
        clock = local(10, 25, 10);
      },
      "not connected: run `manao auth google`",
    ],
    ["a 401", () => fake.accessTokens.clear(), "not connected: run `manao auth google`"],
    ["no answer", () => fake.faults.set(RESTING_HEART_RATE, "hang"), "timed out after 500ms"],
  ])("keeps the Measurements Stale on %s, naming it", async (_name, breakIt, error) => {
    await connect();
    fake.steps.set("2026-10-24", 50);
    const adapter = await startHealth();

    breakIt();
    await adapter!.refresh();

    expect(health()).toMatchObject({ ok: false, error });
    expect(hub!.store.measurements.list()).toEqual([expect.objectContaining({ date: "2026-10-24", value: 50, sourceOk: false })]);
  });

  it.each([
    ["MISSING_OAUTH_SCOPE", "steps: forbidden (MISSING_OAUTH_SCOPE)"],
    ["SERVICE_DISABLED", "steps: forbidden (SERVICE_DISABLED: enable the Google Health API in your Cloud project)"],
    ["not a code: see https://example.test", "steps: forbidden"],
  ])("names Google's reason %s for a refusal, never its message", async (reason, error) => {
    await connect();
    fake.faults.set(ROLL_UP, {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "long text naming the project",
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason,
              domain: "health.googleapis.com",
              metadata: { any_of_required: "activity_and_fitness_readonly" },
            },
          ],
        },
      },
    });

    await startHealth();

    expect(health()).toMatchObject({ ok: false, error });
  });

  it.each([
    [429, "RATE_LIMIT_EXCEEDED", "steps: rate limited (RATE_LIMIT_EXCEEDED)"],
    [400, "UNSUPPORTED_DATA_TYPE_ACTION", "unexpected response from Google: steps answered HTTP 400 (UNSUPPORTED_DATA_TYPE_ACTION)"],
  ])("names Google's reason for an HTTP %i, never its message", async (status, reason, error) => {
    await connect();
    fake.faults.set(ROLL_UP, {
      status,
      body: {
        error: {
          code: status,
          message: "long text naming the project",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "health.googleapis.com" }],
        },
      },
    });

    await startHealth();

    expect(health()).toMatchObject({ ok: false, error });
  });

  it("fails only Health when the token lacks its scopes, while the Calendar stays Healthy", async () => {
    await connect(CALENDAR_SCOPES);

    await start({ googleCalendar: {}, googleHealth: {} });

    expect(health()).toMatchObject({
      ok: false,
      error: `missing scope ${HEALTH_SCOPES[0]}: run \`manao auth google\``,
    });
    expect(health("google-calendar:primary")).toMatchObject({ ok: true, healthy: true });
    expect(fake.requestsTo(ROLL_UP)).toEqual([]);
  });

  it("reads with Calendar enabled too, each Source's requests carrying only its own scopes from one sign-in", async () => {
    await connect();
    fake.steps.set("2026-10-24", 50);

    await start({ googleCalendar: {}, googleHealth: {} });

    expect(health()).toMatchObject({ ok: true, healthy: true });
    expect(health("google-calendar:primary")).toMatchObject({ ok: true, healthy: true });
    expect(stored("steps")).toEqual([["2026-10-24", 50]]);
    const scopesOf = (prefix: string) =>
      new Set(
        fake.requests
          .filter((request) => request.path.startsWith(prefix))
          .flatMap((request) => fake.accessTokens.get(request.authorization?.replace(/^Bearer /, "") ?? "") ?? []),
      );
    expect(scopesOf("/calendar/")).toEqual(new Set(CALENDAR_SCOPES));
    expect(scopesOf("/v4/")).toEqual(new Set(HEALTH_SCOPES));
  });

  it("stores active zone minutes as the sum of Google's already weighted zone sums, a zero kept and a missing day left out", async () => {
    await connect();
    fake.activeZoneMinutes.set("2026-10-22", { fatBurn: 34, cardio: 2, peak: 0 });
    fake.activeZoneMinutes.set("2026-10-23", { fatBurn: 0, cardio: 0, peak: 0 });
    fake.activeZoneMinutes.set("2026-10-24", { fatBurn: 10, cardio: 6, peak: 4 });
    fake.healthPageSize = 2;

    await start({ googleHealth: {} }, { port: 0 });
    const reply = await (await fetch(`${hub!.apiUrl}/api/measurements?metric=active-zone-minutes`)).json();

    expect(reply).toMatchObject({
      measurements: [
        { metric: "active-zone-minutes", date: "2026-10-22", value: 36, unit: "minutes", sourceOk: true },
        { metric: "active-zone-minutes", date: "2026-10-23", value: 0, unit: "minutes", sourceOk: true },
        { metric: "active-zone-minutes", date: "2026-10-24", value: 20, unit: "minutes", sourceOk: true },
      ],
    });
    expect(fake.requestsTo(AZM_ROLL_UP)).toHaveLength(2);
  });

  it("stores resting heart rate in bpm per date from every page, asking for the window's dates", async () => {
    await connect();
    fake.restingHeartRate.set("2026-10-20", 81);
    fake.restingHeartRate.set("2026-10-22", 0);
    fake.restingHeartRate.set("2026-10-24", 64);
    fake.restingHeartRate.set("2026-10-25", 99);
    fake.healthPageSize = 2;

    await startHealth({ backfillDays: 5 });

    expect(hub!.store.measurements.list({ metric: "resting-heart-rate" })).toEqual([
      expect.objectContaining({ date: "2026-10-20", value: 81, unit: "bpm" }),
      expect.objectContaining({ date: "2026-10-22", value: 0, unit: "bpm" }),
      expect.objectContaining({ date: "2026-10-24", value: 64, unit: "bpm" }),
    ]);
    expect(fake.requestsTo(RESTING_HEART_RATE).map(({ query }) => [query.get("filter"), query.get("pageToken")])).toEqual([
      ['daily_resting_heart_rate.date >= "2026-10-19" AND daily_resting_heart_rate.date < "2026-10-25"', null],
      ['daily_resting_heart_rate.date >= "2026-10-19" AND daily_resting_heart_rate.date < "2026-10-25"', "2"],
    ]);
  });

  it("stores sleep as the minutes asleep of every session ending on a local date, naps included, from every page", async () => {
    await connect();
    const edt = -14_400;
    fake.sleep = [
      // A reported zero.
      { start: "2026-10-18T09:00:00Z", end: "2026-10-18T12:00:00Z", endUtcOffset: 0, minutesAsleep: 0 },
      // Ends 01:30 on the 20th two hours east of UTC, while UTC is still on the 19th.
      { start: "2026-10-19T21:00:00Z", end: "2026-10-19T23:30:00Z", endUtcOffset: 7200, minutesAsleep: 45 },
      // Ends 22:30 on the 21st in EDT, while UTC is already on the 22nd.
      { start: "2026-10-22T01:00:00Z", end: "2026-10-22T02:30:00Z", endUtcOffset: edt, minutesAsleep: 60 },
      // From 23:30 on the 22nd to 06:45 on the 23rd: the day Chris woke up.
      { start: "2026-10-23T03:30:00Z", end: "2026-10-23T10:45:00Z", endUtcOffset: edt, minutesAsleep: 380 },
      { start: "2026-10-23T18:00:00Z", end: "2026-10-23T18:40:00Z", endUtcOffset: edt, minutesAsleep: 35, nap: true },
      // Two sessions ending on the 24th, at 03:45 and 10:45.
      { start: "2026-10-24T02:00:00Z", end: "2026-10-24T07:45:00Z", endUtcOffset: edt, minutesAsleep: 90 },
      { start: "2026-10-24T09:00:00Z", end: "2026-10-24T14:45:00Z", endUtcOffset: edt, minutesAsleep: 300 },
    ];
    fake.healthPageSize = 3;

    await startHealth();

    expect(hub!.store.measurements.list({ metric: "sleep" }).map((m) => [m.date, m.value, m.unit])).toEqual([
      ["2026-10-18", 0, "minutes"],
      ["2026-10-20", 45, "minutes"],
      ["2026-10-21", 60, "minutes"],
      ["2026-10-23", 415, "minutes"],
      ["2026-10-24", 390, "minutes"],
    ]);
    expect(fake.requestsTo(SLEEP).map(({ query }) => [query.get("filter"), query.get("pageToken")])).toEqual([
      ['sleep.interval.civil_end_time >= "2026-09-24T00:00:00" AND sleep.interval.civil_end_time < "2026-10-25T00:00:00"', null],
      ['sleep.interval.civil_end_time >= "2026-09-24T00:00:00" AND sleep.interval.civil_end_time < "2026-10-25T00:00:00"', "3"],
      ['sleep.interval.civil_end_time >= "2026-09-24T00:00:00" AND sleep.interval.civil_end_time < "2026-10-25T00:00:00"', "6"],
    ]);
  });

  it("reads a session in UTC, whose zero offset Google leaves out, as ending on its UTC date", async () => {
    await connect();
    fake.sleep = [{ start: "2026-10-23T23:00:00Z", end: "2026-10-24T06:30:00Z", endUtcOffset: 0, minutesAsleep: 420 }];

    await startHealth();

    expect(hub!.store.measurements.list({ metric: "sleep" }).map((m) => [m.date, m.value])).toEqual([["2026-10-24", 420]]);
  });

  it("checks each Metric's own scope, so a token without sleep fails Health naming that scope", async () => {
    await connect([...CALENDAR_SCOPES, ...HEALTH_SCOPES.filter((scope) => !scope.includes("sleep"))]);
    fake.steps.set("2026-10-24", 50);

    await startHealth();

    expect(health()).toMatchObject({
      ok: false,
      error: "missing scope https://www.googleapis.com/auth/googlehealth.sleep.readonly: run `manao auth google`",
    });
    expect(fake.requestsTo(ROLL_UP)).toHaveLength(1);
    expect(fake.requestsTo(SLEEP)).toEqual([]);
    expect(stored()).toEqual([]);
  });

  it("keeps the Measurements once Health is turned off", async () => {
    await connect();
    fake.steps.set("2026-10-24", 50);
    await startHealth();

    await start({ googleCalendar: {} });

    expect(health()).toBeUndefined();
    expect(hub!.store.measurements.list()).toEqual([
      expect.objectContaining({ source: SOURCE, date: "2026-10-24", value: 50, sourceOk: false, lastOkAt: null }),
    ]);
  });

  it("carries on from the latest stored day when Health is turned back on", async () => {
    await connect();
    fake.steps.set("2026-10-24", 50);
    await startHealth();
    await start({ googleCalendar: {} });

    clock = local(10, 29, 9);
    fake.steps.set("2026-10-27", 60);
    await startHealth();

    expect(ranges().at(-1)).toEqual(["2026-10-25", "2026-10-30"]);
    expect(stored()).toEqual([
      ["2026-10-24", 50],
      ["2026-10-27", 60],
    ]);
    expect(health()).toMatchObject({ ok: true, healthy: true });
  });
});
