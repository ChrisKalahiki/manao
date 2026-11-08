import { z } from "zod";
import { forbidden, type GoogleConnection, GoogleError, unexpected } from "../google/oauth.js";

/** Read-only: the calendar list and events, nothing else. */
export const CALENDAR_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];

const calendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        summaryOverride: z.string().optional(),
        primary: z.boolean().optional(),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});

/** Google's partial response for calendarList, matching `calendarListSchema`. */
const CALENDAR_LIST_FIELDS = "items(id,summary,summaryOverride,primary),nextPageToken";

const timeSchema = z.object({ dateTime: z.iso.datetime({ offset: true }).optional(), date: z.iso.date().optional() });

/** Only the fields an Appointment keeps; zod drops the rest (descriptions, attendee emails, dial-ins). */
const entrySchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  start: timeSchema,
  end: timeSchema,
  eventType: z.string().default("default"),
  htmlLink: z.string().optional(),
  hangoutLink: z.string().optional(),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
  conferenceData: z
    .object({ entryPoints: z.array(z.object({ entryPointType: z.string().optional(), uri: z.string().optional() })).optional() })
    .optional(),
});

/**
 * Google's partial response for events.list, matching `entrySchema`, so
 * descriptions, attendee emails and dial-ins never leave Google.
 */
const EVENTS_FIELDS =
  "items(id,status,summary,location,start,end,eventType,htmlLink,hangoutLink,attendees(self,responseStatus),conferenceData(entryPoints(entryPointType,uri))),nextPageToken";

const eventsSchema = z.object({ items: z.array(entrySchema).default([]), nextPageToken: z.string().optional() });

export type CalendarEntry = z.infer<typeof entrySchema>;

/** One configured calendar and every entry of it in the window. */
export interface CalendarRead {
  /** As configured, e.g. `primary`. */
  id: string;
  name: string;
  entries: CalendarEntry[];
}

export interface CalendarWindow {
  timeMin: Date;
  timeMax: Date;
}

/** All or nothing: any calendar's failure fails the read. */
export async function readCalendars(
  google: GoogleConnection,
  calendars: readonly string[],
  window: CalendarWindow,
): Promise<CalendarRead[]> {
  const list = await pages(google, `${google.endpoints.calendar}/users/me/calendarList`,
    { fields: CALENDAR_LIST_FIELDS },
    calendarListSchema, "calendarList");
  const resolved = calendars.map((id) => {
    const listed = list.find((calendar) => (id === "primary" ? calendar.primary : calendar.id === id));
    if (!listed) throw new GoogleError("refused", `calendar ${id}: not found`);
    return { id, listed };
  });
  // Refused rather than merged: Item ids carry the configured id, so which one survived would decide them.
  for (const [i, { id, listed }] of resolved.entries()) {
    const twin = resolved.slice(i + 1).find((other) => other.listed.id === listed.id);
    if (twin) {
      throw new GoogleError("refused", `sources.googleCalendar.calendars: ${id} and ${twin.id} are the same calendar; keep one`);
    }
  }
  const reads: CalendarRead[] = [];
  for (const { id, listed } of resolved) {
    const entries = await pages(
      google,
      `${google.endpoints.calendar}/calendars/${encodeURIComponent(id)}/events`,
      {
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: window.timeMin.toISOString(),
        timeMax: window.timeMax.toISOString(),
        fields: EVENTS_FIELDS,
      },
      eventsSchema,
      `calendar ${id}`,
    );
    reads.push({ id, name: listed.summaryOverride ?? listed.summary ?? id, entries });
  }
  return reads;
}

const REASON_HINTS = new Map([["accessNotConfigured", "enable the Google Calendar API in your Cloud project"]]);

const apiErrorSchema = z.object({ error: z.object({ errors: z.tuple([z.object({ reason: z.string().regex(/^[A-Za-z]{1,64}$/) })], z.unknown()) }) });

/** The Calendar API's reason code, from its own error shape. */
function errorReason(body: unknown): string | undefined {
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.errors[0].reason : undefined;
}

async function pages<T>(
  google: GoogleConnection,
  url: string,
  query: Record<string, string>,
  schema: z.ZodType<{ items: T[]; nextPageToken?: string }>,
  what: string,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams(query);
    if (pageToken) params.set("pageToken", pageToken);
    const { status, body } = await google.getJson(`${url}?${params}`, CALENDAR_SCOPES);
    if (status === 404) throw new GoogleError("refused", `${what}: not found`);
    if (status === 403) throw forbidden(what, errorReason(body), REASON_HINTS);
    if (status !== 200) throw unexpected(`${what} answered HTTP ${status}`);
    const page = schema.safeParse(body);
    if (!page.success) throw unexpected(`${what}: ${z.prettifyError(page.error)}`);
    items.push(...page.data.items);
    pageToken = page.data.nextPageToken;
  } while (pageToken);
  return items;
}
