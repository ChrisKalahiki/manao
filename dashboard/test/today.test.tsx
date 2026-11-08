import { fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";
import { outline } from "./outline.js";

const NOW = "2026-10-19T08:00:00.000Z";

/** An Item as the hub sends it in the Agenda's lists. */
function item(source: string, type: string, title: string, over: { sourceOk?: boolean; updatedAt?: string } = {}) {
  return {
    source,
    type,
    id: title,
    title,
    status: "needs_attention",
    attention: true,
    updatedAt: over.updatedAt ?? "2026-10-19T07:55:00.000Z",
    data: {},
    sourceOk: over.sourceOk ?? true,
    lastOkAt: "2026-10-19T07:40:00.000Z",
  };
}

const calendarStale = {
  source: "google-calendar:primary",
  ok: false,
  at: NOW,
  error: "timed out after 10000ms",
  staleAfterMs: 900_000,
  lastOkAt: "2026-10-19T07:40:00.000Z",
  healthy: false,
};

const needsYou = async () => within(await screen.findByRole("region", { name: "Needs you" }));
const tab = (name: string) => screen.getByRole("link", { name });

/** Lets pending fetches and renders settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Taps a tab and waits until it is the current view; its reads start once Preact runs its effects. */
async function switchTo(name: string) {
  fireEvent.click(tab(name));
  await vi.waitFor(() => expect(tab(name).getAttribute("aria-current")).toBe("page"));
}

describe("Dashboard: the Today view", () => {
  beforeEach(() => {
    clockFarFromHub({ timers: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(resetBrowser);

  it("is the home, reading only /api/agenda, again every 10s", async () => {
    const hub = fakeHub({ now: NOW });
    render(<App />);
    await settle();

    expect(tab("Today").getAttribute("aria-current")).toBe("page");
    expect(hub.requests()).toEqual(["/api/agenda"]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.requests()).toEqual(["/api/agenda", "/api/agenda"]);
  });

  it("lists every Item that needs Chris under Needs you, in the hub's order, with its kind, Source and age", async () => {
    fakeHub({
      now: NOW,
      agenda: {
        attention: [
          item("google-calendar:primary", "appointment", "Standup", { updatedAt: "2026-10-19T07:48:00.000Z" }),
          item("herdr:local", "agent", "manao: claude"),
        ],
      },
    });
    render(<App />);
    const section = await needsYou();
    await section.findByRole("listitem", { name: "Standup" });

    expect(section.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Standup", "manao: claude"]);
    const standup = within(section.getByRole("listitem", { name: "Standup" }));
    expect(standup.getByText("Appointment")).toBeTruthy();
    expect(standup.getByText("google-calendar:primary")).toBeTruthy();
    expect(standup.getByText("12 min ago")).toBeTruthy();
    expect(within(section.getByRole("listitem", { name: "manao: claude" })).getByText("Agent")).toBeTruthy();
    expect(section.getByText("2")).toBeTruthy();
  });

  it("says so when nothing needs Chris", async () => {
    fakeHub({ now: NOW });
    render(<App />);

    expect((await needsYou()).getByText("Nothing needs you.")).toBeTruthy();
  });

  it("keeps a Stale Item in Needs you, marked as last known", async () => {
    fakeHub({
      now: NOW,
      agenda: {
        attention: [item("google-calendar:primary", "appointment", "Standup", { sourceOk: false }), item("herdr:local", "agent", "manao: claude")],
        staleSources: [calendarStale],
      },
    });
    render(<App />);
    const section = await needsYou();

    expect(within(await section.findByRole("listitem", { name: "Standup" })).getByText("last known")).toBeTruthy();
    expect(within(section.getByRole("listitem", { name: "manao: claude" })).queryByText("last known")).toBeNull();
    expect(section.getByText(/^Last known/).textContent).toBe("Last known, read 20 min ago");
  });

  it("names the Agenda's Stale Sources in the banner", async () => {
    fakeHub({ now: NOW, agenda: { staleSources: [calendarStale] } });
    render(<App />);
    await settle();

    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("google-calendar:primary");
    expect(banner.textContent).toContain("Stale");
  });

  it("keeps the last good Agenda on screen when the hub cannot be reached", async () => {
    const hub = fakeHub({ now: NOW, agenda: { attention: [item("herdr:local", "agent", "manao: claude")] } });
    render(<App />);
    await settle();

    hub.fail(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(screen.getByRole("alert").querySelector("time")?.getAttribute("datetime")).toBe(NOW);
    expect((await needsYou()).getByRole("listitem", { name: "manao: claude" })).toBeTruthy();
  });
});

/** An open Todo as the Agenda's `todos` sends it. */
function openTodo(id: string, title: string, line: number, groupPath: string[] = [], parentId: string | null = null, sourceOk = true) {
  return {
    source: "brain-dump:todos",
    type: "todo",
    id,
    title,
    status: "open",
    attention: false,
    updatedAt: "2026-10-19T07:00:00.000Z",
    data: { note: "Weekly/2026-W43.md", groupPath, line, parentId },
    sourceOk,
    lastOkAt: sourceOk ? NOW : "2026-10-19T06:00:00.000Z",
  };
}

const todosSection = () => screen.findByRole("region", { name: "Todos" });

describe("Dashboard: the Today view's Todos", () => {
  beforeEach(() => {
    clockFarFromHub({ timers: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(resetBrowser);

  it("follows Needs you and nests the open Todos by Todo Group and under their parent, as the Weekly Note reads", async () => {
    fakeHub({
      now: NOW,
      agenda: {
        todos: [
          openTodo("t0", "Plan the week", 3),
          openTodo("h1", "Ship step 5", 6, ["Manaʻo"]),
          openTodo("h1a", "Write the Agenda query", 7, ["Manaʻo"], "h1"),
          openTodo("d1", "Today view", 9, ["Manaʻo", "Dashboard"]),
          openTodo("e1", "Buy stamps", 14, ["Errands"]),
        ],
      },
    });
    render(<App />);
    const section = await todosSection();
    await within(section).findByRole("listitem", { name: "Plan the week" });

    const titles = screen.getAllByRole("region").map((r) => r.querySelector("h2")?.textContent);
    expect(titles.indexOf("Needs you")).toBeLessThan(titles.indexOf("Todos"));
    expect(titles.at(-1)).toBe("Todos");
    expect(outline(section)).toEqual([
      "Plan the week",
      "# Manaʻo",
      "  Ship step 5",
      "    Write the Agenda query",
      "  # Dashboard",
      "    Today view",
      "# Errands",
      "  Buy stamps",
    ]);
    expect(within(section).getByText("5 open")).toBeTruthy();
  });

  it("puts an open subtodo whose parent is ticked directly under its Todo Group", async () => {
    fakeHub({
      now: NOW,
      agenda: {
        todos: [
          openTodo("h2", "Read the spec", 5, ["Manaʻo"], "h1"),
          openTodo("h3", "Merge it", 8, ["Manaʻo"]),
          openTodo("s1", "Find the insurance card", 11, [], "p2"),
        ],
      },
    });
    render(<App />);
    const section = await todosSection();
    await within(section).findByRole("listitem", { name: "Merge it" });

    expect(outline(section)).toEqual(["# Manaʻo", "  Read the spec", "  Merge it", "Find the insurance card"]);
  });

  it("says so when there are no open Todos", async () => {
    fakeHub({ now: NOW });
    render(<App />);

    const section = within(await todosSection());
    expect(section.getByText("No open Todos.")).toBeTruthy();
    expect(section.queryByRole("list")).toBeNull();
  });

  it("marks Stale Todos as last known and still shows them", async () => {
    fakeHub({ now: NOW, agenda: { todos: [openTodo("t0", "Plan the week", 3, [], null, false)] } });
    render(<App />);
    const section = within(await todosSection());

    expect((await section.findByText(/^Last known/)).textContent).toBe("Last known, read 2 h ago");
    expect(section.getByRole("listitem", { name: "Plan the week" })).toBeTruthy();
  });
});

/** An instant `minutes` from the hub's `now`. */
const fromNow = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

interface AppointmentSpec {
  start?: string;
  end?: string;
  status?: "upcoming" | "ongoing" | "ended";
  attention?: boolean;
  response?: "accepted" | "tentative" | "needsAction" | null;
  meetingLink?: string | null;
  sourceOk?: boolean;
}

/** An `appointment` Item as the Agenda sends it; timed unless `start` is a date. */
function appointment(title: string, spec: AppointmentSpec = {}) {
  const start = spec.start ?? fromNow(60);
  return {
    ...item("google-calendar:primary", "appointment", title, { sourceOk: spec.sourceOk }),
    id: `primary:${title.replace(/\W+/g, "-")}`,
    status: spec.status ?? "upcoming",
    attention: spec.attention ?? false,
    data: {
      allDay: !start.includes("T"),
      start,
      end: spec.end ?? fromNow(90),
      calendarId: "primary",
      calendarName: "Chris",
      location: null,
      meetingLink: spec.meetingLink ?? null,
      response: spec.response ?? null,
      eventType: "default",
      htmlLink: `https://calendar.google.com/event?eid=${encodeURIComponent(title)}`,
    },
  };
}

const appointments = async () => within(await screen.findByRole("region", { name: "Appointments" }));

describe("Dashboard: Today's Appointments", () => {
  beforeEach(() => {
    clockFarFromHub({ timers: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(resetBrowser);

  it("sits between Needs you and Todos and lists the Agenda's Appointments in the hub's order", async () => {
    fakeHub({
      now: NOW,
      agenda: {
        appointments: [
          appointment("Founders' Day", { start: "2026-10-19", end: "2026-10-20", status: "ongoing" }),
          appointment("Standup", { start: fromNow(-60), end: fromNow(-45), status: "ended" }),
          appointment("Retro", { start: fromNow(240), end: fromNow(300) }),
        ],
      },
    });
    render(<App />);
    const section = await appointments();
    await section.findByRole("listitem", { name: "Standup" });

    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(["Needs you", "Appointments", "Todos"]);
    expect(section.getAllByRole("listitem").map((row) => row.querySelector("h4")?.textContent)).toEqual([
      "Founders' Day",
      "Standup",
      "Retro",
    ]);
    expect(section.getByText("3 today")).toBeTruthy();
  });

  it("marks ongoing, Attention and ended Appointments as the Appointments widget does", async () => {
    fakeHub({
      now: NOW,
      agenda: {
        appointments: [
          appointment("Pairing", { start: fromNow(-30), end: fromNow(30), status: "ongoing", attention: true }),
          appointment("Interview", { start: fromNow(12), end: fromNow(60), attention: true }),
          appointment("Standup", { start: fromNow(-60), end: fromNow(-45), status: "ended" }),
        ],
      },
    });
    render(<App />);
    const section = await appointments();

    expect(within(await section.findByRole("listitem", { name: "Pairing" })).getByText("Now")).toBeTruthy();
    expect(within(section.getByRole("listitem", { name: "Interview" })).getByText("In 12 min")).toBeTruthy();
    const ended = section.getByRole("listitem", { name: "Standup" });
    expect(within(ended).getByText("Ended")).toBeTruthy();
    expect(ended.dataset.status).toBe("ended");
    expect(section.getByText("2 need you")).toBeTruthy();
  });

  it("labels invitations and offers no Join on one Chris has not answered", async () => {
    const link = "https://meet.example.test/anywhere";
    fakeHub({
      now: NOW,
      agenda: {
        appointments: [
          appointment("Vendor demo", { response: "needsAction", meetingLink: link }),
          appointment("Offsite planning", { response: "tentative", meetingLink: link }),
        ],
      },
    });
    render(<App />);
    const section = await appointments();

    const invite = within(await section.findByRole("listitem", { name: "Vendor demo" }));
    expect(invite.getByText("Not answered")).toBeTruthy();
    expect(invite.queryByRole("link", { name: /^Join/ })).toBeNull();
    const tentative = within(section.getByRole("listitem", { name: "Offsite planning" }));
    expect(tentative.getByText("Tentative")).toBeTruthy();
    expect(tentative.getByRole("link", { name: "Join Offsite planning" })).toBeTruthy();
  });

  it("shows an Appointment with Attention in Needs you and in Appointments", async () => {
    const standup = appointment("Standup", { start: fromNow(10), end: fromNow(25), attention: true });
    fakeHub({ now: NOW, agenda: { attention: [standup], appointments: [standup] } });
    render(<App />);

    expect(await (await needsYou()).findByRole("listitem", { name: "Standup" })).toBeTruthy();
    expect((await appointments()).getByRole("listitem", { name: "Standup" })).toBeTruthy();
  });

  it("says so when nothing is on the calendar today", async () => {
    fakeHub({ now: NOW });
    render(<App />);

    expect((await appointments()).getByText("Nothing on the calendar today.")).toBeTruthy();
  });

  it("keeps a Stale Source's Appointments, marked as last known", async () => {
    fakeHub({
      now: NOW,
      agenda: { appointments: [appointment("Standup", { sourceOk: false })], staleSources: [calendarStale] },
    });
    render(<App />);
    const section = await appointments();

    expect((await section.findByRole("listitem", { name: "Standup" })).dataset.stale).toBe("true");
    expect(section.getByText(/^Last known/).textContent).toBe("Last known, read 20 min ago");
  });
});

describe("Dashboard: the All view and the tabs", () => {
  beforeEach(() => {
    clockFarFromHub({ timers: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  afterEach(resetBrowser);

  it("opens at #all with its six widgets, reading only Items, Sources and Measurements", async () => {
    showAll();
    const hub = fakeHub({ now: NOW });
    render(<App />);
    await settle();

    expect(tab("All").getAttribute("aria-current")).toBe("page");
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
    expect(regions).toEqual(["agents-title", "appointments-title", "todos-title", "health-title", "papers-title", "sources-title"]);
    expect([...hub.requests()].sort()).toEqual(["/api/items", "/api/measurements", "/api/sources"]);
  });

  it("reads the new view's data at once on switching, and polls only what it shows", async () => {
    const hub = fakeHub({ now: NOW });
    render(<App />);
    await settle();

    await switchTo("All");
    expect(window.location.hash).toBe("#all");
    expect(await screen.findByRole("region", { name: "Agents" })).toBeTruthy();
    expect(hub.ticks("/api/sources")).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.ticks("/api/sources")).toBe(2);
    expect(hub.ticks("/api/measurements")).toBe(2);
    expect(hub.ticks("/api/agenda")).toBe(1);

    await switchTo("Today");
    expect(window.location.hash).toBe("#today");
    await vi.waitFor(() => expect(hub.ticks("/api/agenda")).toBe(2));
    expect(await needsYou()).toBeTruthy();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.ticks("/api/sources")).toBe(2);
    expect(hub.ticks("/api/measurements")).toBe(2);
    expect(hub.ticks("/api/agenda")).toBe(3);
  });

  it("opens at #today on the Today view, as a bookmark of its tab would", async () => {
    window.location.hash = "#today";
    const hub = fakeHub({ now: NOW });
    render(<App />);
    await settle();

    expect(tab("Today").getAttribute("aria-current")).toBe("page");
    expect(hub.requests()).toEqual(["/api/agenda"]);
  });

  it("never shows the old view's failure on the new one", async () => {
    const hub = fakeHub({ now: NOW });
    render(<App />);
    await settle();
    hub.hold();
    hub.fail(0);
    await vi.advanceTimersByTimeAsync(10_000);
    hub.release();
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    hub.hold();
    await switchTo("All");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Reading the hub…")).toBeTruthy();
    hub.answer({ now: NOW });
    hub.release();
    expect(await screen.findByRole("region", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
