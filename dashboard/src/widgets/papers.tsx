import { fields, type StoredItem } from "../hub.js";
import { addDays, dateAt, localDate } from "../time.js";
import { LastKnown, Widget } from "./widget.js";

export interface PapersWidgetProps {
  /** The `paper` Items: this week's Picks, in paper-bot's order. */
  papers: StoredItem[];
  /** The hub's clock: Today is read from it. */
  now: string;
}

/** The fields of a `paper` Item's `data` the widget shows, as the paper-bot Adapter sends them. */
interface PaperData {
  /** The day it was picked, the day of its Daily Briefing. */
  date: string;
  /** Its paper, only when the link is https. */
  url: string | null;
  /** The Interests it was picked for; empty for a Wildcard outside them. */
  interests: string[];
  wildcard: boolean;
  why: string | null;
  /** Its Daily Briefing, relative to the vault. */
  briefing: string | null;
}

interface Pick {
  item: StoredItem;
  data: PaperData;
}

interface Day {
  date: string;
  picks: Pick[];
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const SHORT_DATE = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

/** This week's Picks from paper-bot's Daily Briefings: one list per day, newest day first. */
export function PapersWidget({ papers, now }: PapersWidgetProps) {
  const today = localDate(now);
  return (
    <Widget
      name="papers"
      title="Papers"
      count={`${papers.length} this week`}
      empty={papers.length === 0 ? "No Picks this week." : null}
    >
      <LastKnown items={papers} now={now} />
      <ul class="paper-days">
        {byDay(papers.map((item) => ({ item, data: paperData(item.data, today) }))).map((day) => (
          <DayList key={day.date} day={day} today={today} />
        ))}
      </ul>
    </Widget>
  );
}

/**
 * Narrows the wire's `data`: a link that is not https is left out rather than made clickable,
 * and a Pick whose date is not a `YYYY-MM-DD` date is listed under Today rather than hidden.
 */
function paperData(data: unknown, today: string): PaperData {
  const record = fields(data);
  const text = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  const date = text("date");
  const url = text("url");
  const interests = Array.isArray(record.interests) ? record.interests : [];
  return {
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today,
    url: url?.startsWith("https://") ? url : null,
    interests: interests.filter((interest): interest is string => typeof interest === "string" && interest !== ""),
    wildcard: record.wildcard === true,
    why: text("why"),
    briefing: text("briefing"),
  };
}

function byDay(picks: Pick[]): Day[] {
  const days = new Map<string, Pick[]>();
  for (const pick of picks) days.set(pick.data.date, [...(days.get(pick.data.date) ?? []), pick]);
  return [...days.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([date, list]) => ({ date, picks: list }));
}

function dayName(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, -1)) return "Yesterday";
  return WEEKDAY.format(dateAt(date));
}

/**
 * Opens a vault-relative note in Obsidian. manao knows no vault name, so the URI names none and
 * Obsidian opens the note in its current vault. Vault-relative file URIs work across devices
 * whose absolute paths differ.
 */
function obsidianLink(note: string): string {
  return `obsidian://open?file=${encodeURIComponent(note)}`;
}

function DayList({ day, today }: { day: Day; today: string }) {
  const id = `paper-day-${day.date}`;
  const name = dayName(day.date, today);
  const briefing = day.picks.find((pick) => pick.data.briefing !== null)?.data.briefing;
  return (
    <li class="paper-day" aria-labelledby={id}>
      <div class="paper-day-head">
        <h3 id={id} class="paper-day-name">
          {name}
        </h3>
        <time class="paper-day-date" dateTime={day.date}>
          {SHORT_DATE.format(dateAt(day.date))}
        </time>
        {briefing && (
          <a class="paper-briefing" href={obsidianLink(briefing)} aria-label={`Open ${name}’s Briefing in Obsidian`}>
            Briefing
          </a>
        )}
      </div>
      <ul class="rows">
        {day.picks.map((pick) => (
          <PickRow key={pick.item.id} pick={pick} />
        ))}
      </ul>
    </li>
  );
}

function PickRow({ pick: { item, data } }: { pick: Pick }) {
  const id = `paper-${item.id}`;
  const kept = item.status === "kept";
  return (
    <li
      class="row paper"
      data-status={item.status}
      data-wildcard={data.wildcard}
      data-stale={!item.sourceOk}
      aria-labelledby={id}
    >
      {(data.wildcard || data.interests.length > 0 || kept) && (
        <div class="row-line">
          <div class="paper-tags">
            {data.wildcard && <span class="paper-wildcard">Wildcard</span>}
            {data.interests.length > 0 && (
              <ul class="paper-interests" aria-label="Interests">
                {data.interests.map((interest) => (
                  <li key={interest} class="paper-interest">
                    {interest}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {kept && <span class="state paper-kept">Kept</span>}
        </div>
      )}
      <h4 id={id} class="paper-title">
        {data.url ? (
          <a href={data.url} target="_blank" rel="noopener noreferrer">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h4>
      {data.why && <p class="paper-why">{data.why}</p>}
    </li>
  );
}
