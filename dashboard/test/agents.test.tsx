import { render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { clockFarFromHub, fakeHub, resetBrowser, showAll } from "./fake-hub.js";

const NOW = "2026-10-19T08:00:00.000Z";

const herdr = (healthy: boolean) => ({
  source: "herdr:local",
  ok: healthy,
  at: NOW,
  staleAfterMs: 15_000,
  lastOkAt: "2026-10-19T07:40:00.000Z",
  healthy,
});

interface AgentSpec {
  id: string;
  status: string;
  where: string | null;
  kind?: string | null;
  activity?: string | null;
  statusLabel?: string | null;
  updatedAt?: string;
  sourceOk?: boolean;
}

/** An `agent` Item as the Herdr Adapter emits it through `/api/items`. */
function agent(spec: AgentSpec) {
  const kind = spec.kind === undefined ? "claude" : spec.kind;
  const who = kind ?? "agent";
  return {
    source: "herdr:local",
    type: "agent",
    id: spec.id,
    title: spec.where ? `${spec.where}: ${who}` : who,
    status: spec.status,
    attention: spec.status === "needs_attention" || spec.status === "finished",
    updatedAt: spec.updatedAt ?? "2026-10-19T07:55:00.000Z",
    data: {
      terminalId: spec.id,
      where: spec.where,
      agentKind: kind,
      name: null,
      cwd: "/Users/me/Projects/manao",
      herdrStatus: "idle",
      blockedKind: null,
      progress: null,
      turn: 0,
      statusMs: null,
      activity: spec.activity ?? null,
      statusLabel: spec.statusLabel ?? null,
    },
    sourceOk: spec.sourceOk ?? true,
    lastOkAt: "2026-10-19T07:40:00.000Z",
  };
}

const todo = {
  source: "brain-dump:todos",
  type: "todo",
  id: "todo-1",
  title: "Write the Agents widget",
  status: "open",
  attention: false,
  updatedAt: NOW,
  data: {},
  sourceOk: true,
  lastOkAt: NOW,
};

const serve = (items: unknown[], sources: unknown[] = [herdr(true)]) => fakeHub({ now: NOW, items, sources });

const agentsWidget = async () => within(await screen.findByRole("region", { name: "Agents" }));
const agentRow = async (title: string) => (await agentsWidget()).findByRole("listitem", { name: title });

describe("Dashboard: Agents widget", () => {
  beforeEach(() => {
    clockFarFromHub();
    showAll();
  });
  afterEach(resetBrowser);

  it("lists what needs Chris first: Status rank, then where, then terminal in number order", async () => {
    serve([
      agent({ id: "t1", status: "idle", where: "alpha" }),
      agent({ id: "t2", status: "running", where: "beta" }),
      agent({ id: "t3", status: "unknown", where: "alpha" }),
      agent({ id: "t4", status: "finished", where: "gamma" }),
      agent({ id: "t5", status: "needs_attention", where: "zeta" }),
      agent({ id: "t10", status: "running", where: "alpha", kind: "codex" }),
      agent({ id: "t9", status: "running", where: "alpha", kind: "pi" }),
      todo,
    ]);
    render(<App />);
    const widget = await agentsWidget();
    await widget.findByRole("listitem", { name: "zeta: claude" });

    const titles = widget.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(titles).toEqual([
      "zeta: claude",
      "gamma: claude",
      "alpha: pi",
      "alpha: codex",
      "beta: claude",
      "alpha: claude",
      "alpha: claude",
    ]);
    expect(widget.queryByText("Write the Agents widget")).toBeNull();
  });

  it("shows each agent's place in the app, kind, status label and age from the hub's clock", async () => {
    serve([
      agent({
        id: "a",
        status: "needs_attention",
        where: "manao",
        kind: "codex",
        statusLabel: "Waiting for approval",
        updatedAt: "2026-10-19T07:48:00.000Z",
      }),
    ]);
    render(<App />);

    const row = within(await agentRow("manao: codex"));
    expect(row.getByText("manao")).toBeTruthy();
    expect(row.getByText("codex")).toBeTruthy();
    expect(row.getByText("Waiting for approval")).toBeTruthy();
    expect(row.getByText("12 min ago")).toBeTruthy();
  });

  it("shows what each agent says it is doing", async () => {
    serve([agent({ id: "t1", status: "running", where: "manao", activity: "Reading the client" }), agent({ id: "t2", status: "idle", where: "notes" })]);
    render(<App />);

    expect(within(await agentRow("manao: claude")).getByText("Reading the client")).toBeTruthy();
  });

  it("calls an erroring agent an error, not one that needs Chris", async () => {
    serve([agent({ id: "t1", status: "needs_attention", where: "chronos", kind: "codex", statusLabel: "error" })]);
    render(<App />);

    const row = within(await agentRow("chronos: codex"));
    expect(row.getByText("error")).toBeTruthy();
    expect(row.queryByText("Needs you")).toBeNull();
  });

  it("names the Status in words when Herdr gives no label", async () => {
    serve([
      agent({ id: "a", status: "needs_attention", where: "one" }),
      agent({ id: "b", status: "finished", where: "two" }),
      agent({ id: "c", status: "running", where: "three" }),
      agent({ id: "d", status: "idle", where: "four" }),
      agent({ id: "e", status: "unknown", where: "five", kind: null }),
    ]);
    render(<App />);

    expect(within(await agentRow("one: claude")).getByText("Needs you")).toBeTruthy();
    expect(within(await agentRow("two: claude")).getByText("Finished")).toBeTruthy();
    expect(within(await agentRow("three: claude")).getByText("Running")).toBeTruthy();
    expect(within(await agentRow("four: claude")).getByText("Idle")).toBeTruthy();
    expect(within(await agentRow("five: agent")).getByText("Unknown")).toBeTruthy();
  });

  it("counts the agents that need Chris", async () => {
    serve([
      agent({ id: "a", status: "needs_attention", where: "one" }),
      agent({ id: "b", status: "finished", where: "two" }),
      agent({ id: "c", status: "running", where: "three" }),
    ]);
    render(<App />);

    expect((await agentsWidget()).getByText("2 of 3 need you")).toBeTruthy();
  });

  it("counts only the running agents as running when none need Chris", async () => {
    serve([
      agent({ id: "a", status: "running", where: "one" }),
      agent({ id: "b", status: "idle", where: "two" }),
      agent({ id: "c", status: "unknown", where: "three" }),
    ]);
    render(<App />);

    expect((await agentsWidget()).getByText("1 of 3 running")).toBeTruthy();
  });

  it("keeps agents from a Source that is not Healthy, marked as last known", async () => {
    serve(
      [
        agent({ id: "a", status: "running", where: "manao", sourceOk: false }),
        agent({ id: "b", status: "idle", where: "notes" }),
      ],
      [herdr(false)],
    );
    render(<App />);

    expect(within(await agentRow("manao: claude")).getByText("last known")).toBeTruthy();
    expect(within(await agentRow("notes: claude")).queryByText("last known")).toBeNull();
  });

  it("says so when no agents are running", async () => {
    serve([todo]);
    render(<App />);

    expect((await agentsWidget()).getByText("No agents running.")).toBeTruthy();
  });
});
