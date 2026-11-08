/**
 * The Todo as every Source and reader shares it: its item type, what its
 * `data` carries, and its order. No Source owns it.
 */

export const TODO_ITEM_TYPE = "todo";

/** A `todo` Item's `data`: where it sits in the Weekly Note. */
export interface TodoData {
  /** The Weekly Note it was read from, relative to the vault. */
  note: string;
  /** The Todo Groups it sits in, outermost first. */
  groupPath: string[];
  /** Its line in the Weekly Note. */
  line: number;
  /** The Todo it is a subtodo of. */
  parentId: string | null;
}

/** Weekly Note line order; an Item whose `data` has no numeric `line` goes last. */
export function compareTodoLines(a: { data: unknown }, b: { data: unknown }): number {
  const [lineA, lineB] = [todoLine(a.data), todoLine(b.data)];
  return lineA === lineB ? 0 : lineA < lineB ? -1 : 1;
}

function todoLine(data: unknown): number {
  return typeof data === "object" && data !== null && "line" in data && typeof data.line === "number"
    ? data.line
    : Number.POSITIVE_INFINITY;
}
