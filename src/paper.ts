/**
 * The Paper as every Source and reader shares it: its item type, Status and
 * what its `data` carries. No Source owns it.
 */

export const PAPER_ITEM_TYPE = "paper";

/** A Pick not (yet) kept, or one the user ticked Keep on. */
export type PaperStatus = "picked" | "kept";

/** A `paper` Item's `data`: the Pick as its Briefing shows it. */
export interface PaperData {
  title: string;
  url: string;
  /** The day it was picked (`YYYY-MM-DD`), the day of its Daily Briefing. */
  date: string;
  /** The Interests it was picked for; empty for a Wildcard outside them. */
  interests: string[];
  wildcard: boolean;
  /** One line on why it was picked. */
  why: string;
  /** Its Daily Briefing, relative to the vault. */
  briefing: string;
  /** When it was kept, or null while it is only picked. */
  keptAt: string | null;
}
