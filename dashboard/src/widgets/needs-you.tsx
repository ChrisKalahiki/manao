import type { StoredItem } from "../hub.js";
import { Ago } from "./when.js";
import { LastKnown, Widget } from "./widget.js";

export interface NeedsYouWidgetProps {
  /** The Agenda's `attention`: every Item with Attention, in the hub's order. */
  items: StoredItem[];
  /** The hub's clock. */
  now: string;
}

/** Each Item type's name in words; an unfamiliar type shows as the hub names it. */
const KINDS: Record<string, string> = { agent: "Agent", appointment: "Appointment", todo: "Todo" };

/** Every Item that needs the user now, from any Source, as the hub listed them. */
export function NeedsYouWidget({ items, now }: NeedsYouWidgetProps) {
  return (
    <Widget name="needs-you" title="Needs you" count={items.length} empty={items.length === 0 ? "Nothing needs you." : null}>
      <LastKnown items={items} now={now} />
      <ul class="rows">
        {items.map((item, index) => (
          <NeedsYouRow key={`${item.source}/${item.type}/${item.id}`} id={`needs-you-${index}`} item={item} now={now} />
        ))}
      </ul>
    </Widget>
  );
}

/** `id` labels the row; it is the row's place, since an Item's own id may hold any character, spaces included. */
function NeedsYouRow({ id, item, now }: { id: string; item: StoredItem; now: string }) {
  const stale = !item.sourceOk;
  return (
    <li class="row needs-you" data-stale={stale} aria-labelledby={id}>
      <div class="row-line">
        <h3 id={id} class="needs-you-title">
          {item.title}
        </h3>
        <span class="state">{KINDS[item.type] ?? item.type}</span>
      </div>
      <p class="meta needs-you-meta">
        <span class="needs-you-source">{item.source}</span>
        <Ago at={item.updatedAt} now={now} />
        {stale && <span class="needs-you-stale">last known</span>}
      </p>
    </li>
  );
}
