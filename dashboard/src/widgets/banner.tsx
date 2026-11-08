import type { ComponentChildren } from "preact";
import type { SourceHealth } from "../hub.js";
import { Time } from "./when.js";

export interface BannerProps {
  /** The Sources as the hub last reported them. */
  sources: SourceHealth[];
  /** The hub's clock at its last answer; null if it has not answered yet. */
  lastAnswerAt: string | null;
  /** Why the latest read failed; null while the hub answers. */
  error: string | null;
}

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Says when what is on screen is not current: the hub cannot be reached, or some Sources are Stale. */
export function Banner({ sources, lastAnswerAt, error }: BannerProps) {
  const stale = sources.filter((s) => !s.healthy).map((s) => s.source);
  if (!error && stale.length === 0) return null;
  return (
    <div class="banner">
      {error && (
        <p class="notice" role="alert">
          <strong class="notice-lead">Can’t reach the hub.</strong>{" "}
          {lastAnswerAt ? (
            <>
              Showing what it said at{" "}
              <Time at={lastAnswerAt}>{TIME_FORMAT.format(new Date(lastAnswerAt))}</Time>
              .
            </>
          ) : (
            "Nothing to show until it answers."
          )}{" "}
          <span class="notice-detail">{error}</span>
        </p>
      )}
      {stale.length > 0 && (
        <p class="notice" role="status">
          <SourceList names={stale} /> {stale.length === 1 ? "is" : "are"}{" "}
          <strong class="notice-lead">Stale</strong>:{" "}
          {stale.length === 1 ? "its" : "their"} Items show as last known.
        </p>
      )}
    </div>
  );
}

/** "a", "a and b", "a, b and c", each name set as a Source id. */
function SourceList({ names }: { names: string[] }) {
  const parts: ComponentChildren[] = [];
  names.forEach((name, i) => {
    if (i > 0) parts.push(i === names.length - 1 ? " and " : ", ");
    parts.push(
      <code key={name} class="notice-source">
        {name}
      </code>,
    );
  });
  return <>{parts}</>;
}
