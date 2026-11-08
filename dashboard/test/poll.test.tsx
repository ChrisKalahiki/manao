import { render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";

const NOW = "2026-10-19T08:00:00.000Z";

const herdr = (healthy: boolean) => ({
  source: "herdr:local",
  ok: healthy,
  at: NOW,
  ...(healthy ? {} : { error: "connect ENOENT" }),
  staleAfterMs: 15_000,
  lastOkAt: "2026-10-19T07:59:55.000Z",
  healthy,
});

const brainDump = (healthy: boolean) => ({
  source: "brain-dump:todos",
  ok: healthy,
  at: NOW,
  staleAfterMs: 180_000,
  lastOkAt: "2026-10-19T06:00:00.000Z",
  healthy,
});

const banner = () => screen.queryByRole("status");
const unreachable = () => screen.queryByRole("alert");

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Lets pending fetches and renders settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("Dashboard: polling the hub", () => {
  beforeEach(() => {
    clockFarFromHub({ timers: true });
    showAll();
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  });
  afterEach(resetBrowser);

  it("reads Items and Sources on load, then again every 10s while visible", async () => {
    const hub = fakeHub({ now: NOW, sources: [herdr(true)] });
    render(<App />);
    await settle();

    expect(hub.fetch).toHaveBeenCalledWith("/api/items", expect.anything());
    expect(hub.fetch).toHaveBeenCalledWith("/api/sources", expect.anything());
    expect(hub.ticks("/api/sources")).toBe(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(hub.ticks("/api/sources")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.ticks("/api/sources")).toBe(2);
  });

  it("stops reading while the page is hidden and reads at once when it is shown again", async () => {
    const hub = fakeHub({ now: NOW, sources: [herdr(true)] });
    render(<App />);
    await settle();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.ticks("/api/sources")).toBe(1);

    setVisibility("visible");
    await settle();
    expect(hub.ticks("/api/sources")).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.ticks("/api/sources")).toBe(3);
  });

  it("waits for a slow read to finish before timing the next one", async () => {
    const hub = fakeHub({ now: NOW, sources: [herdr(true)] });
    render(<App />);
    await settle();

    hub.hold();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hub.ticks("/api/sources")).toBe(2);

    await vi.advanceTimersByTimeAsync(25_000);
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(hub.ticks("/api/sources")).toBe(2);

    hub.release();
    await settle();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(hub.ticks("/api/sources")).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hub.ticks("/api/sources")).toBe(3);
  });

  it("names each Source that is not Healthy, and clears once all are", async () => {
    const hub = fakeHub({ now: NOW, sources: [brainDump(false), herdr(false)] });
    render(<App />);
    await settle();

    const stale = banner();
    expect(stale?.textContent).toContain("brain-dump:todos");
    expect(stale?.textContent).toContain("herdr:local");
    expect(stale?.textContent).toContain("Stale");

    hub.answer({ now: NOW, sources: [brainDump(true), herdr(false)] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(banner()?.textContent).not.toContain("brain-dump:todos");
    expect(banner()?.textContent).toContain("herdr:local");

    hub.answer({ now: NOW, sources: [brainDump(true), herdr(true)] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(banner()).toBeNull();
  });

  it.each([
    ["answers 500", 500],
    ["cannot be reached at all", 0],
  ])("keeps the last data on screen when the hub %s, saying when it last answered", async (_case, status) => {
    const hub = fakeHub({ now: NOW, sources: [herdr(true)] });
    render(<App />);
    await settle();
    expect(unreachable()).toBeNull();

    hub.fail(status);
    await vi.advanceTimersByTimeAsync(10_000);

    const alert = unreachable();
    expect(alert?.textContent).toContain("Can’t reach the hub");
    expect(alert?.querySelector("time")?.getAttribute("datetime")).toBe(NOW);
    expect(within(screen.getByRole("listitem", { name: "herdr:local" })).getByText("Healthy")).toBeTruthy();

    const later = "2026-10-19T08:00:20.000Z";
    hub.answer({ now: later, sources: [herdr(true)] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(unreachable()).toBeNull();
  });

  it("says the hub has not answered yet when the first read fails", async () => {
    const hub = fakeHub({ now: NOW, sources: [] });
    hub.fail(0);
    render(<App />);
    await settle();

    const alert = unreachable();
    expect(alert?.textContent).toContain("Can’t reach the hub");
    expect(alert?.querySelector("time")).toBeNull();
  });

  it("feeds the Sources widget from every read", async () => {
    const hub = fakeHub({ now: NOW, sources: [herdr(true)] });
    render(<App />);
    await settle();
    expect(within(screen.getByRole("listitem", { name: "herdr:local" })).getByText("Healthy")).toBeTruthy();

    hub.answer({ now: NOW, sources: [herdr(false)] });
    await vi.advanceTimersByTimeAsync(10_000);
    const row = within(screen.getByRole("listitem", { name: "herdr:local" }));
    expect(row.getByText("Stale")).toBeTruthy();
    expect(row.getByText("connect ENOENT")).toBeTruthy();
  });
});
