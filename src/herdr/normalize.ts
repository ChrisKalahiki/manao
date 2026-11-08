import type { HubEvent, HubItem } from "../core/types.js";
import type { Terminal } from "./types.js";

export const AGENT_ITEM_TYPE = "agent";

/**
 * The hub's own vocabulary. herdr-core's `done` means the program finished a
 * turn, which is what a dashboard wants to call out, so it gets its own name
 * instead of being folded into idle.
 */
export type HubAgentStatus = "running" | "needs_attention" | "finished" | "idle" | "unknown";

const STATUS_MAP: Record<string, HubAgentStatus> = {
  working: "running",
  blocked: "needs_attention",
  error: "needs_attention",
  done: "finished",
  idle: "idle",
};

/** Tolerates words a future program might report by mapping them to "unknown". */
export function toHubStatus(state: string): HubAgentStatus {
  return Object.hasOwn(STATUS_MAP, state) ? (STATUS_MAP[state] as HubAgentStatus) : "unknown";
}

/**
 * How long a finished agent raises Attention. Codex leaves `done` once its terminal
 * is viewed, Claude Code only at its next prompt, so without a limit a finished
 * Claude Code agent would sit in "Needs you" all day.
 */
export const FINISHED_ATTENTION_MS = 30 * 60_000;

function agentStatus(state: string, statusMs: number | null, now: string): HubAgentStatus {
  const status = toHubStatus(state);
  const agedOut = status === "finished" && statusMs !== null && Date.parse(now) - statusMs >= FINISHED_ATTENTION_MS;
  return agedOut ? "idle" : status;
}

export interface AgentData {
  /** herdr-core's address, `t7`: the terminal for the core's life. */
  terminalId: string;
  /** Where the Herdr app shows it, "Manaʻo / 1" (its `where` label). */
  where: string | null;
  /** The reporting program, e.g. "claude-code" or "codex". */
  agentKind: string | null;
  name: string | null;
  cwd: string;
  /** The program's own word, kept for debugging. */
  herdrStatus: string;
  /** Why it is blocked, when it said: permission, question or auth. */
  blockedKind: string | null;
  /** 0 to 100, when it said. */
  progress: number | null;
  /** Goes up each time the status leaves `working`. */
  turn: number;
  /** When the program's word last changed, ms since the epoch. */
  statusMs: number | null;
  /** What it says it is doing, else the terminal title. */
  activity: string | null;
  /** Words for a Status the hub Status alone would misname ("error" rather than "needs you"). */
  statusLabel: string | null;
}

export type AgentItem = HubItem<AgentData>;

export type TransitionKind = "appeared" | "changed" | "cycled" | "gone";

export interface AgentTransition {
  kind: TransitionKind;
  terminalId: string;
  where: string | null;
  agentKind: string | null;
  /** null when the agent just appeared. */
  from: HubAgentStatus | null;
  /** null when the agent just disappeared. */
  to: HubAgentStatus | null;
  /** True when this transition is "it finished work": into finished, or idle with a higher turn. */
  completed: boolean;
  turn: number;
}

/** A terminal is an Agent when its program reports a status; other machines' (`machine/t7`) are out of scope. */
function isLocalAgent(terminal: Terminal): boolean {
  return terminal.status != null && !terminal.address.includes("/");
}

function buildItem(terminal: Terminal, now: string, sourceId: string): AgentItem {
  const report = terminal.status ?? { state: "unknown" };
  const statusMs = terminal.status_ms ?? null;
  const status = agentStatus(report.state, statusMs, now);
  const where = terminal.labels.where ?? null;
  const agentKind = report.app ?? null;
  const who = agentKind ?? terminal.name ?? "agent";

  return {
    source: sourceId,
    type: AGENT_ITEM_TYPE,
    id: terminal.address,
    title: where ? `${where}: ${who}` : who,
    status,
    // Blocked, erroring, or finished: each needs a human.
    attention: status === "needs_attention" || status === "finished",
    updatedAt: now,
    data: {
      terminalId: terminal.address,
      where,
      agentKind,
      name: terminal.name ?? null,
      cwd: terminal.cwd,
      herdrStatus: report.state,
      blockedKind: report.kind ?? null,
      progress: report.progress ?? null,
      turn: terminal.turn ?? 0,
      statusMs,
      activity: report.msg || terminal.title || null,
      statusLabel: report.state === "error" ? "error" : null,
    },
  };
}

/**
 * Pure function: previous items + the live terminals in, new items +
 * transitions out. `updatedAt` only moves when something changed, so the hub
 * can show "idle for 40 minutes". Times are when the hub OBSERVED the change,
 * so their resolution is the poll interval, not herdr-core's clock.
 */
export function reconcile(
  prev: ReadonlyMap<string, AgentItem>,
  terminals: readonly Terminal[],
  now: string,
  sourceId: string,
): { items: AgentItem[]; transitions: AgentTransition[] } {
  const items: AgentItem[] = [];
  const transitions: AgentTransition[] = [];
  const seen = new Set<string>();

  for (const terminal of terminals.filter(isLocalAgent)) {
    const item = buildItem(terminal, now, sourceId);
    seen.add(item.id);
    const before = prev.get(item.id);
    const to = item.status as HubAgentStatus;
    const base = { terminalId: item.id, where: item.data.where, agentKind: item.data.agentKind, turn: item.data.turn };

    if (!before) {
      transitions.push({ ...base, kind: "appeared", from: null, to, completed: false });
      items.push(item);
      continue;
    }
    const turned = item.data.turn > before.data.turn;
    const completed = to === "finished" || (to === "idle" && turned);
    if (before.status !== item.status) {
      transitions.push({ ...base, kind: "changed", from: before.status as HubAgentStatus, to, completed });
    } else if (turned) {
      // Same status as last poll, but its turn moved in between
      // (e.g. idle -> working -> idle inside one poll interval).
      transitions.push({ ...base, kind: "cycled", from: before.status as HubAgentStatus, to, completed });
    } else {
      item.updatedAt = before.updatedAt;
    }
    items.push(item);
  }

  for (const [id, before] of prev) {
    if (seen.has(id)) continue;
    transitions.push({
      kind: "gone",
      terminalId: id,
      where: before.data.where,
      agentKind: before.data.agentKind,
      from: before.status as HubAgentStatus,
      to: null,
      completed: false,
      turn: before.data.turn,
    });
  }

  return { items, transitions };
}

const SORT_RANK: Record<HubAgentStatus, number> = {
  needs_attention: 0,
  finished: 1,
  running: 2,
  idle: 3,
  unknown: 4,
};

/** Things that want you first, then things in flight, then everything else. */
export function sortForDashboard(items: readonly AgentItem[]): AgentItem[] {
  return [...items].sort(
    (a, b) =>
      SORT_RANK[a.status as HubAgentStatus] - SORT_RANK[b.status as HubAgentStatus] ||
      (a.data.where ?? "").localeCompare(b.data.where ?? "") ||
      a.id.localeCompare(b.id, undefined, { numeric: true }),
  );
}

export const TRANSITION_EVENT_KIND = "agent.transition";

export function transitionToEvent(t: AgentTransition, sourceId: string, at: string): HubEvent<AgentTransition> {
  return { source: sourceId, kind: TRANSITION_EVENT_KIND, at, data: t };
}
