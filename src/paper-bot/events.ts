import { z } from "zod";
import type { HubEvent, StoredState } from "../core/types.js";
import type { PicksOutput } from "./contract.js";
import { PAPER_BOT_SOURCE_ID, paperItemId, pickStatus } from "./normalize.js";

export const DAILY_SCAN_EVENT_KIND = "scan.daily";
export const WEEKLY_SCAN_EVENT_KIND = "scan.weekly";
export const KEPT_EVENT_KIND = "paper.kept";

type Pick = PicksOutput["picks"][number];

/** What paper-bot's Events were last recorded from. */
export interface PaperBotSeen {
  /** The `at` of the latest Daily Scan recorded, or null before any. */
  dailyScanAt: string | null;
  /** The `at` of the latest Weekly Scan recorded, or null before any. */
  weeklyScanAt: string | null;
  /** The Item ids of the Picks whose Keep is recorded; null while no Picks are known, when a Pick already kept is no news. */
  kept: ReadonlySet<string> | null;
}

/** One Event per Scan result whose `at` differs from the one recorded, and what is seen once they are recorded. */
export function scanEvents(seen: PaperBotSeen, output: PicksOutput, at: string): { events: HubEvent[]; seen: PaperBotSeen } {
  const events: HubEvent[] = [];
  const { daily, weekly } = output.scans;
  if (daily !== null && daily.at !== seen.dailyScanAt) {
    const { at: scanAt, date, outcome, reason } = daily;
    events.push({ source: PAPER_BOT_SOURCE_ID, kind: DAILY_SCAN_EVENT_KIND, at, data: { at: scanAt, date, outcome, reason } });
  }
  if (weekly !== null && weekly.at !== seen.weeklyScanAt) {
    const { at: scanAt, week, outcome, reason } = weekly;
    events.push({ source: PAPER_BOT_SOURCE_ID, kind: WEEKLY_SCAN_EVENT_KIND, at, data: { at: scanAt, week, outcome, reason } });
  }
  return {
    events,
    seen: { ...seen, dailyScanAt: daily?.at ?? seen.dailyScanAt, weeklyScanAt: weekly?.at ?? seen.weeklyScanAt },
  };
}

/**
 * The Keeps recorded for this read's Picks: those kept now whose Keep was
 * recorded before, or every kept one while no Picks were known. A Pick no
 * longer kept drops out, so keeping it again is news.
 */
export function recordedKeeps(seen: PaperBotSeen, output: PicksOutput): Set<string> {
  const kept = output.picks.filter((pick) => pick.kept).map((pick) => paperItemId(pick.id));
  return new Set(seen.kept === null ? kept : kept.filter((id) => seen.kept?.has(id)));
}

/** The kept Picks whose Keep is not recorded yet, in paper-bot's order. */
export function unrecordedKeeps(recorded: ReadonlySet<string>, output: PicksOutput): Pick[] {
  return output.picks.filter((pick) => pick.kept && !recorded.has(paperItemId(pick.id)));
}

export function keptEvent(pick: Pick, at: string): HubEvent {
  const { id, title, url, date, keptAt } = pick;
  return { source: PAPER_BOT_SOURCE_ID, kind: KEPT_EVENT_KIND, at, data: { id: paperItemId(id), title, url, date, keptAt } };
}

const recordedScan = z.object({ at: z.string() });
const recordedKeep = z.object({ id: z.string() });

/**
 * What the store recorded before the start: the Picks stored as kept, the
 * newest Keep Event's Pick (recorded, though the Picks' write after it may
 * have been refused) and the latest Scan Events' `at`.
 */
export function seenFromStored(stored: StoredState | undefined): PaperBotSeen {
  const latest = (kind: string) => stored?.latestEvents.find((event) => event.kind === kind)?.data;
  const scan = (kind: string) => {
    const parsed = recordedScan.safeParse(latest(kind));
    return parsed.success ? parsed.data.at : null;
  };
  const picks = stored?.items ?? [];
  const keep = recordedKeep.safeParse(latest(KEPT_EVENT_KIND));
  const kept = picks.filter((pick) => pick.status === pickStatus(true)).map((pick) => pick.id);
  return {
    dailyScanAt: scan(DAILY_SCAN_EVENT_KIND),
    weeklyScanAt: scan(WEEKLY_SCAN_EVENT_KIND),
    kept: picks.length === 0 ? null : new Set(keep.success ? [...kept, keep.data.id] : kept),
  };
}
