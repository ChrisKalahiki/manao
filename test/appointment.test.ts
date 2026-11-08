import { describe, expect, it, vi } from "vitest";
import { type AppointmentTime, appointmentAttention, appointmentStatus, compareAppointments } from "../src/appointment.js";

const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const timed = (start: Date, end: Date): AppointmentTime => ({
  allDay: false,
  start: start.toISOString(),
  end: end.toISOString(),
});
const allDay = (start: string, end: string): AppointmentTime => ({ allDay: true, start, end });

describe("Appointment Status", () => {
  it.each([
    ["timed, before it starts", timed(local(21, 10), local(21, 11)), local(21, 9, 59), "upcoming"],
    ["timed, at its start", timed(local(21, 10), local(21, 11)), local(21, 10), "ongoing"],
    ["timed, during it", timed(local(21, 10), local(21, 11)), local(21, 10, 30), "ongoing"],
    ["timed, at its end", timed(local(21, 10), local(21, 11)), local(21, 11), "ended"],
    ["timed, after it", timed(local(21, 10), local(21, 11)), local(21, 18), "ended"],
    ["crossing midnight, before midnight", timed(local(21, 23), local(22, 1)), local(21, 23, 30), "ongoing"],
    ["crossing midnight, after midnight", timed(local(21, 23), local(22, 1)), local(22, 0, 30), "ongoing"],
    ["crossing midnight, after its end", timed(local(21, 23), local(22, 1)), local(22, 1), "ended"],
    ["all-day, the day before", allDay("2026-10-21", "2026-10-22"), local(20, 23, 59), "upcoming"],
    ["all-day, first minute of its day", allDay("2026-10-21", "2026-10-22"), local(21, 0), "ongoing"],
    ["all-day, last minute of its day", allDay("2026-10-21", "2026-10-22"), local(21, 23, 59), "ongoing"],
    ["all-day, the day after", allDay("2026-10-21", "2026-10-22"), local(22, 0), "ended"],
    ["multi-day, before it", allDay("2026-10-21", "2026-10-26"), local(20, 12), "upcoming"],
    ["multi-day, its first day", allDay("2026-10-21", "2026-10-26"), local(21, 12), "ongoing"],
    ["multi-day, a middle day", allDay("2026-10-21", "2026-10-26"), local(23, 12), "ongoing"],
    ["multi-day, its last day", allDay("2026-10-21", "2026-10-26"), local(25, 23, 59), "ongoing"],
    ["multi-day, the day after its last", allDay("2026-10-21", "2026-10-26"), local(26, 0), "ended"],
  ])("%s", (_case, time, now, expected) => {
    expect(appointmentStatus(time, now)).toBe(expected);
  });

  it("reads all-day dates in the hub's zone, not UTC", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    try {
      const lateEveningInLosAngeles = new Date("2026-10-22T06:30:00.000Z");

      expect(appointmentStatus(allDay("2026-10-21", "2026-10-22"), lateEveningInLosAngeles)).toBe("ongoing");
      expect(appointmentStatus(allDay("2026-10-22", "2026-10-23"), lateEveningInLosAngeles)).toBe("upcoming");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("Appointment Attention", () => {
  const meeting = timed(local(21, 10), local(21, 11));
  it.each([
    ["timed, 16 minutes before it starts", meeting, "default", local(21, 9, 44), false],
    ["timed, 15 minutes before it starts", meeting, "default", local(21, 9, 45), true],
    ["timed, at its start", meeting, "default", local(21, 10), true],
    ["timed, during it", meeting, "default", local(21, 10, 30), true],
    ["timed, at its end", meeting, "default", local(21, 11), false],
    ["timed, after it", meeting, "default", local(21, 18), false],
    ["timed from Gmail, during it", meeting, "fromGmail", local(21, 10, 30), true],
    ["out of office, during it", meeting, "outOfOffice", local(21, 10, 30), false],
    ["out of office, 15 minutes before it", meeting, "outOfOffice", local(21, 9, 45), false],
    ["focus time, during it", meeting, "focusTime", local(21, 10, 30), false],
    ["focus time, 15 minutes before it", meeting, "focusTime", local(21, 9, 45), false],
    ["all-day, 15 minutes before its day", allDay("2026-10-21", "2026-10-22"), "default", local(20, 23, 45), false],
    ["all-day, during its day", allDay("2026-10-21", "2026-10-22"), "default", local(21, 12), false],
    ["multi-day, a middle day", allDay("2026-10-21", "2026-10-26"), "default", local(23, 12), false],
  ])("%s", (_case, time, eventType, now, expected) => {
    expect(appointmentAttention({ ...time, eventType }, now)).toBe(expected);
  });
});

describe("Appointment order within a day", () => {
  it("lists all-day entries first, then by start, then by title", () => {
    const listed = [
      { title: "Standup", data: timed(local(21, 10), local(21, 10, 15)) },
      { title: "Lunch", data: timed(local(21, 9), local(21, 10)) },
      { title: "Breakfast", data: timed(local(21, 9), local(21, 9, 30)) },
      { title: "Trip", data: allDay("2026-10-20", "2026-10-23") },
      { title: "Holiday", data: allDay("2026-10-21", "2026-10-22") },
      { title: "Crossed midnight", data: timed(local(20, 23), local(21, 1)) },
    ];
    expect(listed.sort(compareAppointments).map(({ title }) => title)).toEqual([
      "Trip",
      "Holiday",
      "Crossed midnight",
      "Breakfast",
      "Lunch",
      "Standup",
    ]);
  });
});
