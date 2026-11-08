import { EventEmitter } from "node:events";
import { type FSWatcher, type WatchListener, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderNudger } from "../src/brain-dump/nudger.js";

class ControlledWatcher extends EventEmitter implements FSWatcher {
  close = vi.fn();
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

describe("Brain-Dump folder nudger", () => {
  let folder: string;
  let nudger: FolderNudger;
  let watchers: ControlledWatcher[];
  let onNudge: ReturnType<typeof vi.fn>;
  let fail: unknown;
  const watchFolder = (_folder: string, _options: { recursive: false }, listener: WatchListener<string>) => {
    if (fail !== undefined) throw fail;
    const watcher = new ControlledWatcher();
    watcher.on("change", listener);
    watchers.push(watcher);
    return watcher;
  };
  beforeEach(() => {
    folder = mkdtempSync(path.join(os.tmpdir(), "manao-folder-"));
    watchers = [];
    onNudge = vi.fn();
    fail = undefined;
    nudger = new FolderNudger({ watch: watchFolder, onNudge });
    vi.useFakeTimers();
  });
  afterEach(() => {
    nudger.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(folder, { recursive: true, force: true });
  });

  it("keeps the same watch and nudges once two seconds after the final event", async () => {
    nudger.watch(folder);
    nudger.watch(folder);
    expect(watchers).toHaveLength(1);
    watchers[0]!.emit("change", "rename", "note.md");
    await vi.advanceTimersByTimeAsync(1999);
    watchers[0]!.emit("change", "change", "note.md");
    await vi.advanceTimersByTimeAsync(1999);
    expect(onNudge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onNudge).toHaveBeenCalledOnce();
    expect(nudger.problem).toBeUndefined();
  });

  it("moves the watch and cancels pending nudges from the old folder", async () => {
    const next = path.join(folder, "next");
    mkdirSync(next);
    nudger.watch(folder);
    const old = watchers[0]!;
    old.emit("change", "change", "note.md");
    nudger.watch(next);
    expect(old.close).toHaveBeenCalledOnce();
    old.emit("change", "change", "late.md");
    old.emit("error", new Error("late error"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(onNudge).not.toHaveBeenCalled();
    expect(nudger.problem).toBeUndefined();
    watchers[1]!.emit("change", "change", "note.md");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onNudge).toHaveBeenCalledOnce();
  });

  it("closes the watcher and cancels debounce on stop, ignoring later events and watches", async () => {
    nudger.watch(folder);
    watchers[0]!.emit("change", "change", "note.md");
    nudger.stop();
    expect(watchers[0]!.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    watchers[0]!.emit("change", "change", "late.md");
    watchers[0]!.emit("error", new Error("late error"));
    nudger.watch(folder);
    await vi.advanceTimersByTimeAsync(2000);
    expect(watchers).toHaveLength(1);
    expect(onNudge).not.toHaveBeenCalled();
  });

  it("reports attachment failures and clears the problem on the first successful retry", () => {
    fail = "watch unavailable";
    nudger.watch(folder);
    expect(nudger.problem).toContain(folder);
    expect(nudger.problem).toContain("watch unavailable");
    fail = undefined;
    nudger.watch(folder);
    expect(watchers).toHaveLength(1);
    expect(nudger.problem).toBeUndefined();
  });

  it("clears an asynchronous watcher error as soon as reattaching succeeds", () => {
    nudger.watch(folder);
    watchers[0]!.emit("error", new Error("watch resource unavailable"));
    expect(watchers[0]!.close).toHaveBeenCalledOnce();
    expect(nudger.problem).toContain("watch resource unavailable");
    fail = new Error("still unavailable");
    nudger.watch(folder);
    expect(nudger.problem).toContain("still unavailable");
    fail = undefined;
    nudger.watch(folder);
    expect(nudger.problem).toBeUndefined();
  });

  it.each(["rename", "change"])("drops a vanished folder on a %s event and retries the watch", async (event) => {
    nudger.watch(folder);
    rmSync(folder, { recursive: true });
    watchers[0]!.emit("change", event, "note.md");
    expect(watchers[0]!.close).toHaveBeenCalledOnce();
    expect(nudger.problem).toContain(folder);
    await vi.advanceTimersByTimeAsync(2000);
    expect(onNudge).toHaveBeenCalledOnce();
    mkdirSync(folder);
    nudger.watch(folder);
    expect(watchers).toHaveLength(2);
    expect(nudger.problem).toBeUndefined();
  });

  it("drops a watch when rename names the folder itself even if its path already exists again", () => {
    nudger.watch(folder);
    watchers[0]!.emit("change", "rename", path.basename(folder));
    expect(watchers[0]!.close).toHaveBeenCalledOnce();
    expect(nudger.problem).toContain(folder);
    nudger.watch(folder);
    expect(watchers).toHaveLength(2);
    expect(nudger.problem).toBeUndefined();
  });
});
