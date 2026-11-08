import { fields, type StoredItem } from "../hub.js";
import { addDays, dateAt, localDate } from "../time.js";
import { LastKnown, Widget } from "./widget.js";

export interface AppointmentsWidgetProps {
  /** The `appointment` Items, in any order; with `agenda`, the Agenda's: Today's, in the hub's order. */
  appointments: StoredItem[];
  /** The hub's clock: Today, "now" and every countdown are read from it. */
  now: string;
  /** Lists the Agenda's Appointments as the hub ordered them, instead of the coming week by day. */
  agenda?: boolean;
}

/**
 * The fields of an `appointment` Item's `data` the widget shows, as the Google Calendar Adapter
 * sends them: instants for a timed Appointment, `YYYY-MM-DD` dates (end exclusive) for an all-day one.
 */
interface AppointmentData {
  allDay: boolean;
  start: string;
  end: string;
  location: string | null;
  meetingLink: string | null;
  response: string | null;
  eventType: string;
  htmlLink: string | null;
}

interface Appointment {
  item: StoredItem;
  data: AppointmentData;
  /** The date it is listed under: its first day, or Today while it runs over from an earlier one. */
  day: string;
}

interface Day {
  date: string;
  appointments: Appointment[];
}

const MINUTE = 60_000;

const RESPONSES: Record<string, string> = { tentative: "Tentative", needsAction: "Not answered" };

/** Entries that inform without asking for anything: shown quietly, and never raising Attention. */
const QUIET_TYPES: Record<string, string> = { outOfOffice: "Out of office", focusTime: "Focus time" };

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const SHORT_WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The coming week as Google Calendar holds it: one list per day, all-day entries first, then by
 * start. With `agenda`, Today's as the hub selected and ordered them, each row as the week shows it.
 */
export function AppointmentsWidget({ appointments, now, agenda = false }: AppointmentsWidgetProps) {
  const today = localDate(now);
  const span = agenda ? "today" : "this week";
  return (
    <Widget
      name="appointments"
      title="Appointments"
      count={count(appointments, span)}
      empty={appointments.length === 0 ? `Nothing on the calendar ${span}.` : null}
    >
      <LastKnown items={appointments} now={now} />
      {agenda ? (
        <ul class="rows">
          {appointments.map((item) => (
            <AppointmentRow
              key={`${item.source}/${item.id}`}
              appointment={{ item, data: appointmentData(item.data), day: today }}
              now={now}
            />
          ))}
        </ul>
      ) : (
        <ul class="appt-days">
          {byDay(appointments.map((item) => appointment(item, today))).map((day) => (
            <DayList key={day.date} day={day} today={today} now={now} />
          ))}
        </ul>
      )}
    </Widget>
  );
}

/** How many need the user, else how many there are `when`. */
function count(appointments: StoredItem[], when: string): string {
  const attention = appointments.filter((item) => item.attention).length;
  return attention > 0 ? `${attention} ${attention === 1 ? "needs" : "need"} you` : `${appointments.length} ${when}`;
}

function appointment(item: StoredItem, today: string): Appointment {
  const data = appointmentData(item.data);
  const first = data.allDay ? data.start : localDate(data.start);
  const known = /^\d{4}-\d{2}-\d{2}$/.test(first);
  return { item, data, day: known && first > today ? first : today };
}

function byDay(appointments: Appointment[]): Day[] {
  const days = new Map<string, Appointment[]>();
  for (const appointment of [...appointments].sort(compare)) {
    const list = days.get(appointment.day) ?? [];
    list.push(appointment);
    days.set(appointment.day, list);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, appointments: list }));
}

function compare(a: Appointment, b: Appointment): number {
  if (a.data.allDay !== b.data.allDay) return a.data.allDay ? -1 : 1;
  return a.data.start.localeCompare(b.data.start) || a.item.title.localeCompare(b.item.title);
}

function dayName(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  return WEEKDAY.format(dateAt(date));
}

function DayList({ day, today, now }: { day: Day; today: string; now: string }) {
  const id = `appt-day-${day.date}`;
  return (
    <li class="appt-day" aria-labelledby={id}>
      <div class="appt-day-head">
        <h3 id={id} class="appt-day-name">
          {dayName(day.date, today)}
        </h3>
        <time class="appt-day-date" dateTime={day.date}>
          {SHORT_DATE.format(dateAt(day.date))}
        </time>
      </div>
      <ul class="rows">
        {day.appointments.map((appointment) => (
          <AppointmentRow
            key={`${appointment.item.source}/${appointment.item.id}`}
            appointment={appointment}
            now={now}
          />
        ))}
      </ul>
    </li>
  );
}

function AppointmentRow({ appointment: { item, data, day }, now }: { appointment: Appointment; now: string }) {
  const id = `appt-${item.source}-${item.id}`;
  const state = stateText(item, data, now);
  const quiet = QUIET_TYPES[data.eventType];
  const response = data.response ? RESPONSES[data.response] : undefined;
  // Anyone can send the user an invitation whose video link points anywhere; Join waits until they have answered it.
  const join = data.response === "needsAction" ? null : data.meetingLink;
  return (
    <li
      class="row appt"
      data-status={item.status}
      data-attention={item.attention}
      data-quiet={quiet !== undefined}
      data-stale={!item.sourceOk}
      aria-labelledby={id}
    >
      <div class="row-line">
        <span class="appt-when">{when(data, day)}</span>
        {state && <span class="state">{state}</span>}
      </div>
      <h4 id={id} class="appt-title">
        {data.htmlLink ? (
          <a href={data.htmlLink} target="_blank" rel="noopener noreferrer">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h4>
      {(quiet || response || data.location || join) && (
        <p class="meta appt-meta">
          {quiet && <span class="appt-kind">{quiet}</span>}
          {response && <span class="appt-response">{response}</span>}
          {data.location && <span class="appt-location">{data.location}</span>}
          {join && (
            <a
              class="appt-join"
              href={join}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Join ${item.title}`}
            >
              Join
            </a>
          )}
        </p>
      )}
    </li>
  );
}

/** What is happening with it now, in words; null for an upcoming Appointment that needs nothing yet. */
function stateText(item: StoredItem, data: AppointmentData, now: string): string | null {
  if (item.status === "ended") return "Ended";
  if (item.status === "ongoing") return data.allDay ? null : "Now";
  if (!item.attention) return null;
  const minutes = Math.ceil((Date.parse(data.start) - Date.parse(now)) / MINUTE);
  return minutes > 0 ? `In ${minutes} min` : "Starting";
}

/** Its time range, naming the weekday of an end (or start) that falls outside the day it is listed under. */
function when(data: AppointmentData, day: string): string {
  if (data.allDay) {
    const last = addDays(data.end, -1);
    return last > data.start ? `All day, until ${WEEKDAY.format(dateAt(last))}` : "All day";
  }
  const clock = (at: string) => {
    const time = CLOCK.format(new Date(at));
    return localDate(at) === day ? time : `${SHORT_WEEKDAY.format(new Date(at))} ${time}`;
  };
  return `${clock(data.start)}–${clock(data.end)}`;
}

/** Narrows the wire's `data`; a link that is not https is left out rather than made clickable. */
function appointmentData(data: unknown): AppointmentData {
  const record = fields(data);
  const text = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  const link = (key: string) => {
    const value = text(key);
    return value?.startsWith("https://") ? value : null;
  };
  return {
    allDay: record.allDay === true,
    start: text("start") ?? "",
    end: text("end") ?? "",
    location: text("location"),
    meetingLink: link("meetingLink"),
    response: text("response"),
    eventType: text("eventType") ?? "default",
    htmlLink: link("htmlLink"),
  };
}
