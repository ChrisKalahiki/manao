import { describe, expect, it } from "vitest";
import { weeklyNoteFolder } from "../src/brain-dump/command.js";
import { localDate } from "../src/local-time.js";

describe("Brain-Dump Today", () => {
  it.each([
    [new Date(2026, 0, 2, 0, 5), "2026-01-02"],
    [new Date(2026, 11, 31, 23, 59), "2026-12-31"],
    [new Date(2027, 0, 1, 0, 0), "2027-01-01"],
  ])("formats the local date of %s", (date, expected) => {
    expect(localDate(date)).toBe(expected);
  });
});

describe("Weekly Note folder", () => {
  it.each([
    ["Research/Weekly Meetings/note.md", "/tmp/vault/Research/Weekly Meetings"],
    ["note.md", "/tmp/vault"],
  ])("resolves vault-relative %s", (note, expected) => {
    expect(weeklyNoteFolder("/tmp/vault", note)).toBe(expected);
  });
});
