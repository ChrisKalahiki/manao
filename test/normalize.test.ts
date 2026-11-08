import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type AgentItem, FINISHED_ATTENTION_MS, reconcile, sortForDashboard, toHubStatus } from "../src/herdr/normalize.js";
import { parseTerminalList, type Terminal } from "../src/herdr/types.js";
import { terminal, type TerminalSpec } from "./helpers.js";

const SOURCE = "herdr:local";
const T0 = "2026-11-01T20:00:00.000Z";
const T1 = "2026-11-01T20:00:05.000Z";

const fixture = parseTerminalList(JSON.parse(readFileSync("fixtures/terminal-list.json", "utf8")));
const terminals = (...specs: TerminalSpec[]): Terminal[] => parseTerminalList({ terminals: specs.map(terminal) });
const prevOf = (items: AgentItem[]) => new Map(items.map((i) => [i.id, i]));

describe("toHubStatus", () => {
  it.each([
    ["working", "running"],
    ["blocked", "needs_attention"],
    ["error", "needs_attention"],
    ["done", "finished"],
    ["idle", "idle"],
    ["thinking", "unknown"],
    ["constructor", "unknown"],
  ])("maps %s to %s", (state, status) => {
    expect(toHubStatus(state)).toBe(status);
  });
});

describe("reconcile on a real-shaped terminal list", () => {
  const { items } = reconcile(new Map(), fixture, T0, SOURCE);
  const byId = (id: string) => items.find((i) => i.id === id);

  it("makes an Item of each local terminal whose program reports a status, leaving out shells and other machines", () => {
    expect(items.map((i) => i.id)).toEqual(["t2", "t3", "t4", "t5", "t6"]);
  });

  it("maps each program's word to a Status, with Attention on blocked, erroring and done ones", () => {
    expect(items.map((i) => [i.id, i.status, i.attention])).toEqual([
      ["t2", "running", false],
      ["t3", "needs_attention", true],
      ["t4", "finished", true],
      ["t5", "idle", false],
      ["t6", "needs_attention", true],
    ]);
  });

  it("titles an agent by where the app shows it and the reporting program, falling back to the program alone", () => {
    expect(byId("t2")?.title).toBe("Manaʻo / 1: claude-code");
    expect(byId("t5")?.title).toBe("claude-code");
  });

  it("keeps the fields the dashboard and agents read", () => {
    expect(byId("t3")?.data).toEqual({
      terminalId: "t3",
      where: "Paper Bot / 1",
      agentKind: "codex",
      name: null,
      cwd: "/Users/me/Projects/bot",
      herdrStatus: "blocked",
      blockedKind: "permission",
      progress: null,
      turn: 6,
      statusMs: 1793584502248,
      activity: "Allow running bun install?",
      statusLabel: null,
    });
  });

  it("labels an erroring agent as an error rather than as needing Chris", () => {
    expect(byId("t6")?.data.statusLabel).toBe("error");
  });

  it("falls back to the terminal title for activity, and to null when both are empty", () => {
    expect(byId("t4")?.data.activity).toBe("Sweep the logs");
    expect(byId("t5")?.data.activity).toBeNull();
  });

  it("never keeps a command line, the foreground process, other records or labels other than where", () => {
    const stored = JSON.stringify(items);
    expect(stored).not.toContain("sk-not-a-real-token");
    expect(stored).not.toContain("Running the tests");
    expect(stored).not.toContain("herdr.space");
    expect(stored).not.toContain("/Users/me/Projects/manao/src");
  });
});

describe("reconcile across reads", () => {
  it("announces new agents as appeared", () => {
    const { transitions } = reconcile(new Map(), terminals({ address: "t1", status: "working" }), T0, SOURCE);
    expect(transitions).toEqual([
      { kind: "appeared", terminalId: "t1", where: "Manaʻo / 1", agentKind: "claude-code", from: null, to: "running", completed: false, turn: 0 },
    ]);
  });

  it("records a change of Status, moving updatedAt", () => {
    const first = reconcile(new Map(), terminals({ address: "t1", status: "working" }), T0, SOURCE);
    const { items, transitions } = reconcile(prevOf(first.items), terminals({ address: "t1", status: "blocked" }), T1, SOURCE);

    expect(transitions).toEqual([expect.objectContaining({ kind: "changed", from: "running", to: "needs_attention", completed: false })]);
    expect(items[0]?.updatedAt).toBe(T1);
  });

  it.each([
    ["into done", "working", 3, "done", 4, true],
    ["into idle on a higher turn", "working", 3, "idle", 4, true],
    ["into idle on the same turn", "blocked", 3, "idle", 3, false],
    ["into blocked on a higher turn", "working", 3, "blocked", 4, false],
  ])("counts a change %s as completed: %s", (_name, fromState, fromTurn, toState, toTurn, completed) => {
    const first = reconcile(new Map(), terminals({ address: "t1", status: fromState, turn: fromTurn }), T0, SOURCE);
    const { transitions } = reconcile(prevOf(first.items), terminals({ address: "t1", status: toState, turn: toTurn }), T1, SOURCE);
    expect(transitions[0]?.completed).toBe(completed);
  });

  it("records a cycle within one poll when the Status is the same but the turn went up", () => {
    const first = reconcile(new Map(), terminals({ address: "t1", status: "idle", turn: 2 }), T0, SOURCE);
    const { transitions } = reconcile(prevOf(first.items), terminals({ address: "t1", status: "idle", turn: 3 }), T1, SOURCE);
    expect(transitions).toEqual([expect.objectContaining({ kind: "cycled", from: "idle", to: "idle", completed: true, turn: 3 })]);
  });

  it("keeps updatedAt and emits nothing when nothing moved", () => {
    const first = reconcile(new Map(), terminals({ address: "t1", status: "working", msg: "Reading" }), T0, SOURCE);
    const { items, transitions } = reconcile(prevOf(first.items), terminals({ address: "t1", status: "working", msg: "Writing" }), T1, SOURCE);
    expect(transitions).toEqual([]);
    expect(items[0]?.updatedAt).toBe(T0);
  });

  it("announces an agent whose terminal went away, or stopped reporting, as gone", () => {
    const first = reconcile(new Map(), terminals({ address: "t1", status: "done", turn: 4 }), T0, SOURCE);
    const { items, transitions } = reconcile(prevOf(first.items), terminals({ address: "t1", status: null }), T1, SOURCE);
    expect(items).toEqual([]);
    expect(transitions).toEqual([
      { kind: "gone", terminalId: "t1", where: "Manaʻo / 1", agentKind: "claude-code", from: "finished", to: null, completed: false, turn: 4 },
    ]);
  });
});

describe("a finished agent ageing out", () => {
  const finishedAt = Date.parse(T0);
  const at = (ms: number) => new Date(finishedAt + ms).toISOString();
  const done = (statusMs: number | null = finishedAt) => terminals({ address: "t1", status: "done", turn: 4, statusMs });

  it("stays finished, with Attention, for 30 minutes after it finished", () => {
    // #when
    const { items } = reconcile(new Map(), done(), at(FINISHED_ATTENTION_MS - 1), SOURCE);

    // #then
    expect([items[0]?.status, items[0]?.attention]).toEqual(["finished", true]);
  });

  it("counts as idle, without Attention, once 30 minutes have passed", () => {
    // #when
    const { items } = reconcile(new Map(), done(), at(FINISHED_ATTENTION_MS), SOURCE);

    // #then
    expect([items[0]?.status, items[0]?.attention]).toEqual(["idle", false]);
  });

  it("records ageing out as a change to idle, not as finishing again", () => {
    // #given
    const first = reconcile(new Map(), done(), at(FINISHED_ATTENTION_MS - 1), SOURCE);

    // #when
    const { transitions } = reconcile(prevOf(first.items), done(), at(FINISHED_ATTENTION_MS), SOURCE);

    // #then
    expect(transitions).toEqual([expect.objectContaining({ kind: "changed", from: "finished", to: "idle", completed: false })]);
  });

  it("stays finished when the program never said when", () => {
    // #when
    const { items } = reconcile(new Map(), done(null), at(10 * FINISHED_ATTENTION_MS), SOURCE);

    // #then
    expect(items[0]?.status).toBe("finished");
  });
});

describe("sortForDashboard", () => {
  it("puts what needs Chris first, then by where, then by address in number order", () => {
    const { items } = reconcile(
      new Map(),
      terminals(
        { address: "t10", status: "working", where: "B" },
        { address: "t9", status: "working", where: "B" },
        { address: "t1", status: "idle", where: "A" },
        { address: "t2", status: "blocked", where: "Z" },
        { address: "t3", status: "working", where: "A" },
      ),
      T0,
      SOURCE,
    );
    expect(sortForDashboard(items).map((i) => i.id)).toEqual(["t2", "t3", "t9", "t10", "t1"]);
  });
});
