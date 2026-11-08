import { render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";
import { outline } from "./outline.js";

const NOW = "2026-10-19T08:00:00.000Z";
const NOTE = "Weekly/2026-W43.md";

interface TodoFixture {
  id: string;
  title: string;
  status?: "open" | "done" | "dropped";
  groupPath?: string[];
  line: number;
  parentId?: string;
}

/** A `todo` Item as `/api/items` sends it for Brain-Dump. */
function todo({ id, title, status = "open", groupPath = [], line, parentId }: TodoFixture, healthy = true) {
  return {
    source: "brain-dump:todos",
    type: "todo",
    id,
    title,
    status,
    attention: false,
    updatedAt: "2026-10-19T07:00:00.000Z",
    data: { note: NOTE, groupPath, line, parentId: parentId ?? null },
    sourceOk: healthy,
    lastOkAt: healthy ? NOW : "2026-10-19T06:00:00.000Z",
  };
}

const brainDump = (healthy: boolean) => ({
  source: "brain-dump:todos",
  ok: healthy,
  at: NOW,
  ...(healthy ? {} : { error: "brain-dump exited with code 1" }),
  staleAfterMs: 180_000,
  lastOkAt: healthy ? NOW : "2026-10-19T06:00:00.000Z",
  healthy,
});

/** An agent Item, which the Todos widget must leave alone. */
const agent = {
  source: "herdr:local",
  type: "agent",
  id: "t1",
  title: "claude in manao",
  status: "running",
  attention: false,
  updatedAt: NOW,
  data: {},
  sourceOk: true,
  lastOkAt: NOW,
};

const serve = (items: unknown[], sources: unknown[] = [brainDump(true)]) => fakeHub({ now: NOW, items, sources });

const widget = () => screen.findByRole("region", { name: "Todos" });
const row = (title: string) => screen.getByRole("listitem", { name: title });

describe("Dashboard: Todos widget", () => {
  beforeEach(() => {
    clockFarFromHub();
    showAll();
  });
  afterEach(resetBrowser);

  it("nests Todos under their Todo Groups, nested groups included, in the Weekly Note's line order", async () => {
    serve([
      todo({ id: "e1", title: "Buy stamps", groupPath: ["Errands"], line: 14 }),
      todo({ id: "h3", title: "Tidy the README", groupPath: ["Manaʻo"], line: 11 }),
      agent,
      todo({ id: "d1", title: "Todos widget", groupPath: ["Manaʻo", "Dashboard"], line: 8 }),
      todo({ id: "t0", title: "Plan the week", line: 3 }),
      todo({ id: "h1", title: "Ship step 5", groupPath: ["Manaʻo"], line: 6 }),
      todo({ id: "d2", title: "Agents widget", groupPath: ["Manaʻo", "Dashboard"], line: 9 }),
      todo({ id: "t1", title: "Call the dentist", line: 16 }),
    ]);
    render(<App />);

    expect(outline(await widget())).toEqual([
      "Plan the week",
      "# Manaʻo",
      "  Ship step 5",
      "  # Dashboard",
      "    Todos widget",
      "    Agents widget",
      "  Tidy the README",
      "# Errands",
      "  Buy stamps",
      "Call the dentist",
    ]);
  });

  it("puts subtodos under their parent Todo, nested as deep as they go", async () => {
    serve([
      todo({ id: "p2", title: "Dentist", line: 10 }),
      todo({ id: "s2", title: "Find the insurance card", line: 11, parentId: "p2" }),
      todo({ id: "s1b", title: "Write the outline", groupPath: ["Manaʻo"], line: 6, parentId: "p1" }),
      todo({ id: "p1", title: "Write the spec", groupPath: ["Manaʻo"], line: 3 }),
      todo({ id: "s1a1", title: "Pick a title", groupPath: ["Manaʻo"], line: 5, parentId: "s1a" }),
      todo({ id: "s1a", title: "Read the spec", groupPath: ["Manaʻo"], line: 4, parentId: "p1" }),
      todo({ id: "h2", title: "Merge it", groupPath: ["Manaʻo"], line: 8 }),
    ]);
    render(<App />);

    expect(outline(await widget())).toEqual([
      "# Manaʻo",
      "  Write the spec",
      "    Read the spec",
      "      Pick a title",
      "    Write the outline",
      "  Merge it",
      "Dentist",
      "  Find the insurance card",
    ]);
  });

  it("keeps done and dropped Todos in place, each saying which it is, with nothing to tick", async () => {
    serve([
      todo({ id: "a", title: "Ship step 5", line: 3 }),
      todo({ id: "b", title: "Book the venue", status: "done", line: 4 }),
      todo({ id: "c", title: "Rewrite it in Rust", status: "dropped", line: 5 }),
    ]);
    render(<App />);
    await widget();

    expect(within(row("Ship step 5")).getByRole("img", { name: "Open" })).toBeTruthy();
    expect(within(row("Book the venue")).getByRole("img", { name: "Done" })).toBeTruthy();
    expect(within(row("Rewrite it in Rust")).getByRole("img", { name: "Dropped" })).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("counts the open Todos, subtodos included, in the header", async () => {
    serve([
      todo({ id: "a", title: "Ship step 5", groupPath: ["Manaʻo"], line: 3 }),
      todo({ id: "b", title: "Todos widget", groupPath: ["Manaʻo"], line: 4, parentId: "a" }),
      todo({ id: "c", title: "Agents widget", status: "done", groupPath: ["Manaʻo"], line: 5, parentId: "a" }),
      todo({ id: "d", title: "Rewrite it in Rust", status: "dropped", line: 6 }),
      todo({ id: "e", title: "Call the dentist", line: 7 }),
    ]);
    render(<App />);

    expect(within(await widget()).getByText("3 open")).toBeTruthy();
  });

  it("marks Todos from a Source that is not Healthy as last known, with when they were read, and still shows them", async () => {
    serve(
      [
        todo({ id: "a", title: "Ship step 5", groupPath: ["Manaʻo"], line: 3 }, false),
        todo({ id: "b", title: "Book the venue", status: "done", line: 4 }, false),
      ],
      [brainDump(false)],
    );
    render(<App />);

    const todos = within(await widget());
    expect(todos.getByText(/^Last known/).textContent).toBe("Last known, read 2 h ago");
    expect(outline(await widget())).toEqual(["# Manaʻo", "  Ship step 5", "Book the venue"]);
  });

  it("does not mark Todos from a Healthy Source", async () => {
    serve([todo({ id: "a", title: "Ship step 5", line: 3 })]);
    render(<App />);

    expect(within(await widget()).queryByText(/Last known/)).toBeNull();
  });

  it("says so when this week's Weekly Note has no Todos", async () => {
    serve([agent]);
    render(<App />);

    const todos = within(await widget());
    expect(todos.getByText("No Todos in this week’s Weekly Note.")).toBeTruthy();
    expect(todos.queryByRole("list")).toBeNull();
    expect(todos.queryByText(/open$/)).toBeNull();
  });
});
