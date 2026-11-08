import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainDumpAdapter } from "../src/brain-dump/adapter.js";
import { fakeBrainDump } from "./brain-dump-helper.js";
import { MemorySink, waitFor } from "./helpers.js";

describe("Brain-Dump Adapter", () => {
  let dir: string;
  let fake: ReturnType<typeof fakeBrainDump>;
  let adapter: BrainDumpAdapter;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-brain-sink-"));
    fake = fakeBrainDump(dir);
    adapter = new BrainDumpAdapter({ command: fake.command, intervalMs: 50 });
  });
  afterEach(async () => {
    await adapter.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads Todos before a hanging vault command", async () => {
    writeFileSync(fake.vaultMode, "hang");
    adapter = new BrainDumpAdapter({ command: fake.command, timeoutMs: 500 });
    const starting = adapter.start(new MemorySink());
    await waitFor(() => fake.calls().length > 0);
    try {
      expect(fake.calls()[0]?.[0]).toBe("todos");
    } finally {
      await starting;
    }
  });

  it("does not resolve the vault after a failed Todo read", async () => {
    writeFileSync(fake.mode, "fail");
    await adapter.start(new MemorySink());
    expect(fake.callsOf("vault")).toHaveLength(0);
  });

  it("does not create a poll when stopped during startup", async () => {
    const poll = vi.spyOn(globalThis, "setInterval");
    const starting = adapter.start(new MemorySink());
    await adapter.stop();
    await starting;
    expect(poll).not.toHaveBeenCalled();
  });

  it("reports a store failure as its own Health error instead of rejecting the poll", async () => {
    const sink = new MemorySink();
    sink.replaceItems = () => {
      throw new Error("store unavailable");
    };
    await expect(adapter.start(sink)).resolves.toBeUndefined();
    expect(sink.health.at(-1)).toMatchObject({ ok: false, error: "could not store Todos: store unavailable" });
  });

  it.each(["normal", "fail"])("keeps polling when health reporting throws after %s reads", async (mode) => {
    writeFileSync(fake.mode, mode);
    const sink = new MemorySink();
    let reports = 0;
    sink.reportHealth = () => {
      reports++;
      throw new Error("health store unavailable");
    };
    await expect(adapter.start(sink)).resolves.toBeUndefined();
    await waitFor(() => reports >= 3);
    expect(sink.items).toHaveLength(mode === "normal" ? 2 : 0);
  });

  it("defaults Health recency to three poll intervals", async () => {
    const sink = new MemorySink();
    await adapter.start(sink);
    expect(sink.lastHealth?.staleAfterMs).toBe(150);
  });
});
