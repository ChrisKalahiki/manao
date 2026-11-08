import { createHash } from "node:crypto";
import { z } from "zod";
import type { HubItem } from "../core/types.js";
import { TODO_ITEM_TYPE, type TodoData } from "../todo.js";

export type TodosOutput = z.infer<typeof outputSchema>;
export type Todo = z.infer<typeof todoSchema>;

export function normalizeTodos(output: TodosOutput, at: string, sourceId: string): HubItem<TodoData>[] {
  if (!output.exists) return [];
  const occurrences = new Map<string, number>();
  const ids = output.todos.map((todo) => {
    const key = JSON.stringify([todo.groupPath, todo.text]);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return createHash("sha256")
      .update(JSON.stringify([todo.groupPath, todo.text, occurrence]))
      .digest("hex");
  });
  return output.todos.map((todo, index) => ({
    source: sourceId,
    type: TODO_ITEM_TYPE,
    id: ids[index],
    title: todo.text,
    status: todo.state,
    attention: false,
    updatedAt: at,
    data: {
      note: output.note,
      groupPath: todo.groupPath,
      line: todo.line,
      parentId: todo.parentIndex === null ? null : ids[todo.parentIndex],
    },
  }));
}

const todoSchema = z.object({
  text: z.string(),
  state: z.enum(["open", "done", "dropped"]),
  groupPath: z.array(z.string()),
  parentIndex: z.number().int().nonnegative().nullable(),
  line: z.number().int().positive(),
});

const outputSchema = z
  .object({
    note: z.string(),
    exists: z.boolean(),
    hash: z.string().nullable(),
    todos: z.array(todoSchema),
  })
  .refine((output) => output.exists === (output.hash !== null), {
    path: ["hash"],
    message: "hash must be null exactly when exists is false",
  })
  .refine((output) => output.todos.every((todo, index) => todo.parentIndex === null || todo.parentIndex < index), {
    message: "parentIndex must refer to an earlier Todo",
  });

export function parseTodosOutput(raw: unknown): TodosOutput {
  return outputSchema.parse(raw);
}
