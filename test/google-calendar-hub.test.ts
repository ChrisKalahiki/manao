import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SCOPES, readCalendars } from "../src/google-calendar/api.js";
import { GoogleConnection, GoogleError, writeToken } from "../src/google/oauth.js";
import { createAdapters, type GoogleCalendarConfig, parseConfig } from "../src/hub/config.js";
import { type Hub, startHub } from "../src/hub/hub.js";
import {
  CLIENT_ID,
  CLIENT_SECRET,
  FakeGoogle,
  type Fault,
  type FakeEntry,
  PRIMARY_ID,
  REFRESH_TOKEN,
  writeClientFile,
} from "./google-helper.js";
import { MemorySink } from "./helpers.js";

const SOURCE = "google-calendar:primary";
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const timed = (id: string, start: Date, end: Date, over: Partial<FakeEntry> = {}): FakeEntry => ({
  id,
  status: "confirmed",
  summary: id,
  start: { dateTime: start.toISOString(), timeZone: "America/Los_Angeles" },
  end: { dateTime: end.toISOString(), timeZone: "America/Los_Angeles" },
  eventType: "default",
  htmlLink: `https://calendar.example.test/event?eid=${id}`,
  ...over,
});

describe("Google Calendar hub seam", () => {
  let dir: string;
  let fake: FakeGoogle;
  let hub: Hub | undefined;
  let clock: Date;
  let clientFile: string;
  let tokenFile: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-google-"));
    fake = await new FakeGoogle().listen();
    // The token lives under XDG_DATA_HOME, so this keeps every test off the real one.
    vi.stubEnv("XDG_DATA_HOME", dir);
    clientFile = path.join(dir, "google.client.json");
    tokenFile = path.join(dir, "manao", "google-token.json");
    writeClientFile(clientFile, fake.endpoints);
    clock = local(21, 9);
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    await fake.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = (over: { expiresAt?: Date; scopes?: readonly string[] } = {}) =>
    writeToken(tokenFile, {
      accessToken: fake.issueAccessToken(),
      refreshToken: REFRESH_TOKEN,
      expiresAt: (over.expiresAt ?? new Date(clock.getTime() + 3_600_000)).toISOString(),
      scopes: [...(over.scopes ?? CALENDAR_SCOPES)],
    });
  const start = async (calendar: Partial<GoogleCalendarConfig> = {}, api: false | { port: number } = false) => {
    const config = parseConfig({ google: { client: clientFile }, sources: { googleCalendar: calendar }, api });
    const [adapter] = createAdapters(config, () => clock, { googleEndpoints: fake.endpoints, googleTimeoutMs: 500 });
    hub = await startHub({
      dbPath: path.join(dir, "hub.db"),
      adapters: [adapter!],
      eventRetentionDays: 30,
      api,
      now: () => clock,
      log: () => {},
    });
    return adapter!;
  };
  const appointments = () => hub!.store.items.list({ type: "appointment" });
  const health = () => hub!.store.health.list().find((h) => h.source === SOURCE);
  /** What the Adapter's read throws as things stand, with the `kind` other Google readers branch on. */
  const readFailure = async ({ calendars = ["primary"], endpoints = fake.endpoints } = {}) => {
    const google = new GoogleConnection({ clientFile, tokenFile, endpoints, now: () => clock, timeoutMs: 500 });
    try {
      await readCalendars(google, calendars, { timeMin: local(21, 0), timeMax: local(29, 0) });
    } catch (error) {
      if (error instanceof GoogleError) return { kind: error.kind, message: error.message };
      throw error;
    }
    throw new Error("the read succeeded");
  };

  it("serves the primary calendar's Appointments through the API, Healthy", async () => {
    await connect();
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);

    await start({}, { port: 0 });
    const response = await fetch(`${hub!.apiUrl}/api/items?type=appointment`);

    expect(await response.json()).toMatchObject({
      items: [{ source: SOURCE, type: "appointment", title: "standup", status: "upcoming", sourceOk: true }],
    });
    expect(health()).toMatchObject({ ok: true, healthy: true, staleAfterMs: 900_000 });
  });

  it("keeps only entries Chris has not declined, with his response", async () => {
    await connect();
    const at = (id: string, over: Partial<FakeEntry> = {}) => timed(id, local(21, 14), local(21, 15), over);
    const me = (responseStatus: string) => ({ attendees: [{ email: "other@example.test", responseStatus: "accepted" }, { email: PRIMARY_ID, self: true, responseStatus }] });
    fake.entries.set(PRIMARY_ID, [
      at("accepted", me("accepted")),
      at("tentative", me("tentative")),
      at("unanswered", me("needsAction")),
      at("declined", me("declined")),
      at("cancelled", { status: "cancelled" }),
      at("office", { eventType: "workingLocation" }),
      at("birthday", { eventType: "birthday" }),
      at("away", { eventType: "outOfOffice" }),
      at("focus", { eventType: "focusTime" }),
      at("flight", { eventType: "fromGmail" }),
      at("alone"),
    ]);

    await start();

    expect(appointments().map((item) => [item.title, item.data])).toEqual([
      ["accepted", expect.objectContaining({ response: "accepted", eventType: "default" })],
      ["alone", expect.objectContaining({ response: null })],
      ["away", expect.objectContaining({ response: null, eventType: "outOfOffice" })],
      ["flight", expect.objectContaining({ eventType: "fromGmail" })],
      ["focus", expect.objectContaining({ eventType: "focusTime" })],
      ["tentative", expect.objectContaining({ response: "tentative" })],
      ["unanswered", expect.objectContaining({ response: "needsAction" })],
    ]);
  });

  it("asks for Today through the end of daysAhead as occurrences in start order, following every page", async () => {
    await connect();
    fake.pageSize = 2;
    const weekly = (day: number) => timed(`weekly_202610${day}T170000Z`, local(day, 10), local(day, 11), { summary: "Weekly", recurringEventId: "weekly" });
    fake.entries.set(PRIMARY_ID, [
      { ...timed("weekly", local(14, 10), local(14, 11)), recurrence: ["RRULE:FREQ=DAILY"], instances: [21, 22, 23, 24, 25].map(weekly) },
    ]);

    await start({ daysAhead: 2 });

    expect(appointments().map((item) => [item.id, item.title])).toEqual([
      ["primary:weekly_20261021T170000Z", "Weekly"],
      ["primary:weekly_20261022T170000Z", "Weekly"],
      ["primary:weekly_20261023T170000Z", "Weekly"],
    ]);
    const requests = fake.requestsTo("/calendar/v3/calendars/primary/events");
    expect(requests.map((r) => r.query.get("pageToken"))).toEqual([null, "2"]);
    expect(Object.fromEntries(requests[0]!.query)).toEqual({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: local(21, 0).toISOString(),
      timeMax: local(24, 0).toISOString(),
      fields:
        "items(id,status,summary,location,start,end,eventType,htmlLink,hangoutLink,attendees(self,responseStatus),conferenceData(entryPoints(entryPointType,uri))),nextPageToken",
    });
    expect(Object.fromEntries(fake.requestsTo("/calendar/v3/users/me/calendarList")[0]!.query)).toEqual({
      fields: "items(id,summary,summaryOverride,primary),nextPageToken",
    });
  });

  it("stores what Chris acts on and never the description, attendees or dial-ins, under ids stable across fetches", async () => {
    await connect();
    const review = timed("review", local(21, 16), local(21, 17), {
      summary: "Design review",
      description: "private agenda",
      location: "Room 4",
      hangoutLink: "https://meet.example.test/abc",
      attendees: [{ email: PRIMARY_ID, self: true, organizer: true, responseStatus: "accepted" }],
      conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1-555-0100", pin: "1234" }] },
    });
    const offsite = { ...timed("offsite", local(22, 0), local(22, 0)), start: { date: "2026-10-22" }, end: { date: "2026-10-24" }, summary: undefined };
    const video = timed("video", local(23, 9), local(23, 10), {
      conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1-555-0100" }, { entryPointType: "video", uri: "https://video.example.test/x" }] },
    });
    fake.entries.set(PRIMARY_ID, [review, offsite, video]);
    const adapter = await start();
    const first = appointments();

    expect(first.map(({ id, title, status, attention, data }) => ({ id, title, status, attention, data }))).toEqual([
      {
        id: "primary:review",
        title: "Design review",
        status: "upcoming",
        attention: false,
        data: {
          allDay: false,
          start: local(21, 16).toISOString(),
          end: local(21, 17).toISOString(),
          location: "Room 4",
          calendarId: "primary",
          calendarName: PRIMARY_ID,
          meetingLink: "https://meet.example.test/abc",
          response: "accepted",
          eventType: "default",
          htmlLink: "https://calendar.example.test/event?eid=review",
        },
      },
      {
        id: "primary:offsite",
        title: "(no title)",
        status: "upcoming",
        attention: false,
        data: expect.objectContaining({ allDay: true, start: "2026-10-22", end: "2026-10-24", location: null, response: null }),
      },
      { id: "primary:video", title: "video", status: "upcoming", attention: false, data: expect.objectContaining({ meetingLink: "https://video.example.test/x" }) },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/private agenda|555-0100|1234|attendees|description/);
    const sent = fake.requestsTo("/calendar/v3/calendars/primary/events").map((r) => r.sent);
    expect(sent.join("")).toContain("Design review");
    // A dial-in's tel: URI still travels: partial response cannot select entry points by type. Its PIN does not.
    expect(sent.join("")).not.toMatch(/private agenda|1234|email|organizer|description/);

    clock = local(21, 16, 30);
    await adapter.refresh();
    const second = appointments();
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(second.map((item) => [item.status, item.updatedAt])).toEqual([
      ["ongoing", clock.toISOString()],
      ["upcoming", first[1]!.updatedAt],
      ["upcoming", first[2]!.updatedAt],
    ]);
  });

  it("serves every configured calendar, each Appointment named from the calendar list", async () => {
    await connect();
    fake.calendars = [
      { id: PRIMARY_ID, summary: PRIMARY_ID, summaryOverride: "Chris", primary: true },
      { id: "team@example.test", summary: "Team" },
    ];
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    fake.entries.set("team@example.test", [timed("retro", local(21, 11), local(21, 12))]);

    await start({ calendars: ["primary", "team@example.test"] });

    expect(appointments()).toMatchObject([
      { id: "primary:standup", data: { calendarId: "primary", calendarName: "Chris" } },
      { id: "team@example.test:retro", data: { calendarId: "team@example.test", calendarName: "Team" } },
    ]);
    expect(health()?.healthy).toBe(true);
  });

  it("refuses primary and the primary calendar's own id together, naming both, before reading any events", async () => {
    await connect();
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);

    await start({ calendars: ["primary", PRIMARY_ID] });

    expect(health()).toMatchObject({
      ok: false,
      error: `sources.googleCalendar.calendars: primary and ${PRIMARY_ID} are the same calendar; keep one`,
    });
    expect(fake.requests.filter((r) => r.path.endsWith("/events"))).toEqual([]);
    expect(appointments()).toEqual([]);
    expect(await readFailure({ calendars: ["primary", PRIMARY_ID] })).toMatchObject({ kind: "refused" });
  });

  /** The access token each refresh was granted, in order. */
  const granted = () => fake.requestsTo("/token").map((request) => (JSON.parse(request.sent!) as { access_token: string }).access_token);
  const eventsAuthorization = () => fake.requestsTo("/calendar/v3/calendars/primary/events").map((r) => r.authorization);

  it("reads with an access token narrowed to the Calendar's scopes, leaving the token file as the sign-in wrote it", async () => {
    // The sign-in's own access token is still current, and carries more than the Calendar's scopes.
    await connect({ scopes: [...CALENDAR_SCOPES, "https://www.googleapis.com/auth/googlehealth.sleep.readonly"] });
    const signedIn = readFileSync(tokenFile, "utf8");
    fake.grantedScopes = JSON.parse(signedIn).scopes;

    await start();

    expect(fake.requestsTo("/token").map((request) => Object.fromEntries(request.form))).toEqual([
      {
        grant_type: "refresh_token",
        refresh_token: REFRESH_TOKEN,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: [...CALENDAR_SCOPES].sort().join(" "),
      },
    ]);
    expect(eventsAuthorization()).toEqual([`Bearer ${granted()[0]}`]);
    expect(readFileSync(tokenFile, "utf8")).toBe(signedIn);
    expect(health()?.healthy).toBe(true);
  });

  it("keeps the narrowed access token until a minute before it expires", async () => {
    await connect();
    const adapter = await start();

    clock = new Date(clock.getTime() + 3_599_000 - 61_000);
    await adapter.refresh();
    expect(fake.requestsTo("/token")).toHaveLength(1);

    clock = new Date(clock.getTime() + 2_000);
    await adapter.refresh();
    expect(fake.requestsTo("/token")).toHaveLength(2);
    expect(eventsAuthorization()).toEqual([`Bearer ${granted()[0]}`, `Bearer ${granted()[0]}`, `Bearer ${granted()[1]}`]);
  });

  it("rewrites the token file owner-only only when Google issues a new refresh token", async () => {
    await connect();
    const signedIn = JSON.parse(readFileSync(tokenFile, "utf8"));
    fake.rotateRefreshTokens = true;

    await start();

    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toEqual({ ...signedIn, refreshToken: "fake-refresh-2" });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(tokenFile))).toEqual(["google-token.json"]);
    expect(health()?.healthy).toBe(true);
  });

  it("keeps a token a sign-in wrote during a refresh, and reads with it", async () => {
    await connect();
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    const signedIn = {
      accessToken: fake.issueAccessToken(),
      refreshToken: "fake-refresh-signed-in",
      expiresAt: new Date(clock.getTime() + 3_600_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
    };
    fake.refreshTokens.add(signedIn.refreshToken);
    fake.rotateRefreshTokens = true;
    fake.beforeRefresh = () => {
      fake.beforeRefresh = undefined;
      return writeToken(tokenFile, signedIn);
    };

    await start();

    expect(fake.requestsTo("/token").map((request) => request.form.get("refresh_token"))).toEqual([
      REFRESH_TOKEN,
      signedIn.refreshToken,
    ]);
    expect(eventsAuthorization()).toEqual([`Bearer ${granted()[1]}`]);
    const rotated = fake.requestsTo("/token").map((request) => (JSON.parse(request.sent!) as { refresh_token: string }).refresh_token);
    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toEqual({ ...signedIn, refreshToken: rotated[1] });
    expect(health()).toMatchObject({ ok: true, healthy: true });
  });

  it("never reuses a narrowed access token once a sign-in has replaced the refresh token", async () => {
    await connect();
    const adapter = await start();
    fake.refreshTokens.add("fake-refresh-signed-in");
    await writeToken(tokenFile, { ...JSON.parse(readFileSync(tokenFile, "utf8")), refreshToken: "fake-refresh-signed-in" });

    await adapter.refresh();

    expect(fake.requestsTo("/token").map((request) => request.form.get("refresh_token"))).toEqual([
      REFRESH_TOKEN,
      "fake-refresh-signed-in",
    ]);
    expect(eventsAuthorization().at(-1)).toBe(`Bearer ${granted()[1]}`);
  });

  it("picks up a token written while the hub runs on the next fetch", async () => {
    const adapter = await start();
    expect(health()?.ok).toBe(false);

    await connect();
    await adapter.refresh();

    expect(health()).toMatchObject({ ok: true, healthy: true });
  });

  it.each([
    [
      "a revoked refresh token",
      "not-connected",
      "not connected: run `manao auth google`",
      () => {
        fake.refreshTokens.clear();
        // Past the narrowed access token's expiry, so the refresh token is used.
        clock = new Date(clock.getTime() + 3_600_000);
      },
    ],
    [
      "a missing scope",
      "missing-scope",
      `missing scope ${CALENDAR_SCOPES[1]}: run \`manao auth google\``,
      () => connect({ scopes: [CALENDAR_SCOPES[0]!] }),
    ],
    ["a calendar the account does not have", "refused", "calendar team@example.test: not found", () => connect()],
  ])("keeps Appointments Stale on %s, naming it", async (_name, kind, error, breakIt) => {
    await connect({ expiresAt: new Date(clock.getTime() + 120_000) });
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    fake.calendars.push({ id: "team@example.test", summary: "Team" });
    const adapter = await start({ calendars: ["primary", "team@example.test"] });
    expect(appointments()).toHaveLength(1);

    fake.calendars.pop();
    await breakIt();
    clock = new Date(clock.getTime() + 300_000);
    await adapter.refresh();

    expect(health()).toMatchObject({ ok: false, error });
    expect(appointments().map((item) => [item.title, item.sourceOk])).toEqual([["standup", false]]);
    expect(await readFailure({ calendars: ["primary", "team@example.test"] })).toEqual({ kind, message: error });
  });

  it.each([
    [404, "not found"],
    [403, "forbidden"],
  ])("keeps every Appointment of both calendars Stale when one answers %i", async (status, cause) => {
    await connect();
    fake.calendars.push({ id: "team@example.test", summary: "Team" });
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    fake.entries.set("team@example.test", [timed("retro", local(21, 11), local(21, 12))]);
    const adapter = await start({ calendars: ["primary", "team@example.test"] });

    fake.entries.set(PRIMARY_ID, []);
    fake.faults.set("/calendar/v3/calendars/team@example.test/events", { status });
    await adapter.refresh();

    expect(health()).toMatchObject({ ok: false, error: `calendar team@example.test: ${cause}` });
    expect(appointments().map((item) => [item.title, item.sourceOk])).toEqual([
      ["standup", false],
      ["retro", false],
    ]);
    expect(await readFailure({ calendars: ["primary", "team@example.test"] })).toMatchObject({ kind: "refused" });
  });

  it.each([
    ["calendarList", "accessNotConfigured", "/calendar/v3/users/me/calendarList", "calendarList: forbidden (accessNotConfigured: enable the Google Calendar API in your Cloud project)"],
    ["calendarList", "rateLimitExceeded", "/calendar/v3/users/me/calendarList", "calendarList: forbidden (rateLimitExceeded)"],
    ["events.list", "rateLimitExceeded", "/calendar/v3/calendars/primary/events", "calendar primary: forbidden (rateLimitExceeded)"],
    ["calendarList", "not a code: see https://example.test", "/calendar/v3/users/me/calendarList", "calendarList: forbidden"],
  ])("names Google's reason when %s answers 403 with %s", async (_name, reason, path, error) => {
    await connect();
    fake.faults.set(path, {
      status: 403,
      body: { error: { code: 403, message: "long text naming the project", errors: [{ reason }] } },
    });
    await start();

    expect(health()).toMatchObject({ ok: false, error });
  });

  it.each<[string, Fault, string, string | RegExp]>([
    ["a 5xx", { status: 503, body: { error: { code: 503 } } }, "unreachable", "unreachable: HTTP 503"],
    ["a body that is not JSON", { status: 200, raw: "<html>" }, "unexpected", /^unexpected response from Google: .*not JSON/],
    [
      "a body of the wrong shape",
      { status: 200, body: { items: [{ id: 7 }] } },
      "unexpected",
      /^unexpected response from Google: calendar primary: /,
    ],
    ["no answer", "hang", "unreachable", "timed out after 500ms"],
  ])("keeps Appointments Stale on %s from events.list, naming it", async (_name, fault, kind, error) => {
    await connect();
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    const adapter = await start();

    fake.faults.set("/calendar/v3/calendars/primary/events", fault);
    await adapter.refresh();

    expect(health()).toMatchObject({ ok: false, error: typeof error === "string" ? error : expect.stringMatching(error) });
    expect(appointments().map((item) => [item.title, item.sourceOk])).toEqual([["standup", false]]);
    expect(await readFailure()).toMatchObject({ kind });
  });

  it("becomes Healthy again with the next good fetch", async () => {
    await connect();
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    const adapter = await start();
    fake.faults.set("/calendar/v3/users/me/calendarList", { status: 500 });
    await adapter.refresh();
    expect(health()).toMatchObject({ ok: false, error: "unreachable: HTTP 500" });

    fake.faults.clear();
    fake.entries.set(PRIMARY_ID, [timed("review", local(21, 16), local(21, 17))]);
    await adapter.refresh();

    expect(health()).toMatchObject({ ok: true, healthy: true });
    expect(appointments().map((item) => [item.title, item.sourceOk])).toEqual([["review", true]]);
  });

  it("checks the granted scopes before asking Google for anything", async () => {
    await connect({ scopes: [CALENDAR_SCOPES[0]!] });

    await start();

    expect(health()).toMatchObject({ ok: false, error: `missing scope ${CALENDAR_SCOPES[1]}: run \`manao auth google\`` });
    expect(fake.requests).toEqual([]);
  });

  it("names an unreachable Google rather than a sign-in problem", async () => {
    await connect();
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    const adapter = await start();
    const { endpoints } = fake;
    await fake.close();
    fake = await new FakeGoogle().listen();

    await adapter.refresh();

    expect(health()).toMatchObject({ ok: false, error: expect.stringMatching(/^unreachable: .+/) });
    expect(appointments().map((item) => item.sourceOk)).toEqual([false]);
    expect(await readFailure({ endpoints })).toMatchObject({ kind: "unreachable" });
  });

  describe("between fetches", () => {
    const TICK_MS = 30_000;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const tickAt = async (when: Date) => {
      clock = when;
      await vi.advanceTimersByTimeAsync(TICK_MS);
    };
    const eventReads = () => fake.requestsTo("/calendar/v3/calendars/primary/events").length;

    it("moves Status and Attention on time without a new fetch", async () => {
      await connect();
      fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
      await start();
      const seen = () => appointments().map((item) => [item.status, item.attention]);
      expect(seen()).toEqual([["upcoming", false]]);

      await tickAt(local(21, 9, 45));
      expect(seen()).toEqual([["upcoming", true]]);

      await tickAt(local(21, 10));
      expect(seen()).toEqual([["ongoing", true]]);

      await tickAt(local(21, 10, 15));
      expect(seen()).toEqual([["ended", false]]);
      expect(eventReads()).toBe(1);
    });

    it("moves updatedAt only on a tick that changes something", async () => {
      await connect();
      fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
      await start();
      const fetched = appointments()[0]!.updatedAt;

      await tickAt(local(21, 9, 30));
      expect(appointments()[0]!.updatedAt).toBe(fetched);

      await tickAt(local(21, 9, 45));
      expect(appointments()[0]!.updatedAt).toBe(local(21, 9, 45).toISOString());

      await tickAt(local(21, 9, 50));
      expect(appointments()[0]!.updatedAt).toBe(local(21, 9, 45).toISOString());
    });

    it("serves an Appointment that ended earlier Today as ended until the first fetch past midnight", async () => {
      await connect();
      fake.entries.set(PRIMARY_ID, [timed("breakfast", local(21, 8), local(21, 8, 30)), timed("tomorrow", local(22, 9), local(22, 10))]);
      const adapter = await start();
      expect(appointments().map((item) => [item.title, item.status])).toEqual([
        ["breakfast", "ended"],
        ["tomorrow", "upcoming"],
      ]);

      await tickAt(local(21, 23, 59));
      expect(appointments().map((item) => [item.title, item.status])).toEqual([
        ["breakfast", "ended"],
        ["tomorrow", "upcoming"],
      ]);

      clock = local(22, 0, 1);
      await adapter.refresh();
      expect(appointments().map((item) => item.title)).toEqual(["tomorrow"]);
    });

    it("keeps Health tied to fetches: a tick never reports ok", async () => {
      await connect();
      fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
      const adapter = await start();
      fake.accessTokens.clear();
      await adapter.refresh();
      const failed = health();
      expect(failed).toMatchObject({ ok: false, error: "not connected: run `manao auth google`" });

      await tickAt(local(21, 10));

      expect(appointments().map((item) => [item.status, item.attention, item.sourceOk])).toEqual([["ongoing", true, false]]);
      expect(health()).toEqual(failed);
    });

    it("retries a tick the store refused on the next tick", async () => {
      await connect();
      fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
      const sink = new MemorySink();
      const write = sink.replaceItems.bind(sink);
      let refuse = false;
      sink.replaceItems = (source, type, items) => {
        if (refuse) throw new Error("store unavailable");
        write(source, type, items);
      };
      const config = parseConfig({ google: { client: clientFile }, sources: { googleCalendar: {} }, api: false });
      const [adapter] = createAdapters(config, () => clock, { googleEndpoints: fake.endpoints, googleTimeoutMs: 500 });
      await adapter!.start(sink);
      try {
        refuse = true;
        await tickAt(local(21, 9, 45));
        expect(sink.lastHealth).toMatchObject({ ok: false, error: "could not store Appointments: store unavailable" });

        refuse = false;
        await tickAt(local(21, 9, 46));

        expect(sink.items.map((item) => [item.status, item.attention])).toEqual([["upcoming", true]]);
      } finally {
        await adapter!.stop();
      }
    });

    it("stops ticking along with the poll", async () => {
      await connect();
      await start();
      await hub!.stop();
      hub = undefined;

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("moves Status and Attention of the Appointments stored before a restart when the first fetch fails", async () => {
    await connect();
    fake.entries.set(PRIMARY_ID, [timed("standup", local(21, 10), local(21, 10, 15))]);
    clock = local(21, 9, 50);
    await start();
    expect(appointments().map((item) => [item.status, item.attention])).toEqual([["upcoming", true]]);
    await hub!.stop();

    clock = local(21, 10, 30);
    fake.faults.set("/calendar/v3/users/me/calendarList", { status: 503 });
    await start();

    expect(health()).toMatchObject({ ok: false, error: "unreachable: HTTP 503" });
    expect(appointments().map((item) => [item.title, item.status, item.attention, item.sourceOk])).toEqual([
      ["standup", "ended", false, false],
    ]);
  });

  it.each([
    ["not JSON", () => writeFileSync(tokenFile, "{"), "is corrupt (not JSON)"],
    [
      "missing a field",
      () => writeFileSync(tokenFile, JSON.stringify({ accessToken: "a", expiresAt: clock.toISOString(), scopes: [] })),
      "is corrupt (refreshToken: ",
    ],
    ["a folder", () => mkdirSync(tokenFile, { recursive: true }), "is unreadable (EISDIR: "],
  ])("names a token file that is %s rather than calling it not connected", async (_name, breakIt, cause) => {
    mkdirSync(path.dirname(tokenFile), { recursive: true });
    breakIt();

    await start();

    const error = health()?.error ?? "";
    const opening = `Google token file ${tokenFile} ${cause}`;
    const ending = "): run `manao auth google`";
    expect(error.slice(0, opening.length)).toBe(opening);
    expect(error.slice(-ending.length)).toBe(ending);
    expect(await readFailure()).toMatchObject({ kind: "not-connected" });
  });

  it("shows a path under the home directory as ~/ in Health, which the tailnet can read", async () => {
    vi.stubEnv("HOME", dir);
    mkdirSync(path.dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, "{");

    await start();

    expect(health()?.error).toBe("Google token file ~/manao/google-token.json is corrupt (not JSON): run `manao auth google`");
  });

  it("says to run the sign-in when there is no token, without failing startup", async () => {
    await start();

    expect(health()).toMatchObject({ ok: false, error: "not connected: run `manao auth google`" });
    expect(appointments()).toEqual([]);
    expect(await readFailure()).toMatchObject({ kind: "not-connected" });
  });
});
