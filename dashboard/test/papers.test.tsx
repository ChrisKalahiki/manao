import { render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";

const SOURCE = "paper-bot:picks";

/** An instant on a day of October 2026 in the zone the tests run in, as the hub sends it. */
const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

/** Wednesday 28 October 2026, 09:00: the week of Monday 26 October. */
const NOW = at(28, 9);

const briefing = (date: string) => `Research/Briefings/Daily/${date} Daily Briefing.md`;

interface PickSpec {
  id: string;
  title: string;
  date: string;
  interests?: string[];
  wildcard?: boolean;
  why?: string;
  url?: string;
  kept?: boolean;
  briefing?: string;
  sourceOk?: boolean;
}

/** A `paper` Item as the paper-bot Adapter sends it through `/api/items`. */
function pick(spec: PickSpec) {
  const healthy = spec.sourceOk ?? true;
  const kept = spec.kept ?? false;
  return {
    source: SOURCE,
    type: "paper",
    id: `paper-bot:arxiv:${spec.id}`,
    title: spec.title,
    status: kept ? "kept" : "picked",
    attention: false,
    updatedAt: at(28, 6),
    data: {
      title: spec.title,
      url: spec.url ?? `https://arxiv.org/abs/${spec.id}`,
      date: spec.date,
      interests: spec.interests ?? ["Context management in AI"],
      wildcard: spec.wildcard ?? false,
      why: spec.why ?? "It measures what long contexts forget.",
      briefing: spec.briefing ?? briefing(spec.date),
      keptAt: kept ? at(28, 7) : null,
    },
    sourceOk: healthy,
    lastOkAt: healthy ? NOW : at(28, 5),
  };
}

const paperBot = (healthy: boolean) => ({
  source: SOURCE,
  ok: healthy,
  at: NOW,
  ...(healthy ? {} : { error: "paper-bot exited with code 1" }),
  staleAfterMs: 2_700_000,
  lastOkAt: healthy ? NOW : at(28, 5),
  healthy,
});

const serve = (items: unknown[], sources: unknown[] = [paperBot(true)]) => fakeHub({ now: NOW, items, sources });

const widget = async () => within(await screen.findByRole("region", { name: "Papers" }));
const row = async (title: string) => (await widget()).findByRole("listitem", { name: title });

/** Each day's heading followed by its Picks' titles, in the order a screen reader meets them. */
function days(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("h3, h4")).map((heading) =>
    heading.tagName === "H3" ? `# ${heading.textContent}` : (heading.textContent ?? ""),
  );
}

describe("Dashboard: Papers widget", () => {
  beforeEach(() => {
    clockFarFromHub();
    showAll();
  });
  afterEach(resetBrowser);

  it("groups this week's Picks by day, newest first, each day's Picks in paper-bot's order", async () => {
    serve([
      pick({ id: "1", title: "Monday's first", date: "2026-10-26" }),
      pick({ id: "2", title: "Monday's second", date: "2026-10-26" }),
      pick({ id: "3", title: "Tuesday's", date: "2026-10-27" }),
      pick({ id: "4", title: "Today's second", date: "2026-10-28" }),
      pick({ id: "5", title: "Today's first", date: "2026-10-28" }),
    ]);
    render(<App />);

    expect(days(await screen.findByRole("region", { name: "Papers" }))).toEqual([
      "# Today",
      "Today's second",
      "Today's first",
      "# Yesterday",
      "Tuesday's",
      "# Monday",
      "Monday's first",
      "Monday's second",
    ]);
  });

  it("links each title to its paper in a new tab, only when the link is https", async () => {
    serve([
      pick({ id: "2610.32109", title: "Long contexts forget", date: "2026-10-28" }),
      pick({ id: "x", title: "A javascript: link", date: "2026-10-28", url: "javascript:alert(1)" }),
      pick({ id: "y", title: "A plain http link", date: "2026-10-28", url: "http://example.com/paper" }),
    ]);
    render(<App />);

    const link = within(await row("Long contexts forget")).getByRole("link", { name: "Long contexts forget" });
    expect(link.getAttribute("href")).toBe("https://arxiv.org/abs/2610.32109");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(await row("A javascript: link")).queryByRole("link", { name: "A javascript: link" })).toBeNull();
    expect(within(await row("A plain http link")).queryByRole("link", { name: "A plain http link" })).toBeNull();
  });

  it("shows each Pick's Interests and why line, and says in words which are Wildcards and which are kept", async () => {
    serve([
      pick({
        id: "1",
        title: "Long contexts forget",
        date: "2026-10-28",
        interests: ["Context management in AI", "Evaluation"],
        why: "It measures what long contexts forget.",
        kept: true,
      }),
      pick({ id: "2", title: "Bees and graphs", date: "2026-10-28", interests: [], wildcard: true, why: "Odd, but good." }),
      pick({ id: "3", title: "Plain pick", date: "2026-10-28" }),
    ]);
    render(<App />);

    const kept = within(await row("Long contexts forget"));
    const interests = kept.getByRole("list", { name: "Interests" });
    expect(within(interests).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Context management in AI",
      "Evaluation",
    ]);
    expect(kept.getByText("It measures what long contexts forget.")).toBeTruthy();
    expect(kept.getByText("Kept")).toBeTruthy();
    expect(kept.queryByText("Wildcard")).toBeNull();

    const wildcard = within(await row("Bees and graphs"));
    expect(wildcard.getByText("Wildcard")).toBeTruthy();
    expect(wildcard.queryByText("Kept")).toBeNull();
    expect(wildcard.queryByRole("list", { name: "Interests" })).toBeNull();
    expect(wildcard.getByText("Odd, but good.")).toBeTruthy();

    const plain = within(await row("Plain pick"));
    expect(plain.queryByText("Kept")).toBeNull();
    expect(plain.queryByText("Wildcard")).toBeNull();
  });

  it("links each day to its Briefing in Obsidian, by its path in the vault", async () => {
    serve([
      pick({ id: "1", title: "Today's", date: "2026-10-28" }),
      pick({ id: "2", title: "Monday's", date: "2026-10-26" }),
      pick({ id: "3", title: "Tuesday's", date: "2026-10-27", briefing: "" }),
    ]);
    render(<App />);
    const papers = await widget();

    const today = within(papers.getByRole("listitem", { name: "Today" }));
    expect(today.getByRole("link", { name: "Open Today’s Briefing in Obsidian" }).getAttribute("href")).toBe(
      "obsidian://open?file=Research%2FBriefings%2FDaily%2F2026-10-28%20Daily%20Briefing.md",
    );
    const monday = within(papers.getByRole("listitem", { name: "Monday" }));
    expect(monday.getByRole("link", { name: "Open Monday’s Briefing in Obsidian" }).getAttribute("href")).toBe(
      "obsidian://open?file=Research%2FBriefings%2FDaily%2F2026-10-26%20Daily%20Briefing.md",
    );
    const yesterday = within(papers.getByRole("listitem", { name: "Yesterday" }));
    expect(yesterday.queryByRole("link", { name: /Briefing/ })).toBeNull();
  });

  it("counts this week's Picks in the header", async () => {
    serve([
      pick({ id: "1", title: "One", date: "2026-10-28" }),
      pick({ id: "2", title: "Two", date: "2026-10-27", kept: true }),
    ]);
    render(<App />);

    expect((await widget()).getByText("2 this week")).toBeTruthy();
  });

  it("marks Picks from a paper-bot that is not Healthy as last known, with when they were read, and still shows them", async () => {
    serve([pick({ id: "1", title: "Long contexts forget", date: "2026-10-28", sourceOk: false })], [paperBot(false)]);
    render(<App />);

    const papers = await widget();
    expect(papers.getByText(/^Last known/).textContent).toBe("Last known, read 4 h ago");
    expect(await row("Long contexts forget")).toBeTruthy();
  });

  it("does not mark Picks from a Healthy paper-bot", async () => {
    serve([pick({ id: "1", title: "Long contexts forget", date: "2026-10-28" })]);
    render(<App />);

    expect((await widget()).queryByText(/Last known/)).toBeNull();
  });

  it("says so when there are no Picks this week", async () => {
    serve([]);
    render(<App />);

    const papers = await widget();
    expect(papers.getByText("No Picks this week.")).toBeTruthy();
    expect(papers.queryByRole("list")).toBeNull();
    expect(papers.queryByText(/this week$/)).toBeNull();
  });

  it("is read from the All view's Items, with no request of its own, and is not on the Today view", async () => {
    const hub = serve([pick({ id: "1", title: "Long contexts forget", date: "2026-10-28" })]);
    render(<App />);
    await row("Long contexts forget");

    expect(new Set(hub.requests())).toEqual(new Set(["/api/items", "/api/sources", "/api/measurements"]));

    window.location.hash = "#today";
    await screen.findByRole("region", { name: "Needs you" });
    expect(screen.queryByRole("region", { name: "Papers" })).toBeNull();
  });
});
