import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoalescedRefresh } from "../coalesced-refresh.js";
import { commandErrorMessage } from "../command-error.js";
import type { Health, ItemSink, SourceAdapter } from "../core/types.js";
import { errorMessage } from "../error-message.js";
import { localDate } from "../local-time.js";
import { TODO_ITEM_TYPE } from "../todo.js";
import { watchUnavailable, weeklyNoteFolder } from "./command.js";
import { normalizeTodos, parseTodosOutput, type TodosOutput } from "./normalize.js";
import { FolderNudger } from "./nudger.js";

const run = promisify(execFile);
const STALE_AFTER_INTERVALS = 3;

export interface BrainDumpAdapterOptions {
  /** Executable on PATH or an absolute path. Default `brain-dump`. */
  command?: string;
  /** Poll interval. Default 60 seconds. */
  intervalMs?: number;
  /** Quiet time after a folder change. Default 2 seconds. */
  debounceMs?: number;
  /** How long each Health report counts as recent. Default 3x `intervalMs`. */
  staleAfterMs?: number;
  /** Hub clock, also used for Today in the system time zone. */
  now?: () => Date;
  /** Maximum command duration. Default 10 seconds. */
  timeoutMs?: number;
}

export class BrainDumpAdapter implements SourceAdapter {
  readonly id = "brain-dump:todos";
  private readonly command: string;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly debounceMs: number;
  private vaultRoot: string | null = null;
  private nudger: FolderNudger | null = null;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private sink: ItemSink | null = null;

  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly refreshes = new CoalescedRefresh(
    () => this.refreshOnce(),
    () => this.stopped,
  );

  constructor(opts: BrainDumpAdapterOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.command = opts.command ?? "brain-dump";
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_INTERVALS * this.intervalMs;
    this.now = opts.now ?? (() => new Date());
  }

  async start(sink: ItemSink): Promise<void> {
    this.stopped = false;
    this.sink = sink;
    this.nudger = new FolderNudger({ debounceMs: this.debounceMs, onNudge: () => void this.refresh() });
    await this.refresh();
    if (!this.stopped) this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nudger?.stop();
    await this.refreshes.idle();
  }

  refresh(): Promise<void> {
    return this.refreshes.run();
  }

  private async refreshOnce(): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error("BrainDumpAdapter.refresh() called before start()");
    const date = this.now();
    const at = date.toISOString();
    let output: TodosOutput;
    try {
      const { stdout } = await run(this.command, ["todos", "--date", localDate(date)], { timeout: this.timeoutMs });
      output = parseTodosOutput(JSON.parse(stdout));
    } catch (error) {
      await this.report(sink, {
        ok: false,
        at,
        error: this.readError(error),
      });
      return;
    }
    const note = await this.resolveVaultRoot();
    if (this.vaultRoot) this.nudger?.watch(weeklyNoteFolder(this.vaultRoot, output.note));
    try {
      await sink.replaceItems(this.id, TODO_ITEM_TYPE, normalizeTodos(output, at, this.id));
    } catch (error) {
      await this.report(sink, {
        ok: false,
        at,
        note,
        error: `could not store Todos: ${errorMessage(error)}`,
      });
      return;
    }
    await this.report(sink, { ok: true, at, note });
  }

  private async resolveVaultRoot(): Promise<string | undefined> {
    if (!this.vaultRoot) {
      try {
        const { stdout } = await run(this.command, ["vault"], { timeout: this.timeoutMs });
        const root = stdout.trim();
        if (!root) throw new Error("empty vault root");
        this.vaultRoot = root;
      } catch (error) {
        return watchUnavailable(`vault: ${this.readError(error)}`);
      }
    }
    return undefined;
  }

  private readError(error: unknown): string {
    return commandErrorMessage(error, { command: this.command, timeoutMs: this.timeoutMs, contract: "brain-dump todos" });
  }

  private async report(sink: ItemSink, health: Omit<Health, "staleAfterMs">): Promise<void> {
    try {
      await sink.reportHealth(this.id, { ...health, note: this.nudger?.problem ?? health.note, staleAfterMs: this.staleAfterMs });
    } catch {
      // A broken sink must not kill the poll loop.
    }
  }
}
