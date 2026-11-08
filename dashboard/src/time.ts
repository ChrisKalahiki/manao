const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The calendar date (`YYYY-MM-DD`) of an ISO time in the page's zone. The hub reads all-day dates in
 * its own zone; the dashboard assumes the device showing it is in the same one.
 */
export function localDate(at: string): string {
  return dateText(new Date(at));
}

/** The date `days` after a `YYYY-MM-DD` date; calendar arithmetic, so DST days stay whole. */
export function addDays(date: string, days: number): string {
  const day = dateAt(date);
  return dateText(new Date(day.getFullYear(), day.getMonth(), day.getDate() + days));
}

/** Local midnight at the start of a `YYYY-MM-DD` date. */
export function dateAt(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function dateText(date: Date): string {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
}

/** How long before the hub's `now` an ISO time was, e.g. "3 min ago". A time ahead of `now` reads "just now". */
export function ago(then: string, now: string): string {
  const ms = Date.parse(now) - Date.parse(then);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}
