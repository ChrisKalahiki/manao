import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainDumpAdapter } from "../src/brain-dump/adapter.js";
import type { SourceAdapter } from "../src/core/types.js";
import { type CommandSourceConfig, createAdapters, parseConfig } from "../src/hub/config.js";
import { type Hub, startHub } from "../src/hub/hub.js";
import { waitFor } from "./helpers.js";
import { fakeBrainDump, todosFixture } from "./brain-dump-helper.js";

const T0 = "2026-10-20T12:00:00.000Z";

describe("Brain-Dump hub seam", () => {
  let dir: string;
  let fake: ReturnType<typeof fakeBrainDump>;
  let hub: Hub | undefined;
  let clock: Date;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-brain-"));
    fake = fakeBrainDump(dir);
    clock = new Date(T0);
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const startAdapter = async (adapter: SourceAdapter, api: false | { port: number } = false) => {
    hub = await startHub({
      dbPath: path.join(dir, "hub.db"),
      adapters: [adapter],
      now: () => clock,
      eventRetentionDays: 30,
      api,
      log: () => {},
    });
    return adapter;
  };
  const start = async (options: Partial<CommandSourceConfig> = {}, api: false | { port: number } = false) => {
    const config = parseConfig({ sources: { brainDump: { command: fake.command, ...options } }, api: false });
    return startAdapter(createAdapters(config, () => clock)[0]!, api);
  };

  const todoCalls = () => fake.callsOf("todos").length;
  const writeInNoteFolder = (name = "sync.md") => {
    writeFileSync(path.join(fake.vaultRoot, path.dirname(todosFixture.note), name), "sync landed");
  };

  const expectNoMoreReads = async (count: number, durationMs = 180) => {
    const until = Date.now() + durationMs;
    await waitFor(() => {
      expect(todoCalls()).toBe(count);
      return Date.now() >= until;
    });
  };

  it("re-reads Todos after a change in the vault-relative Weekly Note folder before the poll", async () => {
    await startAdapter(new BrainDumpAdapter({ command: fake.command, debounceMs: 30, now: () => clock }));
    expect(fake.callsOf("vault")).toHaveLength(1);
    writeFileSync(fake.fixture, JSON.stringify({ ...todosFixture, todos: [{ ...todosFixture.todos[0], state: "done" }] }));
    writeInNoteFolder();
    await waitFor(() => hub!.store.items.list({ status: "done" }).length === 1);
    expect(todoCalls()).toBe(2);
    expect(fake.callsOf("vault")).toHaveLength(1);
  });


  it("debounces a burst of folder writes into one read", async () => {
    // macOS delivers fs.watch events in batches about 50ms apart, which can split one burst (and replay
    // writes made just before the watch began); under load the gap stretches. The window has to outlast
    // that, and the check has to outlast the window, or a late batch's read lands after it.
    const debounceMs = 300;
    await startAdapter(new BrainDumpAdapter({ command: fake.command, debounceMs }));
    for (let i = 0; i < 20; i++) writeInNoteFolder(`sync-${i}.md`);
    await waitFor(() => todoCalls() === 2);
    await expectNoMoreReads(2, 2 * debounceMs);
  });

  it("moves the watch when the note changes folders", async () => {
    const adapter = await startAdapter(new BrainDumpAdapter({ command: fake.command, debounceMs: 30 }));
    const newFolder = path.join(fake.vaultRoot, "Next week");
    mkdirSync(newFolder);
    writeFileSync(fake.fixture, JSON.stringify({ ...todosFixture, note: "Next week/note.md" }));
    await adapter.refresh();
    writeInNoteFolder();
    await expectNoMoreReads(2);
    writeFileSync(path.join(newFolder, "sync.md"), "sync landed");
    await waitFor(() => todoCalls() === 3);
  });

  it("keeps polling when vault is unavailable and clears the note on the first recovery read", async () => {
    writeFileSync(fake.vaultMode, "fail");
    const adapter = await startAdapter(new BrainDumpAdapter({ command: fake.command, debounceMs: 30 }));
    expect(hub!.store.health.list()[0]).toMatchObject({ ok: true, note: expect.stringContaining("fixture vault unavailable") });
    await adapter.refresh();
    expect(todoCalls()).toBe(2);
    writeFileSync(fake.vaultMode, "normal");
    await adapter.refresh();
    expect(hub!.store.health.list()[0]?.note).toBeUndefined();
    expect(hub!.store.health.list()[0]?.healthy).toBe(true);
    expect(fake.callsOf("vault")).toHaveLength(3);
    await adapter.refresh();
    expect(fake.callsOf("vault")).toHaveLength(3);
  });

  it("keeps polling when the folder is missing and attaches on recovery", async () => {
    rmSync(path.join(fake.vaultRoot, "Research"), { recursive: true });
    await startAdapter(new BrainDumpAdapter({ command: fake.command, intervalMs: 100, debounceMs: 30 }));
    expect(hub!.store.health.list()[0]).toMatchObject({ ok: true, note: expect.stringContaining("ENOENT") });
    await waitFor(() => todoCalls() >= 2);
    mkdirSync(path.join(fake.vaultRoot, path.dirname(todosFixture.note)), { recursive: true });
    await waitFor(() => hub!.store.health.list()[0]?.note === undefined);
    expect(hub!.store.health.list()[0]?.healthy).toBe(true);
    expect(fake.callsOf("vault")).toHaveLength(1);
  });

  it("drops a deleted folder watch and re-arms it after recreation", async () => {
    const adapter = await startAdapter(new BrainDumpAdapter({ command: fake.command, debounceMs: 30 }));
    const folder = path.join(fake.vaultRoot, path.dirname(todosFixture.note));
    rmSync(folder, { recursive: true });
    await waitFor(() => hub!.store.health.list()[0]?.note?.includes(folder) === true);
    expect(hub!.store.health.list()[0]).toMatchObject({ healthy: true, note: expect.stringContaining("folder watch unavailable") });
    mkdirSync(folder);
    await adapter.refresh();
    expect(hub!.store.health.list()[0]?.note).toBeUndefined();
    writeFileSync(fake.fixture, JSON.stringify({ ...todosFixture, todos: [{ ...todosFixture.todos[0], state: "done" }] }));
    writeInNoteFolder();
    await waitFor(() => hub!.store.items.list({ status: "done" }).length === 1);
  });

  it("keeps a missing note Healthy when its folder is missing, then watches the created folder", async () => {
    const folder = path.join(fake.vaultRoot, "Future week");
    writeFileSync(fake.fixture, JSON.stringify({ note: "Future week/note.md", exists: false, hash: null, todos: [] }));
    const adapter = await startAdapter(new BrainDumpAdapter({ command: fake.command, debounceMs: 30 }));
    expect(hub!.store.items.list({ type: "todo" })).toEqual([]);
    expect(hub!.store.health.list()[0]).toMatchObject({ healthy: true, note: expect.stringContaining(folder) });
    mkdirSync(folder);
    await adapter.refresh();
    expect(hub!.store.health.list()[0]?.note).toBeUndefined();
    writeFileSync(fake.fixture, JSON.stringify({ ...todosFixture, note: "Future week/note.md" }));
    writeFileSync(path.join(folder, "note.md"), "sync landed");
    await waitFor(() => hub!.store.items.list({ type: "todo" }).length === 2);
  });

  it("stops polling, watching and a pending debounce before closing the store", async () => {
    await startAdapter(new BrainDumpAdapter({ command: fake.command, intervalMs: 100, debounceMs: 80 }));
    writeInNoteFolder();
    await hub!.stop();
    hub = undefined;
    const count = todoCalls();
    writeInNoteFolder("after-stop.md");
    await expectNoMoreReads(count, 250);
  });

  it("polls on the configured cadence, keeps unchanged ids and updatedAt, and follows Today", async () => {
    await start({ intervalSeconds: 0.05, staleAfterSeconds: 5 });
    const first = hub!.store.items.list({ type: "todo" });
    clock = new Date(2026, 9, 21, 0, 5);
    await waitFor(() => hub!.store.health.list()[0]?.at === clock.toISOString());
    const unchanged = hub!.store.items.list({ type: "todo" });
    expect(unchanged.map((item) => [item.id, item.updatedAt])).toEqual(first.map((item) => [item.id, item.updatedAt]));
    expect(hub!.store.health.list()[0]?.staleAfterMs).toBe(5000);
    expect(fake.calls().at(-1)).toEqual(["todos", "--date", "2026-10-21"]);
    writeFileSync(
      fake.fixture,
      JSON.stringify({
        ...todosFixture,
        todos: todosFixture.todos.map((todo, i) => ({
          ...todo,
          state: i === 0 ? "done" : "dropped",
        })),
      }),
    );
    await waitFor(() => hub!.store.items.list({ status: "done" }).length === 1);
    expect(
      hub!.store.items
        .list({ type: "todo" })
        .map((item) => item.status)
        .sort(),
    ).toEqual(["done", "dropped"]);
    expect(
      hub!.store.items
        .list({ type: "todo" })
        .map((item) => item.id)
        .sort(),
    ).toEqual(first.map((item) => item.id).sort());
  });

  it.each([
    ["fail", "exited with code 7: fixture command failed"],
    ["garbage", "unparseable output (not JSON)"],
  ])("keeps Todos Stale on %s and recovers on the next good read", async (mode, message) => {
    const adapter = await start();
    const first = hub!.store.items.list({ type: "todo" });
    writeFileSync(fake.mode, mode);
    clock = new Date("2026-10-20T12:03:01.000Z");
    await adapter.refresh();
    expect(hub!.store.items.list({ type: "todo" }).map((item) => [item.id, item.sourceOk, item.lastOkAt])).toEqual(
      first.map((item) => [item.id, false, T0]),
    );
    expect(hub!.store.health.list()[0]).toMatchObject({ ok: false, error: expect.stringContaining(message) });
    writeFileSync(fake.mode, "normal");
    await adapter.refresh();
    expect(hub!.store.health.list()[0]).toMatchObject({ ok: true, lastOkAt: clock.toISOString() });
    expect(hub!.store.health.list()[0]?.error).toBeUndefined();
    expect(hub!.store.items.list({ type: "todo" }).every((item) => item.sourceOk)).toBe(true);
  });

  it.each([
    { ...todosFixture, todos: [{ ...todosFixture.todos[0], state: "unknown" }] },
    { ...todosFixture, todos: [{ ...todosFixture.todos[0], parentIndex: 0 }] },
    { ...todosFixture, todos: [{ ...todosFixture.todos[0], groupPath: "Work" }] },
    { ...todosFixture, todos: [{ ...todosFixture.todos[0], line: 0 }] },
    { ...todosFixture, note: null },
    { ...todosFixture, exists: "yes" },
    { ...todosFixture, hash: null },
    { ...todosFixture, exists: false, todos: [] },
  ])("rejects output outside the JSON contract: %j", async (output) => {
    const adapter = await start();
    writeFileSync(fake.fixture, JSON.stringify(output));
    await adapter.refresh();
    expect(hub!.store.health.list()[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining("output does not match the brain-dump todos contract:"),
    });
    expect(hub!.store.items.list({ type: "todo" })).toHaveLength(2);
    expect(hub!.store.items.list({ type: "todo" }).every((item) => !item.sourceOk)).toBe(true);
  });

  it("treats a missing Weekly Note as a successful empty read", async () => {
    const adapter = await start();
    writeFileSync(fake.fixture, JSON.stringify({ note: todosFixture.note, exists: false, hash: null, todos: [] }));
    await adapter.refresh();
    expect(hub!.store.items.list({ type: "todo" })).toEqual([]);
    expect(hub!.store.health.list()[0]?.healthy).toBe(true);
  });

  it("bounds a hung command and leaves its Items Stale", async () => {
    const adapter = new BrainDumpAdapter({ command: fake.command, timeoutMs: 500, now: () => clock });
    await startAdapter(adapter);
    writeFileSync(fake.mode, "hang");
    await adapter.refresh();
    expect(hub!.store.items.list({ type: "todo" })).toHaveLength(2);
    expect(hub!.store.items.list({ type: "todo" }).every((item) => !item.sourceOk)).toBe(true);
    expect(hub!.store.health.list()[0]).toMatchObject({ ok: false, error: "timed out after 500ms" });
  });

  it("reports a missing command without failing startup", async () => {
    rmSync(fake.command);
    await start();
    expect(hub!.store.health.list()[0]).toMatchObject({ ok: false, error: `command not found: ${fake.command}` });
  });

  it("coalesces concurrent refreshes", async () => {
    const adapter = await start({ intervalSeconds: 60 });
    const callsBefore = fake.calls().length;
    await Promise.all([adapter.refresh(), adapter.refresh(), adapter.refresh()]);
    expect(fake.calls()).toHaveLength(callsBefore + 2);
  });

  it("stops polling before closing the store", async () => {
    await start({ intervalSeconds: 0.05 });
    await waitFor(() => todoCalls() >= 2);
    await hub!.stop();
    hub = undefined;
    await expectNoMoreReads(todoCalls());
  });

  it("serves Todos through the existing API with sourceOk and lastOkAt", async () => {
    await start({}, { port: 0 });
    const response = await fetch(`${hub!.apiUrl}/api/items?type=todo`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      now: T0,
      items: [
        { type: "todo", source: "brain-dump:todos", sourceOk: true, lastOkAt: T0 },
        { type: "todo", source: "brain-dump:todos", sourceOk: true, lastOkAt: T0 },
      ],
    });
  });

  it("stores Todos with Status, group path, parent and line", async () => {
    await start();
    const items = hub!.store.items.list({ type: "todo" });
    expect(items).toHaveLength(2);
    const parent = items.find((item) => item.title === "Ship")!;
    expect(parent).toMatchObject({
      source: "brain-dump:todos",
      status: "open",
      attention: false,
      sourceOk: true,
      lastOkAt: T0,
      data: { note: todosFixture.note, groupPath: ["Work", "Manaʻo"], line: 4, parentId: null },
    });
    expect(items.find((item) => item.title === "Review")?.data).toMatchObject({ line: 5, parentId: parent.id });
    expect(hub!.store.events.after(0)).toEqual([]);
  });
});
