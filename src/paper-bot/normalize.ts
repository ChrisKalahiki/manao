import type { HubItem } from "../core/types.js";
import { PAPER_ITEM_TYPE, type PaperData, type PaperStatus } from "../paper.js";
import type { PicksOutput } from "./contract.js";

export const PAPER_BOT_SOURCE_ID = "paper-bot:picks";

/**
 * This week's Picks as `paper` Items, in paper-bot's order. A Pick is `kept`
 * only once its Keep is in `recordedKeeps` (Item ids), so the stored Items
 * never claim a Keep whose Event is not recorded.
 */
export function normalizePicks(output: PicksOutput, at: string, recordedKeeps: ReadonlySet<string>): HubItem<PaperData>[] {
  return output.picks.map((pick) => ({
    source: PAPER_BOT_SOURCE_ID,
    type: PAPER_ITEM_TYPE,
    id: paperItemId(pick.id),
    title: pick.title,
    status: pickStatus(recordedKeeps.has(paperItemId(pick.id))),
    attention: false,
    updatedAt: at,
    data: {
      title: pick.title,
      url: pick.url,
      date: pick.date,
      interests: pick.interests,
      wildcard: pick.wildcard,
      why: pick.why,
      briefing: pick.briefing,
      keptAt: pick.keptAt,
    },
  }));
}

/** A Pick's Item id: its Paper id under paper-bot's prefix. */
export function paperItemId(paperId: string): string {
  return `paper-bot:${paperId}`;
}

export function pickStatus(kept: boolean): PaperStatus {
  return kept ? "kept" : "picked";
}
