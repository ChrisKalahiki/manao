import { fields, type StoredItem } from "../hub.js";
import { LastKnown, Widget } from "./widget.js";

/** The fields of a Brain-Dump Todo's `data` the outline reads. */
interface TodoData {
  /** The Todo Groups it sits in, outermost first; empty at the top of the to-do section. */
  groupPath: string[];
  /** Its line in the Weekly Note. */
  line: number;
  /** The Todo it is a subtodo of. */
  parentId: string | null;
}

export interface TodosWidgetProps {
  /** The `todo` Items; with `agenda`, the Agenda's open ones. */
  todos: StoredItem[];
  /** The hub's clock. */
  now: string;
  /** Shows the Agenda's open Todos rather than the whole Weekly Note. */
  agenda?: boolean;
}

const STATUS_LABELS: Record<string, string> = { open: "Open", done: "Done", dropped: "Dropped" };

interface TodoNode {
  kind: "todo";
  item: StoredItem;
  subtodos: TodoNode[];
}

interface GroupNode {
  kind: "group";
  id: string;
  name: string;
  children: OutlineNode[];
}

type OutlineNode = TodoNode | GroupNode;

/** Reads the fields the outline needs, so a malformed Item still shows, at the top level. */
function todoData(item: StoredItem): TodoData {
  const data = fields(item.data);
  const groupPath =
    Array.isArray(data.groupPath) && data.groupPath.every((g) => typeof g === "string") ? data.groupPath : [];
  return {
    groupPath,
    line: typeof data.line === "number" ? data.line : Number.POSITIVE_INFINITY,
    parentId: typeof data.parentId === "string" ? data.parentId : null,
  };
}

/**
 * Rebuilds the Weekly Note's to-do section: Todos in line order, each under its Todo Groups or
 * its parent Todo, and each group placed where its first Todo appears.
 */
function outline(todos: StoredItem[]): OutlineNode[] {
  const root: OutlineNode[] = [];
  const groups = new Map<string, GroupNode>();
  const nodes = new Map<string, TodoNode>();
  const sorted = todos.map((item) => ({ item, ...todoData(item) })).sort((a, b) => a.line - b.line);

  const groupChildren = (path: string[]): OutlineNode[] => {
    let children = root;
    path.forEach((name, depth) => {
      const key = JSON.stringify(path.slice(0, depth + 1));
      let group = groups.get(key);
      if (!group) {
        group = { kind: "group", id: `todo-group-${groups.size}`, name, children: [] };
        groups.set(key, group);
        children.push(group);
      }
      children = group.children;
    });
    return children;
  };

  for (const { item, groupPath, parentId } of sorted) {
    const node: TodoNode = { kind: "todo", item, subtodos: [] };
    nodes.set(item.id, node);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.subtodos.push(node);
    else groupChildren(groupPath).push(node);
  }
  return root;
}

/**
 * This week's Todos, read like the Weekly Note: nested by Todo Group, subtodos under their parent.
 * With `agenda`, only the open ones the hub sent, so an open subtodo whose parent is ticked, and
 * so not on the Agenda, sits directly under its Todo Group.
 */
export function TodosWidget({ todos, now, agenda = false }: TodosWidgetProps) {
  const open = todos.filter((t) => t.status === "open").length;
  return (
    <Widget
      name={agenda ? "agenda-todos" : "todos"}
      title="Todos"
      count={`${open} open`}
      empty={todos.length === 0 ? (agenda ? "No open Todos." : "No Todos in this week’s Weekly Note.") : null}
    >
      <LastKnown items={todos} now={now} />
      <Outline nodes={outline(todos)} depth={0} />
    </Widget>
  );
}

function Outline({ nodes, depth }: { nodes: OutlineNode[]; depth: number }) {
  return (
    <ul class={depth === 0 ? "todo-outline" : "todo-nest"}>
      {nodes.map((node) =>
        node.kind === "group" ? (
          <Group key={node.id} group={node} depth={depth} />
        ) : (
          <Todo key={node.item.id} node={node} depth={depth} />
        ),
      )}
    </ul>
  );
}

function Group({ group, depth }: { group: GroupNode; depth: number }) {
  const Heading = depth === 0 ? "h3" : depth === 1 ? "h4" : depth === 2 ? "h5" : "h6";
  return (
    <li class="todo-group" aria-labelledby={group.id}>
      <Heading id={group.id} class="todo-group-name">
        {group.name}
      </Heading>
      <Outline nodes={group.children} depth={depth + 1} />
    </li>
  );
}

function Todo({ node, depth }: { node: TodoNode; depth: number }) {
  const { item } = node;
  const id = `todo-${item.id}`;
  return (
    <li class="todo" data-status={item.status} aria-labelledby={id}>
      <div class="todo-line">
        <span class="todo-mark" role="img" aria-label={STATUS_LABELS[item.status] ?? item.status} />
        <span id={id} class="todo-title">
          {item.status === "dropped" ? <s>{item.title}</s> : item.title}
        </span>
      </div>
      {node.subtodos.length > 0 && <Outline nodes={node.subtodos} depth={depth + 1} />}
    </li>
  );
}
