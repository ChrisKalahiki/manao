import type { StoreContext } from "./context.js";
import { eventPruner } from "./events.js";
import { healthSourceRows } from "./health.js";
import { itemSourceRows } from "./items.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The upkeep slice of the Store: what keeps it tidy as config and time move on. */
export interface UpkeepPart {
  /**
   * Removes the Items and Health of every Source not in `keep`. Their Events
   * stay until retention prunes them. Returns the removed Sources, in order.
   */
  removeSourcesExcept(keep: Iterable<string>): string[];
  /** Removes Events observed more than `retentionDays` ago. Returns how many. */
  pruneEvents(retentionDays: number): number;
}

export function upkeepPart(ctx: StoreContext): UpkeepPart {
  const parts = [itemSourceRows(ctx), healthSourceRows(ctx)];
  const pruneBefore = eventPruner(ctx);

  const removeSources = ctx.db.transaction((keep: ReadonlySet<string>) => {
    const stored = new Set(parts.flatMap((part) => part.sources()));
    const removed = [...stored].filter((source) => !keep.has(source)).sort();
    for (const source of removed) {
      for (const part of parts) part.remove(source);
    }
    return removed;
  });

  return {
    removeSourcesExcept: (keep) => removeSources(new Set(keep)),
    pruneEvents: (retentionDays) => pruneBefore(new Date(ctx.now().getTime() - retentionDays * DAY_MS)),
  };
}
