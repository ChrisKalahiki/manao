import { render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";

const SOURCE = "google-calendar:primary";

/** An instant on a day of October 2026 in the zone the tests run in, as the hub sends it. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

/** Wednesday 21 October 2026, 10:00. */
const NOW = at(21, 10);

interface AppointmentSpec {
  id: string;
  title: string;
  status?: "upcoming" | "ongoing" | "ended";
  attention?: boolean;
  /** An instant for a timed Appointment, a date for an all-day one. */
  start: string;
  end: string;
  location?: string | null;
  meetingLink?: string | null;
  response?: "accepted" | "tentative" | "needsAction" | null;
  eventType?: string;
  htmlLink?: string | null;
  sourceOk?: boolean;
}

/** An `appointment` Item as the Google Calendar Adapter sends it through `/api/items`. */
function appointment(spec: AppointmentSpec) {
  const healthy = spec.sourceOk ?? true;
  return {
    source: SOURCE,
    type: "appointment",
    id: `primary:${spec.id}`,
    title: spec.title,
    status: spec.status ?? "upcoming",
    attention: spec.attention ?? false,
    updatedAt: at(21, 9),
    data: {
      allDay: !spec.start.includes("T"),
      start: spec.start,
      end: spec.end,
      calendarId: "primary",
      calendarName: "Chris",
      location: spec.location ?? null,
      meetingLink: spec.meetingLink ?? null,
      response: spec.response ?? null,
      eventType: spec.eventType ?? "default",
      htmlLink: spec.htmlLink === undefined ? `https://calendar.google.com/event?eid=${spec.id}` : spec.htmlLink,
    },
    sourceOk: healthy,
    lastOkAt: healthy ? NOW : at(21, 8),
  };
}

const calendar = (healthy: boolean) => ({
  source: SOURCE,
  ok: healthy,
  at: NOW,
  ...(healthy ? {} : { error: "not connected: run `manao auth google`" }),
  staleAfterMs: 900_000,
  lastOkAt: healthy ? NOW : at(21, 8),
  healthy,
});

const serve = (items: unknown[], sources: unknown[] = [calendar(true)]) => fakeHub({ now: NOW, items, sources });

const widget = async () => within(await screen.findByRole("region", { name: "Appointments" }));
const row = async (title: string) => (await widget()).findByRole("listitem", { name: title });

/** Each day's heading followed by its Appointments' titles, in the order a screen reader meets them. */
function week(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("h3, h4")).map((heading) =>
    heading.tagName === "H3" ? `# ${heading.textContent}` : (heading.textContent ?? ""),
  );
}

describe("Dashboard: Appointments widget", () => {
  beforeEach(() => {
    clockFarFromHub();
    showAll();
  });
  afterEach(resetBrowser);

  it("reads like the week: Today, Tomorrow, then weekdays, all-day first, then by start", async () => {
    serve([
      appointment({ id: "fri", title: "Dentist", start: at(23, 15), end: at(23, 16) }),
      appointment({ id: "late", title: "Retro", start: at(21, 16), end: at(21, 17) }),
      appointment({ id: "trip", title: "Offsite", start: "2026-10-22", end: "2026-10-24" }),
      appointment({ id: "early", title: "Standup", start: at(21, 9, 30), end: at(21, 9, 45), status: "ended" }),
      appointment({ id: "tom", title: "1:1", start: at(22, 11), end: at(22, 11, 30) }),
      appointment({ id: "holiday", title: "Founders' Day", start: "2026-10-21", end: "2026-10-22", status: "ongoing" }),
      appointment({ id: "next-wed", title: "Planning", start: at(28, 10), end: at(28, 11) }),
    ]);
    render(<App />);
    const region = await screen.findByRole("region", { name: "Appointments" });
    await within(region).findByRole("listitem", { name: "Standup" });

    expect(week(region)).toEqual([
      "# Today",
      "Founders' Day",
      "Standup",
      "Retro",
      "# Tomorrow",
      "Offsite",
      "1:1",
      "# Friday",
      "Dentist",
      "# Wednesday",
      "Planning",
    ]);
  });

  it("shows a multi-day or overnight Appointment once, on Today while it is ongoing", async () => {
    serve([
      appointment({ id: "away", title: "Away", start: "2026-10-19", end: "2026-10-23", status: "ongoing" }),
      appointment({ id: "night", title: "Deploy window", start: at(20, 22), end: at(21, 11), status: "ongoing" }),
      appointment({ id: "conf", title: "Conference", start: "2026-10-22", end: "2026-10-25" }),
    ]);
    render(<App />);
    const region = await screen.findByRole("region", { name: "Appointments" });
    await within(region).findByRole("listitem", { name: "Away" });

    expect(week(region)).toEqual(["# Today", "Away", "Deploy window", "# Tomorrow", "Conference"]);
    expect(within(await row("Away")).getByText("All day, until Thursday")).toBeTruthy();
  });

  it("shows each Appointment's time range, location and links that open it", async () => {
    serve([
      appointment({
        id: "review",
        title: "Design review",
        start: at(21, 14),
        end: at(21, 15, 30),
        location: "Room 4",
        meetingLink: "https://meet.google.com/abc-defg-hij",
      }),
      appointment({ id: "solo", title: "Lunch", start: at(21, 12), end: at(21, 13), htmlLink: null }),
      appointment({
        id: "odd",
        title: "Odd links",
        start: at(21, 17),
        end: at(21, 18),
        meetingLink: "javascript:alert(1)",
        htmlLink: "http://calendar.google.com/event",
      }),
    ]);
    render(<App />);

    const review = within(await row("Design review"));
    const range = review.getByText(/–/);
    expect(range.textContent).toBe(`${clock(at(21, 14))}–${clock(at(21, 15, 30))}`);
    expect(review.getByText("Room 4")).toBeTruthy();
    expect(review.getByRole("link", { name: "Join Design review" }).getAttribute("href")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(review.getByRole("link", { name: "Design review" }).getAttribute("href")).toBe(
      "https://calendar.google.com/event?eid=review",
    );

    const lunch = within(await row("Lunch"));
    expect(lunch.queryByRole("link")).toBeNull();
    expect(within(await row("Odd links")).queryByRole("link")).toBeNull();
  });

  it("offers no Join on an invitation Chris has not answered, since anyone can send one, but keeps Google's link", async () => {
    serve([
      appointment({
        id: "invite",
        title: "Vendor demo",
        start: at(21, 10, 10),
        end: at(21, 11),
        attention: true,
        response: "needsAction",
        meetingLink: "https://meet.example.test/anywhere",
      }),
    ]);
    render(<App />);

    const invite = within(await row("Vendor demo"));
    expect(invite.queryByRole("link", { name: /^Join/ })).toBeNull();
    expect(invite.getByRole("link", { name: "Vendor demo" }).getAttribute("href")).toBe(
      "https://calendar.google.com/event?eid=invite",
    );
  });

  it("marks ongoing and Attention Appointments in words, counted from the hub's clock, and ended ones", async () => {
    serve([
      appointment({
        id: "now",
        title: "Pairing",
        start: at(21, 9),
        end: at(21, 11),
        status: "ongoing",
        attention: true,
      }),
      appointment({ id: "soon", title: "Interview", start: at(21, 10, 12), end: at(21, 11), attention: true }),
      appointment({ id: "done", title: "Standup", start: at(21, 9), end: at(21, 9, 15), status: "ended" }),
      appointment({ id: "later", title: "Retro", start: at(21, 16), end: at(21, 17) }),
    ]);
    render(<App />);

    expect(within(await row("Pairing")).getByText("Now")).toBeTruthy();
    expect(within(await row("Interview")).getByText("In 12 min")).toBeTruthy();
    expect(within(await row("Standup")).getByText("Ended")).toBeTruthy();
    expect((await row("Retro")).querySelector(".state")).toBeNull();
    expect((await widget()).getByText("2 need you")).toBeTruthy();
  });

  it("labels tentative and unanswered invitations, and shows out-of-office and focus time quietly", async () => {
    serve([
      appointment({ id: "t", title: "Offsite planning", start: at(22, 9), end: at(22, 10), response: "tentative" }),
      appointment({ id: "n", title: "Vendor demo", start: at(22, 11), end: at(22, 12), response: "needsAction" }),
      appointment({ id: "a", title: "Sync", start: at(22, 13), end: at(22, 14), response: "accepted" }),
      appointment({ id: "o", title: "Out", start: "2026-10-23", end: "2026-10-24", eventType: "outOfOffice" }),
      appointment({ id: "f", title: "Deep work", start: at(22, 14), end: at(22, 16), eventType: "focusTime" }),
    ]);
    render(<App />);

    expect(within(await row("Offsite planning")).getByText("Tentative")).toBeTruthy();
    expect(within(await row("Vendor demo")).getByText("Not answered")).toBeTruthy();
    expect(within(await row("Sync")).queryByText(/Tentative|Not answered/)).toBeNull();
    const out = await row("Out");
    expect(within(out).getByText("Out of office")).toBeTruthy();
    expect(out.dataset.quiet).toBe("true");
    const focus = await row("Deep work");
    expect(within(focus).getByText("Focus time")).toBeTruthy();
    expect(focus.dataset.quiet).toBe("true");
    expect((await row("Sync")).dataset.quiet).toBe("false");
  });

  it("keeps Appointments from a Source that is not Healthy, marked as last known", async () => {
    serve(
      [appointment({ id: "x", title: "Standup", start: at(21, 11), end: at(21, 12), sourceOk: false })],
      [calendar(false)],
    );
    render(<App />);

    const region = await widget();
    await region.findByRole("listitem", { name: "Standup" });
    expect(region.getByText(/^Last known/).textContent).toBe("Last known, read 2 h ago");
  });

  it("says so when the week is empty, and leaves other Items alone", async () => {
    serve([
      {
        source: "brain-dump:todos",
        type: "todo",
        id: "todo-1",
        title: "Book flights",
        status: "open",
        attention: false,
        updatedAt: NOW,
        data: {},
        sourceOk: true,
        lastOkAt: NOW,
      },
    ]);
    render(<App />);

    const region = await widget();
    expect(region.getByText("Nothing on the calendar this week.")).toBeTruthy();
    expect(region.queryByText("Book flights")).toBeNull();
  });

  it("sits after Agents", async () => {
    serve([]);
    render(<App />);
    await widget();

    const titles = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(titles.slice(0, 2)).toEqual(["Agents", "Appointments"]);
  });
});

/** The local clock time the widget shows, so the test holds in any zone and locale. */
function clock(instant: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}
