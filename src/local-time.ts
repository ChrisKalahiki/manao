/** The hub's Today is the system time zone's, until a `timeZone` option exists. */
export function localDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/** The calendar date `days` after `date` (`YYYY-MM-DD`); counted in UTC, where every day is whole. */
export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** How many days `to` is after `from`, both `YYYY-MM-DD`; negative when it is before. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Local midnight `days` after the day of `date`; calendar arithmetic, so DST days stay whole. */
export function startOfLocalDay(date: Date, days = 0): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
