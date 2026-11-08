import { z } from "zod";
import { localDate, startOfLocalDay } from "./local-time.js";

/**
 * The Appointment as every Source and reader shares it: its item type, when it
 * runs, and the rules read from that on the hub's clock. No Source owns it.
 */

export const APPOINTMENT_ITEM_TYPE = "appointment";

export type AppointmentStatus = "upcoming" | "ongoing" | "ended";

/** Runs between two ISO instants. */
export interface TimedAppointmentTime {
  allDay: false;
  start: string;
  end: string;
}

/** Runs between two `YYYY-MM-DD` dates read in the hub's zone, the end exclusive as Google sends it. */
export interface AllDayAppointmentTime {
  allDay: true;
  start: string;
  end: string;
}

export type AppointmentTime = TimedAppointmentTime | AllDayAppointmentTime;

/** Reads a stored `appointment` Item's `data` as its AppointmentTime, ignoring the other fields. */
export const appointmentTimeSchema = z.discriminatedUnion("allDay", [
  z.object({ allDay: z.literal(false), start: z.string(), end: z.string() }),
  z.object({ allDay: z.literal(true), start: z.string(), end: z.string() }),
]) satisfies z.ZodType<AppointmentTime>;

export function appointmentStatus(time: AppointmentTime, now: Date): AppointmentStatus {
  if (time.allDay) {
    const today = localDate(now);
    if (today < time.start) return "upcoming";
    return today < time.end ? "ongoing" : "ended";
  }
  const at = now.getTime();
  if (at < Date.parse(time.start)) return "upcoming";
  return at < Date.parse(time.end) ? "ongoing" : "ended";
}

/** Whether it runs at any time during the Today of `now`, ended or not. */
export function appointmentIsToday(time: AppointmentTime, now: Date): boolean {
  if (time.allDay) {
    const today = localDate(now);
    return time.start <= today && today < time.end;
  }
  return Date.parse(time.start) < startOfLocalDay(now, 1).getTime() && Date.parse(time.end) > startOfLocalDay(now).getTime();
}

const ATTENTION_LEAD_MS = 15 * 60_000;

/** Entry types that inform without needing the user to act. */
const QUIET_TYPES = new Set(["outOfOffice", "focusTime"]);

/** From 15 minutes before a timed Appointment starts until it ends; never for all-day ones. */
export function appointmentAttention(time: AppointmentTime & { eventType: string }, now: Date): boolean {
  if (time.allDay || QUIET_TYPES.has(time.eventType)) return false;
  const at = now.getTime();
  return at >= Date.parse(time.start) - ATTENTION_LEAD_MS && at < Date.parse(time.end);
}

interface Listed {
  title: string;
  data: AppointmentTime;
}

/** The order of one day's Appointments, as the dashboard lists every day: all-day first, then by start, then by title. */
export function compareAppointments(a: Listed, b: Listed): number {
  if (a.data.allDay !== b.data.allDay) return a.data.allDay ? -1 : 1;
  const start = a.data.allDay ? a.data.start.localeCompare(b.data.start) : Date.parse(a.data.start) - Date.parse(b.data.start);
  return start || a.title.localeCompare(b.title);
}
