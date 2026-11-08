import type { Database } from "better-sqlite3";

/** What every part of the store (Items, Events, Health, upkeep) is built from. */
export interface StoreContext {
  db: Database;
  now: () => Date;
}

/** What upkeep needs from a part that keeps rows per Source. Not on the Store itself. */
export interface SourceRows {
  /** Every Source with rows in this part. */
  sources(): string[];
  /** Removes every row of `source` from this part. */
  remove(source: string): void;
}
