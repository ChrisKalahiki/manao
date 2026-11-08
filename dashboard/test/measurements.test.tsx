import { render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";

const SOURCE = "google-health:primary";

/** Wednesday 21 October 2026, 10:00 in the zone the tests run in. */
const NOW = new Date(2026, 9, 21, 10).toISOString();

const UNITS: Record<string, string> = {
  steps: "count",
  sleep: "minutes",
  "resting-heart-rate": "bpm",
  "active-zone-minutes": "minutes",
};

/** A Measurement on a day of October 2026, as `/api/measurements` sends it. */
function measurement(metric: string, day: number, value: number, sourceOk = true) {
  return {
    source: SOURCE,
    metric,
    date: `2026-10-${String(day).padStart(2, "0")}`,
    value,
    unit: UNITS[metric] ?? "kg",
    sourceOk,
    lastOkAt: sourceOk ? NOW : new Date(2026, 9, 21, 7).toISOString(),
  };
}

/** The week of all four Metrics, in the hub's order: by Metric id, then date. */
const WEEK = [
  measurement("active-zone-minutes", 16, 31),
  measurement("active-zone-minutes", 19, 24),
  measurement("resting-heart-rate", 15, 61),
  measurement("resting-heart-rate", 20, 58),
  measurement("sleep", 20, 405),
  measurement("sleep", 21, 432),
  measurement("steps", 15, 10_000),
  measurement("steps", 17, 0),
  measurement("steps", 18, 5_000),
  measurement("steps", 21, 8_412),
];

const health = async () => within(await screen.findByRole("region", { name: "Health" }));

async function row(name: string) {
  return within((await health()).getByRole("listitem", { name }));
}

/** Each day of a Metric's strip, oldest first: what a screen reader hears, and the bar's height if it has one. */
async function strip(name: string) {
  const days = (await row(name)).getByRole("list", { name: `${name}, last 7 days` });
  return within(days)
    .getAllByRole("listitem")
    .map((day) => ({ text: day.textContent, bar: day.querySelector("rect")?.getAttribute("height") ?? null }));
}

describe("Dashboard: Health widget", () => {
  beforeEach(() => {
    clockFarFromHub();
    showAll();
  });
  afterEach(resetBrowser);

  it("shows each Metric's latest value and its day, in a fixed order, days read from the hub's clock", async () => {
    fakeHub({ now: NOW, measurements: WEEK });
    render(<App />);
    await screen.findByRole("listitem", { name: "Steps" });

    const section = await health();
    expect(section.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Steps",
      "Sleep",
      "Resting heart rate",
      "Active zone minutes",
    ]);
    const latest = async (name: string, value: string, day: string) => {
      const r = await row(name);
      expect(r.getByText(value)).toBeTruthy();
      expect(r.getByText(day)).toBeTruthy();
    };
    await latest("Steps", "8,412", "so far today");
    await latest("Sleep", "7h 12m", "last night");
    await latest("Resting heart rate", "58 bpm", "yesterday");
    await latest("Active zone minutes", "24 min", "Monday");
  });

  it("calls a day's sleep, steps and active zone minutes by their day once it is not Today", async () => {
    fakeHub({
      now: NOW,
      measurements: [
        measurement("active-zone-minutes", 21, 12),
        measurement("resting-heart-rate", 21, 57),
        measurement("sleep", 19, 59),
        measurement("steps", 20, 12_345),
      ],
    });
    render(<App />);
    await screen.findByRole("listitem", { name: "Steps" });

    expect((await row("Steps")).getByText("yesterday")).toBeTruthy();
    expect((await row("Sleep")).getByText("59m")).toBeTruthy();
    expect((await row("Sleep")).getByText("Monday")).toBeTruthy();
    expect((await row("Active zone minutes")).getByText("so far today")).toBeTruthy();
    expect((await row("Resting heart rate")).getByText("today")).toBeTruthy();
  });

  it("draws the 7 days ending Today, a missing day an empty slot and a zero a bar, scaled per Metric", async () => {
    fakeHub({ now: NOW, measurements: WEEK });
    render(<App />);
    await screen.findByRole("listitem", { name: "Steps" });

    expect(await strip("Steps")).toEqual([
      { text: expect.stringContaining("Thursday: 10,000"), bar: "100" },
      { text: expect.stringContaining("Friday: no data"), bar: null },
      { text: expect.stringContaining("Saturday: 0"), bar: expect.any(String) },
      { text: expect.stringContaining("Sunday: 5,000"), bar: "50" },
      { text: expect.stringContaining("Monday: no data"), bar: null },
      { text: expect.stringContaining("Tuesday: no data"), bar: null },
      { text: expect.stringContaining("Today: 8,412"), bar: "84.12" },
    ]);
    const heartRate = await strip("Resting heart rate");
    expect(heartRate.map((day) => day.bar)).toEqual(["100", null, null, null, null, expect.any(String), null]);
    expect(heartRate[5]?.text).toContain("Tuesday: 58 bpm");
  });

  it("shows a Metric it has no name for by its id and unit", async () => {
    fakeHub({ now: NOW, measurements: [measurement("weight", 21, 72.5)] });
    render(<App />);

    expect((await health()).getByRole("heading", { level: 3 }).textContent).toBe("weight");
    expect((await row("weight")).getByText("72.5 kg")).toBeTruthy();
  });

  it("marks Stale Measurements as last known, and keeps them", async () => {
    fakeHub({ now: NOW, measurements: [measurement("steps", 21, 8_412, false)] });
    render(<App />);

    expect((await row("Steps")).getByText("8,412")).toBeTruthy();
    expect((await health()).getByText(/^Last known/).textContent).toBe("Last known, read 3 h ago");
  });

  it("says so when there are no Measurements", async () => {
    fakeHub({ now: NOW });
    render(<App />);

    expect((await health()).getByText("No Measurements in the last 7 days.")).toBeTruthy();
  });
});
