import type { ComponentChildren } from "preact";
import { ago } from "../time.js";

/** A `<time>` for an ISO time, with the full local date and time on hover. */
export function Time({ at, children }: { at: string; children: ComponentChildren }) {
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()}>
      {children}
    </time>
  );
}

/** How long before the hub's `now` a time was, e.g. "3 min ago", after an optional prefix. */
export function Ago({ at, now, prefix = "" }: { at: string; now: string; prefix?: string }) {
  return <Time at={at}>{`${prefix}${ago(at, now)}`}</Time>;
}
