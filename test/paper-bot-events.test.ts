import { describe, expect, it } from "vitest";
import type { HubItem } from "../src/core/types.js";
import type { PicksOutput } from "../src/paper-bot/contract.js";
import { keptEvent, type PaperBotSeen, recordedKeeps, scanEvents, seenFromStored, unrecordedKeeps } from "../src/paper-bot/events.js";
import { picksFixture } from "./paper-bot-helper.js";

const SOURCE = "paper-bot:picks";
const AT = "2026-10-26T12:00:00.000Z";
const DAILY_AT = "2026-10-26T10:00:00.000Z";
const WEEKLY_AT = "2026-10-26T10:05:00.000Z";
const [picked, kept] = picksFixture.picks as [PicksOutput["picks"][number], PicksOutput["picks"][number]];
const PICKED_ID = `paper-bot:${picked.id}`;
const KEPT_ID = `paper-bot:${kept.id}`;

const nothingSeen: PaperBotSeen = { dailyScanAt: null, weeklyScanAt: null, kept: null };
const allSeen: PaperBotSeen = { dailyScanAt: DAILY_AT, weeklyScanAt: WEEKLY_AT, kept: new Set([KEPT_ID]) };
const bothKept = { ...picksFixture, picks: [{ ...picked, kept: true, keptAt: "2026-10-26T11:45:00.000Z" }, kept] };

describe("paper-bot Scan Events", () => {
  it("records each Scan result not seen before with its outcome and reason", () => {
    const { events } = scanEvents(nothingSeen, picksFixture, AT);

    expect(events).toEqual([
      { source: SOURCE, kind: "scan.daily", at: AT, data: { at: DAILY_AT, date: "2026-10-26", outcome: "briefing", reason: null } },
      { source: SOURCE, kind: "scan.weekly", at: AT, data: { at: WEEKLY_AT, week: "2026-W44", outcome: "briefing", reason: null } },
    ]);
  });

  it("records nothing for Scans whose `at` was seen", () => {
    expect(scanEvents(allSeen, picksFixture, AT).events).toEqual([]);
  });

  it("records a Scan again when a new result replaces the seen one", () => {
    const output = {
      ...picksFixture,
      scans: {
        ...picksFixture.scans,
        daily: { ...picksFixture.scans.daily!, at: "2026-10-27T10:00:00.000Z", outcome: "skipped" as const, reason: "nothing cleared the bar" },
      },
    };

    const { events } = scanEvents(allSeen, output, AT);

    expect(events.map((event) => [event.kind, event.data])).toEqual([
      ["scan.daily", { at: "2026-10-27T10:00:00.000Z", date: "2026-10-26", outcome: "skipped", reason: "nothing cleared the bar" }],
    ]);
  });

  it("records nothing for a kind of Scan that has not run yet", () => {
    expect(scanEvents(nothingSeen, { ...picksFixture, scans: { daily: null, weekly: null } }, AT).events).toEqual([]);
  });

  it("returns the Scans' `at` as seen", () => {
    expect(scanEvents(nothingSeen, picksFixture, AT).seen).toEqual({ dailyScanAt: DAILY_AT, weeklyScanAt: WEEKLY_AT, kept: null });
  });

  it("keeps the seen Scan when that kind is missing from a read", () => {
    expect(scanEvents(allSeen, { ...picksFixture, scans: { daily: null, weekly: null } }, AT).seen).toEqual(allSeen);
  });
});

describe("paper-bot Keeps", () => {
  it("counts a kept Pick as recorded only when its Keep was", () => {
    expect(recordedKeeps(allSeen, bothKept)).toEqual(new Set([KEPT_ID]));
  });

  it("counts every kept Pick as recorded while no Picks were known, so a new store does not replay old Keeps", () => {
    expect(recordedKeeps(nothingSeen, picksFixture)).toEqual(new Set([KEPT_ID]));
  });

  it("drops a recorded Keep whose Pick is no longer kept", () => {
    const output = { ...picksFixture, picks: [picked, { ...kept, kept: false, keptAt: null }] };

    expect(recordedKeeps(allSeen, output)).toEqual(new Set());
  });

  it("lists the kept Picks whose Keep is not recorded, a Pick first seen already kept included", () => {
    expect(unrecordedKeeps(new Set(), bothKept).map((pick) => pick.id)).toEqual([picked.id, kept.id]);
  });

  it("leaves out the kept Picks whose Keep is recorded", () => {
    expect(unrecordedKeeps(new Set([KEPT_ID]), bothKept).map((pick) => pick.id)).toEqual([picked.id]);
  });

  it("records a Keep with the Pick's Item id, title, link, day and keptAt", () => {
    expect(keptEvent(bothKept.picks[0]!, AT)).toEqual({
      source: SOURCE,
      kind: "paper.kept",
      at: AT,
      data: { id: PICKED_ID, title: picked.title, url: picked.url, date: picked.date, keptAt: "2026-10-26T11:45:00.000Z" },
    });
  });
});

describe("what paper-bot has seen, from the store", () => {
  const item = (id: string, status: string): HubItem => ({
    source: SOURCE,
    type: "paper",
    id,
    title: id,
    status,
    attention: false,
    updatedAt: AT,
    data: {},
  });
  const event = (kind: string, data: unknown) => ({ source: SOURCE, kind, at: AT, data });

  it("takes the Picks stored as kept and the latest Scan Events' `at`", () => {
    const seen = seenFromStored({
      items: [item("paper-bot:a", "picked"), item("paper-bot:b", "kept")],
      latestMeasurementDate: null,
      latestEvents: [event("scan.daily", { at: DAILY_AT }), event("scan.weekly", { at: WEEKLY_AT }), event("paper.kept", { id: "paper-bot:b" })],
    });

    expect(seen).toEqual({ dailyScanAt: DAILY_AT, weeklyScanAt: WEEKLY_AT, kept: new Set(["paper-bot:b"]) });
  });

  it("counts the newest Keep Event's Pick as kept, though the Picks' write after it was refused", () => {
    const seen = seenFromStored({
      items: [item("paper-bot:a", "picked"), item("paper-bot:b", "picked")],
      latestMeasurementDate: null,
      latestEvents: [event("paper.kept", { id: "paper-bot:a" })],
    });

    expect(seen.kept).toEqual(new Set(["paper-bot:a"]));
  });

  it("knows nothing from an empty store or none at all", () => {
    expect(seenFromStored({ items: [], latestMeasurementDate: null, latestEvents: [] })).toEqual(nothingSeen);
    expect(seenFromStored(undefined)).toEqual(nothingSeen);
  });

  it("ignores a stored Event whose data is not in this version's shape", () => {
    const seen = seenFromStored({
      items: [item("paper-bot:a", "picked")],
      latestMeasurementDate: null,
      latestEvents: [event("scan.daily", { when: DAILY_AT }), event("paper.kept", { paper: "paper-bot:a" })],
    });

    expect(seen).toEqual({ dailyScanAt: null, weeklyScanAt: null, kept: new Set() });
  });
});
