import { z } from "zod";
import {
  APPOINTMENT_ITEM_TYPE,
  type AppointmentStatus,
  type AppointmentTime,
  appointmentAttention,
  appointmentStatus,
  appointmentTimeSchema,
  compareAppointments,
} from "../appointment.js";
import type { HubItem } from "../core/types.js";
import { localDate } from "../local-time.js";
import type { CalendarEntry, CalendarRead } from "./api.js";

/** the user's own answer; null when they organize it with no one invited. */
export type AppointmentResponse = "accepted" | "tentative" | "needsAction" | null;

/** When it runs, instants or dates by `allDay`, and what the user acts on. */
export type AppointmentData = AppointmentTime & {
  calendarId: string;
  calendarName: string;
  location: string | null;
  /** Meet's link, else the first video entry point. */
  meetingLink: string | null;
  response: AppointmentResponse;
  eventType: string;
  /** Opens the entry in Google Calendar. */
  htmlLink: string | null;
};

export type AppointmentItem = HubItem<AppointmentData> & { status: AppointmentStatus };

const storedAppointmentSchema = z.object({
  source: z.string(),
  type: z.literal(APPOINTMENT_ITEM_TYPE),
  id: z.string(),
  title: z.string(),
  status: z.enum(["upcoming", "ongoing", "ended"]),
  attention: z.boolean(),
  updatedAt: z.string(),
  data: appointmentTimeSchema.and(
    z.object({
      calendarId: z.string(),
      calendarName: z.string(),
      location: z.string().nullable(),
      meetingLink: z.string().nullable(),
      response: z.enum(["accepted", "tentative", "needsAction"]).nullable(),
      eventType: z.string(),
      htmlLink: z.string().nullable(),
    }),
  ),
}) satisfies z.ZodType<AppointmentItem>;

/**
 * The Appointments a store kept from an earlier run, or none when any of them
 * is not in the shape this version writes: better none kept current on the
 * clock than some silently left out.
 */
export function storedAppointments(items: readonly HubItem[]): AppointmentItem[] {
  const parsed = z.array(storedAppointmentSchema).safeParse(items.filter((item) => item.type === APPOINTMENT_ITEM_TYPE));
  return parsed.success ? parsed.data : [];
}

const LEFT_OUT_TYPES = new Set(["workingLocation", "birthday"]);

/** Entries the user has not declined, from every calendar, by first day, each day in the order it is listed. */
export function normalizeAppointments(reads: CalendarRead[], at: string, now: Date, source: string): AppointmentItem[] {
  const items: AppointmentItem[] = [];
  for (const read of reads) {
    for (const entry of read.entries) {
      const data = appointmentData(entry, read);
      if (!data) continue;
      items.push({
        source,
        type: APPOINTMENT_ITEM_TYPE,
        id: `${read.id}:${entry.id}`,
        title: entry.summary || "(no title)",
        status: appointmentStatus(data, now),
        attention: appointmentAttention(data, now),
        updatedAt: at,
        data,
      });
    }
  }
  return items.sort((a, b) => firstDay(a.data).localeCompare(firstDay(b.data)) || compareAppointments(a, b));
}

function appointmentData(entry: CalendarEntry, read: CalendarRead): AppointmentData | null {
  if (entry.status === "cancelled" || LEFT_OUT_TYPES.has(entry.eventType)) return null;
  const self = entry.attendees?.find((attendee) => attendee.self);
  if (self?.responseStatus === "declined") return null;
  const time = appointmentTime(entry);
  if (!time) return null;
  return {
    ...time,
    calendarId: read.id,
    calendarName: read.name,
    location: entry.location ?? null,
    meetingLink: entry.hangoutLink ?? entry.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null,
    response: response(self?.responseStatus),
    eventType: entry.eventType,
    htmlLink: entry.htmlLink ?? null,
  };
}

function appointmentTime(entry: CalendarEntry): AppointmentTime | null {
  if (entry.start.dateTime && entry.end.dateTime) {
    return { allDay: false, start: new Date(entry.start.dateTime).toISOString(), end: new Date(entry.end.dateTime).toISOString() };
  }
  if (entry.start.date && entry.end.date) return { allDay: true, start: entry.start.date, end: entry.end.date };
  return null;
}

function response(status: string | undefined): AppointmentResponse {
  return status === "accepted" || status === "tentative" || status === "needsAction" ? status : null;
}

function firstDay(time: AppointmentTime): string {
  return time.allDay ? time.start : localDate(new Date(time.start));
}
