import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CALENDAR_SCOPES } from "../src/google-calendar/api.js";
import type { GoogleEndpoints } from "../src/google/oauth.js";

/** An events.list entry as Google sends it, extra fields included. */
export interface FakeEntry {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  eventType?: string;
  htmlLink?: string;
  hangoutLink?: string;
  attendees?: Array<{ email: string; self?: boolean; organizer?: boolean; responseStatus: string }>;
  conferenceData?: { entryPoints: Array<{ entryPointType: string; uri: string; pin?: string }> };
  recurrence?: string[];
  recurringEventId?: string;
  /** For a series: what Google returns in its place with `singleEvents=true`. */
  instances?: FakeEntry[];
}

export interface FakeCalendar {
  id: string;
  summary: string;
  summaryOverride?: string;
  primary?: boolean;
}

export const CLIENT_ID = "fake-client.apps.googleusercontent.test";
export const CLIENT_SECRET = "fake-secret";
export const REFRESH_TOKEN = "fake-refresh-token";
export const PRIMARY_ID = "me@example.test";

/** How one path answers instead of normally: a status with a JSON body, a raw body, or never. */
export type Fault = { status: number; body?: unknown } | { status: number; raw: string } | "hang";

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  /** The body parsed as JSON, when it is JSON. */
  json?: unknown;
  authorization?: string;
  /** The response body as sent, after any `fields` selection. */
  sent?: string;
}

export interface FakeZoneMinutes {
  fatBurn: number;
  cardio: number;
  peak: number;
}

/** A sleep session; Google's response carries instants and UTC offsets, never civil times. */
export interface FakeSleep {
  /** An instant, e.g. `2026-10-24T10:10:00Z`. */
  start: string;
  end: string;
  /** Seconds east of UTC at the end, e.g. -14400 for EDT. */
  endUtcOffset: number;
  minutesAsleep: number;
  nap?: boolean;
}

/** A Google Health civil date, as the API probe recorded it. */
interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const civilDate = (date: string): CivilDate => {
  const [year, month, day] = date.split("-").map(Number);
  return { year: year!, month: month!, day: day! };
};
const dateOf = ({ year, month, day }: CivilDate): string =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const nextDate = (date: string): string => {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
};

/** A stand-in for Google's consent page, token endpoint, Calendar API and Health API on 127.0.0.1. */
export class FakeGoogle {
  calendars: FakeCalendar[] = [{ id: PRIMARY_ID, summary: PRIMARY_ID, primary: true }];
  /** Keyed by calendar id; `primary` resolves to the primary calendar's id. */
  readonly entries = new Map<string, FakeEntry[]>();
  pageSize = 250;
  /** Daily step counts by local date. A day left out has no data, and Google leaves it out of the roll-up too. */
  readonly steps = new Map<string, number>();
  /** Daily zone sums by local date, already weighted as Google sends them (cardio and peak count double). */
  readonly activeZoneMinutes = new Map<string, FakeZoneMinutes>();
  /** Daily resting heart rate in bpm by local date; a day left out has no data. */
  readonly restingHeartRate = new Map<string, number>();
  /** Sleep sessions in any order; Google lists them newest first. */
  sleep: FakeSleep[] = [];
  /** Points per Health page; Google pages only when asked to (sleep at most 25), but the reader follows any `nextPageToken`. */
  healthPageSize = 1000;
  /** What the token endpoint says was granted on a refresh. */
  grantedScopes: readonly string[] = CALENDAR_SCOPES;
  readonly refreshTokens = new Set([REFRESH_TOKEN]);
  /** When set, a refresh also issues a new refresh token, which Google may do. */
  rotateRefreshTokens = false;
  /** Each access token Google honours, with the scopes it carries. */
  readonly accessTokens = new Map<string, readonly string[]>();
  readonly requests: RecordedRequest[] = [];
  /** Keyed by request path, e.g. `/calendar/v3/calendars/primary/events`. */
  readonly faults = new Map<string, Fault>();
  /** What Chris does on the consent page: grant (the scopes in `grantedScopes`) or deny. */
  consent: "grant" | "deny" = "grant";
  /** Runs while a refresh is in flight, before Google answers it. */
  beforeRefresh: (() => void | Promise<void>) | undefined;
  /** Authorization codes handed out, with the PKCE challenge and redirect each was issued for. */
  private readonly codes = new Map<string, { challenge: string; redirectUri: string }>();
  private issued = 0;
  private server = http.createServer((req, res) => void this.handle(req, res));

  async listen(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  get endpoints(): GoogleEndpoints {
    return {
      authorize: `${this.url}/o/oauth2/v2/auth`,
      token: `${this.url}/token`,
      calendar: `${this.url}/calendar/v3`,
      health: `${this.url}/v4`,
    };
  }

  /** A fresh access token carrying `scopes`. */
  issueAccessToken(scopes: readonly string[] = this.grantedScopes): string {
    const token = `fake-access-${++this.issued}`;
    this.accessTokens.set(token, scopes);
    return token;
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", this.url);
    const request: RecordedRequest = {
      method: req.method ?? "",
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      form: new URLSearchParams(body),
      json: req.headers["content-type"]?.startsWith("application/json") ? JSON.parse(body) : undefined,
      authorization: req.headers.authorization,
    };
    this.requests.push(request);
    const reply = (status: number, json: unknown) => {
      const fields = request.query.get("fields");
      request.sent = JSON.stringify(status === 200 && fields ? select(json, fields) : json);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(request.sent);
    };

    const fault = this.faults.get(request.path);
    if (fault === "hang") return;
    if (fault) {
      res.writeHead(fault.status, { "content-type": "application/json" });
      res.end("raw" in fault ? fault.raw : JSON.stringify(fault.body ?? { error: { code: fault.status } }));
      return;
    }
    if (request.path === "/o/oauth2/v2/auth") {
      res.writeHead(302, { location: this.authorize(request.query) });
      return void res.end();
    }
    if (request.path === "/token") {
      if (request.form.get("grant_type") === "refresh_token") await this.beforeRefresh?.();
      return reply(...this.token(request));
    }
    const bearer = request.authorization?.replace(/^Bearer /, "");
    const scopes = bearer === undefined ? undefined : this.accessTokens.get(bearer);
    if (!scopes) return reply(401, { error: { code: 401, message: "Request had invalid authentication credentials." } });
    if (request.path.startsWith("/calendar/") && !CALENDAR_SCOPES.some((scope) => scopes.includes(scope))) {
      return reply(...insufficientScopes());
    }
    // The Health API refuses a token that carries any other API's scope.
    const disallowed = scopes.filter((scope) => !scope.startsWith(HEALTH_SCOPE_PREFIX));
    if (request.path.startsWith("/v4/") && disallowed.length > 0) return reply(...disallowedScopes(disallowed));
    if (request.path === "/calendar/v3/users/me/calendarList") {
      return reply(200, this.page(this.calendars, request.query));
    }
    const events = request.path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
    if (events) {
      const id = events[1] === "primary" ? this.calendars.find((c) => c.primary)?.id : events[1];
      const entries = id === undefined ? undefined : this.entries.get(id);
      if (!entries && !this.calendars.some((c) => c.id === id)) return reply(404, { error: { code: 404, message: "Not Found" } });
      return reply(200, this.page(this.listEvents(entries ?? [], request.query), request.query));
    }
    const rollUp = request.path.match(/^\/v4\/users\/me\/dataTypes\/(steps|active-zone-minutes)\/dataPoints:dailyRollUp$/);
    if (request.method === "POST" && rollUp) return reply(...this.dailyRollUp(rollUp[1]!, request.json));
    if (request.method === "GET" && request.path === "/v4/users/me/dataTypes/daily-resting-heart-rate/dataPoints") {
      return reply(...this.restingHeartRatePoints(request.query));
    }
    if (request.method === "GET" && request.path === "/v4/users/me/dataTypes/sleep/dataPoints") {
      return reply(...this.sleepPoints(request.query));
    }
    reply(404, { error: { code: 404, message: "Not Found" } });
  }

  /**
   * As the probe found it: one point per day in `[start, end)` that has data,
   * newest first, the day in `civilStartTime.date`, values as int64 strings.
   */
  private dailyRollUp(dataType: string, body: unknown): [number, unknown] {
    const request = body as {
      range?: { start?: { date?: CivilDate }; end?: { date?: CivilDate } };
      windowSizeDays?: number;
      pageToken?: string;
    };
    const start = request.range?.start?.date;
    const end = request.range?.end?.date;
    if (!start || !end || request.windowSizeDays !== 1) {
      return [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid rollup request." } }];
    }
    const values: Array<[string, object]> =
      dataType === "steps"
        ? [...this.steps].map(([date, count]) => [date, { steps: { countSum: String(count) } }])
        : [...this.activeZoneMinutes].map(([date, { fatBurn, cardio, peak }]) => [
            date,
            {
              activeZoneMinutes: {
                sumInFatBurnHeartZone: String(fatBurn),
                sumInCardioHeartZone: String(cardio),
                sumInPeakHeartZone: String(peak),
              },
            },
          ]);
    const days = values
      .filter(([date]) => date >= dateOf(start) && date < dateOf(end))
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, value]) => ({
        civilStartTime: { date: civilDate(date), time: {} },
        civilEndTime: { date: civilDate(nextDate(date)), time: {} },
        ...value,
      }));
    const { points, nextPageToken } = healthPage(days, request.pageToken, this.healthPageSize);
    return [200, { rollupDataPoints: points, ...(nextPageToken ? { nextPageToken } : {}) }];
  }

  /** Newest first, missing days left out, the date as an object and bpm as a string. */
  private restingHeartRatePoints(query: URLSearchParams): [number, unknown] {
    const range = filterRange(query, "daily_resting_heart_rate.date");
    if (!range) return invalidFilter();
    const days = [...this.restingHeartRate]
      .filter(([date]) => date >= range.from && date < range.to)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, bpm]) => ({
        dataSource: { platform: "FITBIT" },
        dailyRestingHeartRate: {
          date: civilDate(date),
          beatsPerMinute: String(bpm),
          dailyRestingHeartRateMetadata: { calculationMethod: "WITH_SLEEP" },
        },
      }));
    return dataPointsPage(days, query, this.healthPageSize);
  }

  /**
   * Sessions whose civil end time is in the filter's range, newest first. As
   * the probe found, the response has no civil fields, and flags that are
   * false are left out.
   */
  private sleepPoints(query: URLSearchParams): [number, unknown] {
    const range = filterRange(query, "sleep.interval.civil_end_time");
    if (!range) return invalidFilter();
    const civilEnd = (session: FakeSleep) =>
      new Date(Date.parse(session.end) + session.endUtcOffset * 1000).toISOString().slice(0, 19);
    const sessions = this.sleep
      .filter((session) => civilEnd(session) >= range.from && civilEnd(session) < range.to)
      .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))
      .map((session, index) => ({
        name: `users/fake/dataTypes/sleep/dataPoints/${index + 1}`,
        dataSource: { platform: "FITBIT" },
        sleep: {
          // A zero offset is left out, as Google leaves out every proto3 default.
          interval: {
            startTime: session.start,
            endTime: session.end,
            ...(session.endUtcOffset ? { startUtcOffset: `${session.endUtcOffset}s`, endUtcOffset: `${session.endUtcOffset}s` } : {}),
          },
          type: "STAGES",
          metadata: { processed: true, stagesStatus: "SUCCEEDED", mainSleep: true, ...(session.nap ? { nap: true } : {}) },
          summary: {
            minutesInSleepPeriod: String(session.minutesAsleep + 30),
            minutesAsleep: String(session.minutesAsleep),
            minutesAwake: "30",
          },
        },
      }));
    return dataPointsPage(sessions, query, Math.min(this.healthPageSize, 25));
  }

  /** As Google's consent page after Chris clicks: back to `redirect_uri` with `state` and a code or an error. */
  private authorize(query: URLSearchParams): string {
    const redirect = new URL(query.get("redirect_uri") ?? "");
    redirect.searchParams.set("state", query.get("state") ?? "");
    if (this.consent === "deny") {
      redirect.searchParams.set("error", "access_denied");
      return redirect.href;
    }
    const code = `fake-code-${this.codes.size + 1}`;
    this.codes.set(code, { challenge: query.get("code_challenge") ?? "", redirectUri: query.get("redirect_uri") ?? "" });
    redirect.searchParams.set("code", code);
    return redirect.href;
  }

  private token(request: RecordedRequest): [number, unknown] {
    if (request.form.get("grant_type") === "authorization_code") return this.exchange(request);
    const { form } = request;
    if (form.get("grant_type") !== "refresh_token" || form.get("client_id") !== CLIENT_ID) {
      return [400, { error: "invalid_request" }];
    }
    if (!this.refreshTokens.has(form.get("refresh_token") ?? "")) {
      return [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }];
    }
    const asked = form.get("scope")?.split(" ");
    if (asked?.some((scope) => !this.grantedScopes.includes(scope))) {
      return [400, { error: "invalid_scope", error_description: "Bad Request" }];
    }
    const scopes = asked ?? this.grantedScopes;
    const rotated = this.rotateRefreshTokens ? { refresh_token: this.newRefreshToken() } : {};
    return [
      200,
      { access_token: this.issueAccessToken(scopes), expires_in: 3599, scope: scopes.join(" "), token_type: "Bearer", ...rotated },
    ];
  }

  /** A code is good once, for the redirect it was issued to, and only with the verifier whose S256 hash was its challenge. */
  private exchange({ form }: RecordedRequest): [number, unknown] {
    const code = form.get("code") ?? "";
    const issued = this.codes.get(code);
    this.codes.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    if (
      form.get("client_id") !== CLIENT_ID ||
      issued === undefined ||
      issued.redirectUri !== form.get("redirect_uri") ||
      issued.challenge !== createHash("sha256").update(verifier).digest("base64url")
    ) {
      return [400, { error: "invalid_grant", error_description: "Bad Request" }];
    }
    const refreshToken = this.newRefreshToken();
    return [
      200,
      {
        access_token: this.issueAccessToken(),
        refresh_token: refreshToken,
        expires_in: 3599,
        scope: this.grantedScopes.join(" "),
        token_type: "Bearer",
      },
    ];
  }

  private newRefreshToken(): string {
    const refreshToken = `fake-refresh-${this.refreshTokens.size + 1}`;
    this.refreshTokens.add(refreshToken);
    return refreshToken;
  }

  /**
   * Like Google: expands series only with `singleEvents`, and keeps entries
   * ending after timeMin and starting before timeMax. Unlike Google it also
   * sends cancelled entries, so the Adapter's own filter is what drops them.
   */
  private listEvents(entries: FakeEntry[], query: URLSearchParams): FakeEntry[] {
    const single = query.get("singleEvents") === "true";
    const expanded = entries.flatMap((entry) => (single && entry.instances ? entry.instances : [entry]));
    const min = Date.parse(query.get("timeMin") ?? "");
    const max = Date.parse(query.get("timeMax") ?? "");
    const instant = (time: FakeEntry["start"]) => Date.parse(time.dateTime ?? `${time.date}T00:00:00`);
    return expanded.filter(
      (entry) => (Number.isNaN(min) || instant(entry.end) > min) && (Number.isNaN(max) || instant(entry.start) < max),
    );
  }

  private page<T>(all: T[], query: URLSearchParams): { items: T[]; nextPageToken?: string } {
    const from = Number(query.get("pageToken") ?? "0");
    const to = from + this.pageSize;
    return { items: all.slice(from, to), ...(to < all.length ? { nextPageToken: String(to) } : {}) };
  }
}

/** The `[from, to)` of a Health list filter `field >= "from" AND field < "to"`, the only shape the hub sends. */
function filterRange(query: URLSearchParams, field: string): { from: string; to: string } | undefined {
  const match = query.get("filter")?.match(/^(\S+) >= "([^"]+)" AND (\S+) < "([^"]+)"$/);
  if (!match || match[1] !== field || match[3] !== field) return undefined;
  return { from: match[2]!, to: match[4]! };
}

const HEALTH_SCOPE_PREFIX = "https://www.googleapis.com/auth/googlehealth.";

/** The Calendar API's refusal of a token without its scopes. */
const insufficientScopes = (): [number, unknown] => [
  403,
  {
    error: {
      code: 403,
      message: "Request had insufficient authentication scopes.",
      errors: [{ message: "Insufficient Permission", domain: "global", reason: "insufficientPermissions" }],
      status: "PERMISSION_DENIED",
    },
  },
];

/** The Health API's refusal, in the observed API response shape, naming the other scopes as Google abbreviates them. */
const disallowedScopes = (scopes: readonly string[]): [number, unknown] => [
  403,
  {
    error: {
      code: 403,
      message: "The access token carries scopes this API does not allow.",
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "DISALLOWED_OAUTH_SCOPES",
          domain: "health.googleapis.com",
          metadata: {
            disallowed_scopes: scopes.map((scope) => `cl_${scope.split(".").at(-2)}_readonly`).join(","),
          },
        },
      ],
    },
  },
];

const invalidFilter = (): [number, unknown] => [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Invalid filter." } }];

function healthPage<T>(all: T[], pageToken: string | undefined, pageSize: number): { points: T[]; nextPageToken?: string } {
  const from = Number(pageToken ?? "0");
  const to = from + pageSize;
  return { points: all.slice(from, to), ...(to < all.length ? { nextPageToken: String(to) } : {}) };
}

function dataPointsPage(all: unknown[], query: URLSearchParams, pageSize: number): [number, unknown] {
  const { points, nextPageToken } = healthPage(all, query.get("pageToken") ?? undefined, pageSize);
  return [200, { dataPoints: points, ...(nextPageToken ? { nextPageToken } : {}) }];
}

/**
 * Google's partial response: `fields` names the keys to keep, `key(sub,...)`
 * selects within an object or each element of an array.
 */
function select(value: unknown, fields: string): unknown {
  if (Array.isArray(value)) return value.map((element) => select(element, fields));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [key, sub] of selections(fields)) {
    if (key in source) kept[key] = sub === undefined ? source[key] : select(source[key], sub);
  }
  return kept;
}

/** Splits `a,b(c,d(e)),f` at its top-level commas into `[a], [b, "c,d(e)"], [f]`. */
function selections(fields: string): Array<[string, string | undefined]> {
  const parts: Array<[string, string | undefined]> = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i <= fields.length; i++) {
    const char = fields[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if ((char === "," && depth === 0) || char === undefined) {
      const part = fields.slice(from, i);
      const open = part.indexOf("(");
      parts.push(open === -1 ? [part, undefined] : [part.slice(0, open), part.slice(open + 1, -1)]);
      from = i + 1;
    }
  }
  return parts;
}

/** The Desktop client JSON as Cloud Console downloads it. */
export function writeClientFile(file: string, endpoints: GoogleEndpoints): void {
  writeFileSync(
    file,
    JSON.stringify({
      installed: {
        client_id: CLIENT_ID,
        project_id: "fake-project",
        auth_uri: endpoints.authorize,
        token_uri: endpoints.token,
        client_secret: CLIENT_SECRET,
        redirect_uris: ["http://localhost"],
      },
    }),
    { mode: 0o600 },
  );
}
