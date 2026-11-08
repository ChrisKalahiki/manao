import { describe, expect, it } from "vitest";
import { normalizeTodos, parseTodosOutput, type Todo, type TodosOutput } from "../src/brain-dump/normalize.js";

const at = "2026-10-20T12:00:00.000Z";
const todo: Todo = { text: "Ship", state: "open", groupPath: [], parentIndex: null, line: 3 };
const output: TodosOutput = {
  note: "Research/Weekly Meetings/10-19-26 Weekly Update.md",
  exists: true,
  hash: "abc",
  todos: [todo],
};

describe("Brain-Dump normalization", () => {
  it("hashes group path, text and occurrence, independent of state, line, note and unrelated Todos", () => {
    const first = normalizeTodos({ ...output, todos: [todo, todo] }, at, "brain-dump:todos");
    const reread = normalizeTodos(
      {
        ...output,
        note: "another.md",
        todos: [{ ...todo, text: "Unrelated" }, { ...todo, state: "done", line: 10 }, todo],
      },
      at,
      "brain-dump:todos",
    );
    expect(first).toHaveLength(2);
    expect(first[0]?.id).not.toBe(first[1]?.id);
    expect(first.map((item) => item.id)).toEqual(reread.slice(1).map((item) => item.id));
    expect(first[0]?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(
      normalizeTodos({ ...output, todos: [{ ...todo, groupPath: ["Work"] }] }, at, "brain-dump:todos")[0]?.id,
    ).not.toBe(first[0]?.id);
    expect(
      normalizeTodos({ ...output, todos: [{ ...todo, text: "Edited" }] }, at, "brain-dump:todos")[0]?.id,
    ).not.toBe(first[0]?.id);
  });

  it("links subtodos to their nearest parent Item", () => {
    const items = normalizeTodos(
      {
        ...output,
        todos: [todo, { ...todo, text: "Child", parentIndex: 0 }, { ...todo, text: "Grandchild", parentIndex: 1 }],
      },
      at,
      "brain-dump:todos",
    );
    expect(items.map((item) => item.data)).toMatchObject([
      { parentId: null },
      { parentId: items[0]?.id },
      { parentId: items[1]?.id },
    ]);
  });

  it("keeps note order, each Status and loose Todos without Attention", () => {
    const items = normalizeTodos(
      {
        ...output,
        todos: (["open", "done", "dropped"] satisfies Todo["state"][]).map((state, index) => ({
          ...todo,
          state,
          text: `Todo ${index}`,
          line: index + 3,
        })),
      },
      at,
      "brain-dump:todos",
    );
    expect(items.map((item) => [item.title, item.status, item.attention])).toEqual([
      ["Todo 0", "open", false],
      ["Todo 1", "done", false],
      ["Todo 2", "dropped", false],
    ]);
    expect(items[0]).toMatchObject({
      source: "brain-dump:todos",
      type: "todo",
      updatedAt: at,
      data: { note: output.note, groupPath: [], line: 3, parentId: null },
    });
  });
});

describe("Brain-Dump contract", () => {
  it.each([
    { ...output, exists: true, hash: null },
    { ...output, exists: false, hash: "abc", todos: [] },
  ])("rejects inconsistent existence and hash: %j", (raw) => {
    expect(() => parseTodosOutput(raw)).toThrow();
  });

  it("accepts a missing note with a null hash", () => {
    const missing = { ...output, exists: false, hash: null, todos: [] };
    expect(parseTodosOutput(missing)).toEqual(missing);
  });

  it("normalizes using the caller's source id", () => {
    expect(normalizeTodos(output, at, "brain-dump:other")[0]?.source).toBe("brain-dump:other");
  });
});
