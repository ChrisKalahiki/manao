import { fields, type StoredItem } from "../hub.js";
import { Ago } from "./when.js";
import { Widget } from "./widget.js";

export interface AgentsWidgetProps {
  /** The `agent` Items, in any order. */
  items: StoredItem[];
  /** The hub's clock. */
  now: string;
}

/** The fields of an `agent` Item's `data` the widget shows, as the Herdr Adapter sends them. */
interface AgentData {
  terminalId: string;
  where: string | null;
  agentKind: string | null;
  activity: string | null;
  statusLabel: string | null;
}

interface Agent {
  item: StoredItem;
  data: AgentData;
}

const UNKNOWN = { rank: 4, text: "Unknown" };

/** Each Status's place in the list, what needs the user first, and its words when Herdr gives no label. */
const STATUSES: Record<string, { rank: number; text: string }> = {
  needs_attention: { rank: 0, text: "Needs you" },
  finished: { rank: 1, text: "Finished" },
  running: { rank: 2, text: "Running" },
  idle: { rank: 3, text: "Idle" },
  unknown: UNKNOWN,
};

const statusOf = (status: string) => STATUSES[status] ?? UNKNOWN;

/** Herdr's agents, what needs the user first: blocked or erroring, then finished, then running, idle, unknown. */
export function AgentsWidget({ items, now }: AgentsWidgetProps) {
  const agents = sortAgents(items.map((item) => ({ item, data: agentData(item.data) })));
  const attention = items.filter((item) => item.attention).length;
  const running = items.filter((item) => item.status === "running").length;
  return (
    <Widget
      name="agents"
      title="Agents"
      count={attention > 0 ? `${attention} of ${agents.length} need you` : `${running} of ${agents.length} running`}
      empty={agents.length === 0 ? "No agents running." : null}
    >
      <ul class="rows">
        {agents.map((agent) => (
          <AgentRow key={`${agent.item.source}/${agent.item.id}`} agent={agent} now={now} />
        ))}
      </ul>
    </Widget>
  );
}

function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort(
    (a, b) =>
      statusOf(a.item.status).rank - statusOf(b.item.status).rank ||
      (a.data.where ?? "").localeCompare(b.data.where ?? "") ||
      a.data.terminalId.localeCompare(b.data.terminalId, undefined, { numeric: true }),
  );
}

function AgentRow({ agent: { item, data }, now }: { agent: Agent; now: string }) {
  const id = `agent-${item.source}-${item.id}`;
  const stale = !item.sourceOk;
  return (
    <li class="row agent" data-status={item.status} data-stale={stale} aria-labelledby={id}>
      <div class="row-line">
        <h3 id={id} class="agent-title">
          {item.title}
        </h3>
        <span class="state">{data.statusLabel ?? statusOf(item.status).text}</span>
      </div>
      <p class="meta agent-meta">
        {data.where && <span class="agent-workspace">{data.where}</span>}
        {data.agentKind && <span class="agent-kind">{data.agentKind}</span>}
        {data.activity && <span class="agent-activity">{data.activity}</span>}
        <Ago at={item.updatedAt} now={now} />
        {stale && <span class="agent-stale">last known</span>}
      </p>
    </li>
  );
}

/** Narrows the wire's `data`; a field the hub left out reads as absent rather than breaking the row. */
function agentData(data: unknown): AgentData {
  const record = fields(data);
  const text = (key: string) => {
    const value = record[key];
    return typeof value === "string" ? value : null;
  };
  return {
    terminalId: text("terminalId") ?? "",
    where: text("where"),
    agentKind: text("agentKind"),
    activity: text("activity"),
    statusLabel: text("statusLabel"),
  };
}
