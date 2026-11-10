import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubItem } from "../src/core/types.js";
import { digestFromStore } from "../src/digest/digest.js";
import { addDays } from "../src/local-time.js";
import type { Measurement } from "../src/measurement.js";
import { openStore, type Store } from "../src/store/store.js";

/** Local times on Tuesday 10 November 2026, so every assertion holds in any system zone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
const NOW = at(10, 6);
const TODAY = "2026-11-10";
const HOUR = 3_600_000;

function appointment(id: string, title: string, data: object): HubItem {
  return { source: "google-calendar:primary", type: "appointment", id, title, status: "upcoming", attention: false, updatedAt: NOW.toISOString(), data };
}

function todo(id: string, title: string, line: number, groupPath: string[], parentId: string | null = null): HubItem {
  return {
    source: "brain-dump:todos",
    type: "todo",
    id,
    title,
    status: "open",
    attention: false,
    updatedAt: NOW.toISOString(),
    data: { note: "Weekly.md", groupPath, line, parentId },
  };
}

function agent(id: string, status: string, attention = false): HubItem {
  return { source: "herdr:local", type: "agent", id, title: `Manaʻo / ${id}`, status, attention, updatedAt: NOW.toISOString(), data: {} };
}

/** `values[0]` is Today's, `values[1]` yesterday's, and so on; `undefined` is a day with no data. */
function series(metric: Measurement["metric"], values: Array<number | undefined>): Measurement[] {
  return values.flatMap((value, back) => (value === undefined ? [] : [{ metric, date: addDays(TODAY, -back), value }]));
}

describe("the daily digest", () => {
  let dir: string;
  let dbPath: string;
  let hub: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-digest-"));
    dbPath = path.join(dir, "hub.db");
    hub = openStore(dbPath, { now: () => NOW });
  });
  afterEach(() => {
    hub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const healthy = (source: string, staleAfterMs = HOUR) => hub.reportHealth(source, { ok: true, at: NOW.toISOString(), staleAfterMs });
  const digest = () => digestFromStore(dbPath, NOW);
  const section = (title: string) => {
    const text = digest();
    const start = text.indexOf(`## ${title}\n`);
    if (start === -1) return undefined;
    const end = text.indexOf("\n## ", start + 1);
    return text.slice(start, end === -1 ? undefined : end + 1).trimEnd();
  };

  it("opens with the date and when it was generated, in the system zone", () => {
    const offset = -NOW.getTimezoneOffset();
    const sign = offset < 0 ? "−" : "+";
    const zone = `UTC${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;

    expect(digest().split("\n").slice(0, 3)).toEqual([
      "# Manaʻo daily: Tuesday 10 November 2026",
      "",
      `Generated at 06:00 (${zone}) on 2026-11-10.`,
    ]);
  });

  it("says plainly when there is nothing on the calendar and no open Todos", () => {
    expect(section("Agenda")).toBe("## Agenda\n\nNothing on the calendar today.");
    expect(section("Todos")).toBe("## Todos\n\nNo open Todos.");
  });

  it("lists Today's Appointments all-day first, then by start, with times and unanswered ones marked", () => {
    hub.replaceItems("google-calendar:primary", "appointment", [
      appointment("b", "Lab meeting", { allDay: false, start: at(10, 14).toISOString(), end: at(10, 15, 30).toISOString(), response: "needsAction" }),
      appointment("a", "Advising", { allDay: false, start: at(10, 9).toISOString(), end: at(10, 10).toISOString(), response: "tentative" }),
      appointment("c", "Conference", { allDay: true, start: "2026-11-09", end: "2026-11-12", response: null }),
      appointment("d", "Flight\nhome", { allDay: false, start: at(10, 22).toISOString(), end: at(11, 2).toISOString(), response: "accepted" }),
      appointment("e", "Tomorrow's", { allDay: false, start: at(11, 9).toISOString(), end: at(11, 10).toISOString(), response: null }),
    ]);

    expect(section("Agenda")).toBe(
      [
        "## Agenda",
        "",
        "- All day Conference",
        "- 09:00–10:00 Advising (tentative)",
        "- 14:00–15:30 Lab meeting (not answered)",
        "- from 22:00 Flight home",
      ].join("\n"),
    );
  });

  it("outlines open Todos by Todo Group, subtodos under an open parent, and leaves ticked ones out", () => {
    hub.replaceItems("brain-dump:todos", "todo", [
      todo("t1", "Work on the manuscript", 29, ["SaTC"]),
      todo("t2", "Expand the tool section", 30, ["SaTC"], "t1"),
      todo("t3", "Check the shard runs", 33, ["MCP Project", "Programming"]),
      { ...todo("t4", "Already done", 34, ["MCP Project", "Programming"]), status: "done" },
      todo("t5", "Orphan under a ticked parent", 35, ["MCP Project", "Programming"], "t4"),
    ]);

    expect(section("Todos")).toBe(
      [
        "## Todos",
        "",
        "**SaTC**",
        "- Work on the manuscript",
        "  - Expand the tool section",
        "**MCP Project / Programming**",
        "- Check the shard runs",
        "- Orphan under a ticked parent",
      ].join("\n"),
    );
  });

  it("shows last night's sleep and each Metric's latest whole day against the 7 days before it", () => {
    hub.writeMeasurements("google-health:primary", [
      ...series("sleep", [432, 400, 420, 380, 410, 400, 390, 410]),
      ...series("steps", [312, 9000, 7000, 7000, 7000, 7000, 7000, 7000, 7000]),
      ...series("resting-heart-rate", [58, 60, 60, 60, 60, 60, 60, 60]),
      ...series("active-zone-minutes", [5, 30, 30, 30]),
    ]);

    expect(section("Health")).toBe(
      [
        "## Health",
        "",
        "- Sleep last night: 7h 12m (+31m vs 7-day avg 6h 41m)",
        "- Steps yesterday: 9,000 (+2,000 vs 7-day avg 7,000)",
        "- Resting heart rate today: 58 bpm (−2 bpm vs 7-day avg 60 bpm)",
        "- Active zone minutes yesterday: 30 min",
      ].join("\n"),
    );
  });

  it("says when no sleep was recorded last night, and shows the latest night instead", () => {
    hub.writeMeasurements("google-health:primary", series("sleep", [undefined, undefined, 400, 400]));

    expect(section("Health")).toBe("## Health\n\n- Sleep last night: none recorded; Sun 8 Nov 6h 40m");
  });

  it("calls a reading equal to the average level with it", () => {
    hub.writeMeasurements("google-health:primary", series("resting-heart-rate", [60, 60, 60, 60, 60]));

    expect(section("Health")).toBe("## Health\n\n- Resting heart rate today: 60 bpm (level with 7-day avg 60 bpm)");
  });

  it("leaves Health out when there are no Measurements", () => {
    expect(section("Health")).toBeUndefined();
  });

  it("puts what needs the user first, and a line each for agents and Picks when their Sources are enabled", () => {
    healthy("herdr:local");
    healthy("paper-bot:picks");
    hub.replaceItems("herdr:local", "agent", [agent("t1", "needs_attention", true), agent("t2", "running"), agent("t3", "running")]);
    hub.replaceItems("paper-bot:picks", "paper", [
      { source: "paper-bot:picks", type: "paper", id: "p1", title: "A", status: "kept", attention: false, updatedAt: NOW.toISOString(), data: { date: TODAY } },
      { source: "paper-bot:picks", type: "paper", id: "p2", title: "B", status: "picked", attention: false, updatedAt: NOW.toISOString(), data: { date: "2026-11-09" } },
    ]);

    const text = digest();

    expect(section("Needs you")).toBe("## Needs you\n\n- Manaʻo / t1 (agent, needs attention)");
    expect(text.indexOf("## Needs you")).toBeLessThan(text.indexOf("## Agenda"));
    expect(section("Also")).toBe("## Also\n\n- Agents: 1 need you, 2 running\n- Papers: 2 Picks this week, 1 today, 1 kept");
  });

  it("leaves out Sources that are not enabled", () => {
    healthy("brain-dump:todos");

    expect(section("Also")).toBeUndefined();
    expect(section("Needs you")).toBeUndefined();
  });

  it("names Stale Sources and when they last read well, so last known data never passes as current", () => {
    healthy("brain-dump:todos");
    hub.reportHealth("google-health:primary", { ok: false, at: NOW.toISOString(), error: "not connected", staleAfterMs: HOUR });

    expect(digest()).toContain("\n\n**Stale:** google-health:primary (last ok never). What they show below is last known.\n");
  });

  it("stays under 60 lines on a full day, counting what it leaves out", () => {
    healthy("herdr:local");
    healthy("paper-bot:picks");
    hub.reportHealth("brain-dump:todos", { ok: false, at: NOW.toISOString(), staleAfterMs: HOUR });
    hub.replaceItems("herdr:local", "agent", Array.from({ length: 9 }, (_, i) => agent(`t${i}`, "needs_attention", true)));
    hub.replaceItems(
      "google-calendar:primary",
      "appointment",
      Array.from({ length: 12 }, (_, i) =>
        appointment(`a${i}`, `Meeting ${i}`, { allDay: false, start: at(10, 8 + i).toISOString(), end: at(10, 8 + i, 30).toISOString() }),
      ),
    );
    hub.replaceItems("brain-dump:todos", "todo", Array.from({ length: 40 }, (_, i) => todo(`t${i}`, `Todo ${i}`, i, [`Group ${i % 8}`])));
    hub.writeMeasurements("google-health:primary", [
      ...series("sleep", [400, 400, 400, 400, 400, 400, 400, 400]),
      ...series("steps", [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ...series("resting-heart-rate", [60, 60, 60, 60, 60]),
      ...series("active-zone-minutes", [1, 2, 3, 4, 5, 6]),
    ]);

    const text = digest();

    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(60);
    expect(text).toContain("- …and 4 more\n");
    expect(text).toContain("- …and 32 more\n");
  });

  it("names the path when there is no store", () => {
    expect(() => digestFromStore(path.join(dir, "missing.db"), NOW)).toThrow(`no store at ${path.join(dir, "missing.db")}`);
  });
});
