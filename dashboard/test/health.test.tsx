import { render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";

/** A `/api/sources` body as the hub sends it: Herdr Healthy, Brain-Dump failing since an earlier success. */
const SOURCES = {
  now: "2026-10-19T08:00:00.000Z",
  sources: [
    {
      source: "brain-dump:todos",
      ok: false,
      at: "2026-10-19T07:59:30.000Z",
      error: "brain-dump exited with code 1",
      note: "vault folder not found; retrying",
      staleAfterMs: 180_000,
      lastOkAt: "2026-10-19T06:00:00.000Z",
      healthy: false,
    },
    {
      source: "herdr:local",
      ok: true,
      at: "2026-10-19T07:57:00.000Z",
      staleAfterMs: 180_000,
      lastOkAt: "2026-10-19T07:57:00.000Z",
      healthy: true,
    },
    {
      source: "herdr:work",
      ok: false,
      at: "2026-10-19T07:59:00.000Z",
      error: "connect ENOENT",
      staleAfterMs: 15_000,
      lastOkAt: null,
      healthy: false,
    },
  ],
};

const serve = (sources: { now: string; sources: unknown[] }) => fakeHub(sources).fetch;

const row = (source: string) => screen.findByRole("listitem", { name: source });

describe("Dashboard: Sources widget", () => {
  beforeEach(() => {
    clockFarFromHub();
    showAll();
  });
  afterEach(resetBrowser);

  it("asks the hub for /api/sources", async () => {
    const fetch = serve(SOURCES);
    render(<App />);
    await row("herdr:local");

    expect(fetch).toHaveBeenCalledWith("/api/sources", expect.anything());
  });

  it("marks a Healthy Source Healthy, with its last ok age from the hub's clock", async () => {
    serve(SOURCES);
    render(<App />);

    const herdr = within(await row("herdr:local"));
    expect(herdr.getByText("Healthy")).toBeTruthy();
    expect(herdr.getByText("last ok 3 min ago")).toBeTruthy();
  });

  it("marks a failing Source Stale, with its error, its note and when it was last ok", async () => {
    serve(SOURCES);
    render(<App />);

    const brainDump = within(await row("brain-dump:todos"));
    expect(brainDump.getByText("Stale")).toBeTruthy();
    expect(brainDump.getByText("brain-dump exited with code 1")).toBeTruthy();
    expect(brainDump.getByText("vault folder not found; retrying")).toBeTruthy();
    expect(brainDump.getByText("last ok 2 h ago")).toBeTruthy();
  });

  it("says when a Source has never been ok", async () => {
    serve(SOURCES);
    render(<App />);

    const work = within(await row("herdr:work"));
    expect(work.getByText("Stale")).toBeTruthy();
    expect(work.getByText("never ok")).toBeTruthy();
  });

  it("lists the Sources in the hub's order and counts the Healthy ones", async () => {
    serve(SOURCES);
    render(<App />);
    await row("herdr:local");

    const names = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(names).toEqual(["brain-dump:todos", "herdr:local", "herdr:work"]);
    expect(screen.getByText("1 of 3 Healthy")).toBeTruthy();
  });

  it("says so when no Source has reported yet", async () => {
    serve({ now: SOURCES.now, sources: [] });
    render(<App />);

    expect(await screen.findByText("No Source has reported yet.")).toBeTruthy();
  });
});
