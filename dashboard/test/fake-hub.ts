import { cleanup } from "@testing-library/preact";
import { vi } from "vitest";

export interface AgendaBody {
  attention?: unknown[];
  appointments?: unknown[];
  todos?: unknown[];
  staleSources?: unknown[];
}

export interface HubBodies {
  /** The hub's clock, sent with every answer. */
  now: string;
  items?: unknown[];
  sources?: unknown[];
  measurements?: unknown[];
  /** `/api/agenda`'s lists; any left out is empty. */
  agenda?: AgendaBody;
}

/**
 * A fake hub behind `fetch`: `/api/items`, `/api/sources`, `/api/measurements` and `/api/agenda` answer from
 * `bodies`, or with `status` when it is not 200. `hold()` makes the next requests wait until
 * released.
 */
export function fakeHub(initial: HubBodies) {
  let bodies = initial;
  let status = 200;
  let gate: Promise<void> | null = null;
  let release = () => {};
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (gate) await gate;
    if (status === 0) throw new TypeError("Failed to fetch");
    if (status !== 200) return new Response(JSON.stringify({ error: "Internal error" }), { status });
    const { now, items = [], sources = [], measurements = [], agenda = {} } = bodies;
    const path = String(input);
    const body =
      path === "/api/items"
        ? { now, items }
        : path === "/api/measurements"
          ? { now, measurements }
          : path === "/api/agenda"
            ? { now, attention: [], appointments: [], todos: [], staleSources: [], ...agenda }
            : { now, sources };
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  const requests = () => fetch.mock.calls.map(([input]) => String(input));
  return {
    fetch,
    /** Every path requested so far, in order. */
    requests,
    /** How many reads of `path` there have been; `/api/sources` stands for the All view's reads. */
    ticks: (path: string) => requests().filter((p) => p === path).length,
    answer(next: HubBodies) {
      bodies = next;
      status = 200;
    },
    /** 0 is a network failure; anything else is a non-OK answer. */
    fail(next = 500) {
      status = next;
    },
    hold() {
      gate = new Promise((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
    },
    release: () => release(),
  };
}

/** Opens the page at the All view, as a bookmark of `#all` would. */
export function showAll() {
  window.location.hash = "#all";
}

/**
 * Sets the browser's clock far from the hub's `now`, so an age or time read from it would be
 * years off. Fakes only `Date` unless `timers` is set.
 */
export function clockFarFromHub({ timers = false } = {}) {
  vi.useFakeTimers(timers ? undefined : { toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
}

/** Unmounts the page and puts back the real clock, `fetch` and the home view. */
export function resetBrowser() {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.location.hash = "";
}
