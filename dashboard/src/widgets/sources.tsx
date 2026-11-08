import type { SourceHealth } from "../hub.js";
import { Ago } from "./when.js";
import { Widget } from "./widget.js";

export interface SourcesWidgetProps {
  sources: SourceHealth[];
  /** The hub's clock. */
  now: string;
}

/** Each Source's Health: Healthy or Stale, when it was last ok, and why it is not. */
export function SourcesWidget({ sources, now }: SourcesWidgetProps) {
  const healthy = sources.filter((s) => s.healthy).length;
  return (
    <Widget
      name="sources"
      title="Sources"
      count={`${healthy} of ${sources.length} Healthy`}
      empty={sources.length === 0 ? "No Source has reported yet." : null}
    >
      <ul class="rows">
        {sources.map((s) => (
          <SourceRow key={s.source} health={s} now={now} />
        ))}
      </ul>
    </Widget>
  );
}

function SourceRow({ health, now }: { health: SourceHealth; now: string }) {
  const id = `source-${health.source}`;
  return (
    <li class="row source" data-healthy={health.healthy} aria-labelledby={id}>
      <div class="row-line">
        <h3 id={id} class="source-name">
          {health.source}
        </h3>
        <span class="state">{health.healthy ? "Healthy" : "Stale"}</span>
      </div>
      <p class="meta">{health.lastOkAt ? <Ago at={health.lastOkAt} now={now} prefix="last ok " /> : "never ok"}</p>
      {health.error && <p class="error">{health.error}</p>}
      {health.note && <p class="note">{health.note}</p>}
    </li>
  );
}
