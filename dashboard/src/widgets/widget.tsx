import type { ComponentChildren } from "preact";
import type { StoredItem } from "../hub.js";
import { Ago } from "./when.js";

export interface WidgetProps {
  /** Prefixes the heading's id, which labels the section. */
  name: string;
  title: string;
  /** The header's count, shown only when there are rows. */
  count: ComponentChildren;
  /** What to say in place of the rows; null when there are rows. */
  empty: string | null;
  children: ComponentChildren;
}

/** The frame every widget shares: a labelled section, its heading and count, then its rows or why there are none. */
export function Widget({ name, title, count, empty, children }: WidgetProps) {
  const titleId = `${name}-title`;
  return (
    <section class="widget" aria-labelledby={titleId}>
      <header class="widget-head">
        <h2 id={titleId}>{title}</h2>
        {empty === null && <p class="widget-count">{count}</p>}
      </header>
      {empty === null ? children : <p class="empty">{empty}</p>}
    </section>
  );
}

/**
 * Stale Items and Measurements stay on screen; this says they are what the hub last read, and
 * since when. Renders nothing while every one's Source is Healthy.
 */
export function LastKnown({ items, now }: { items: Pick<StoredItem, "sourceOk" | "lastOkAt">[]; now: string }) {
  const stale = items.filter((item) => !item.sourceOk);
  if (stale.length === 0) return null;
  const since = earliest(stale.map((item) => item.lastOkAt));
  return (
    <p class="last-known">
      Last known
      {since && (
        <>
          , read <Ago at={since} now={now} />
        </>
      )}
    </p>
  );
}

function earliest(times: (string | null)[]): string | null {
  const known = times.filter((t): t is string => t !== null).sort((a, b) => Date.parse(a) - Date.parse(b));
  return known[0] ?? null;
}
