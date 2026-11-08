import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CoalescedRefresh } from "../coalesced-refresh.js";
import { commandErrorMessage } from "../command-error.js";
import type { Health, HubEvent, ItemSink, SourceAdapter, StoredState } from "../core/types.js";
import { errorMessage } from "../error-message.js";
import { PAPER_ITEM_TYPE } from "../paper.js";
import { type PicksOutput, parsePicksOutput } from "./contract.js";
import { keptEvent, type PaperBotSeen, recordedKeeps, scanEvents, seenFromStored, unrecordedKeeps } from "./events.js";
import { scanHealth } from "./health.js";
import { normalizePicks, PAPER_BOT_SOURCE_ID, paperItemId } from "./normalize.js";

const run = promisify(execFile);
const STALE_AFTER_INTERVALS = 3;

export interface PaperBotAdapterOptions {
  /** Executable on PATH or an absolute path. Default `paper-bot`. */
  command?: string;
  /** Poll interval. Default 15 minutes. */
  intervalMs?: number;
  /** How long each Health report counts as recent. Default 3x `intervalMs`. */
  staleAfterMs?: number;
  /** Hub clock. */
  now?: () => Date;
  /** Maximum command duration. Default 10 seconds. */
  timeoutMs?: number;
}

export class PaperBotAdapter implements SourceAdapter {
  readonly id = PAPER_BOT_SOURCE_ID;
  private readonly command: string;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private sink: ItemSink | null = null;
  /** What the Events recorded so far were drawn from; it moves only once they are recorded. */
  private seen: PaperBotSeen = seenFromStored(undefined);

  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly refreshes = new CoalescedRefresh(
    () => this.refreshOnce(),
    () => this.stopped,
  );

  constructor(opts: PaperBotAdapterOptions = {}) {
    this.command = opts.command ?? "paper-bot";
    this.intervalMs = opts.intervalMs ?? 900_000;
    this.staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_INTERVALS * this.intervalMs;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** Carries on from `stored`'s Picks and latest Scan Events, so no Event is recorded twice. */
  async start(sink: ItemSink, stored?: StoredState): Promise<void> {
    this.stopped = false;
    this.sink = sink;
    this.seen = seenFromStored(stored);
    await this.refresh();
    if (!this.stopped) this.timer = setInterval(() => void this.refresh(), this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.refreshes.idle();
  }

  refresh(): Promise<void> {
    return this.refreshes.run();
  }

  private async refreshOnce(): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error("PaperBotAdapter.refresh() called before start()");
    const now = this.now();
    const at = now.toISOString();
    let output: PicksOutput;
    try {
      const { stdout } = await run(this.command, ["picks", "--json"], { timeout: this.timeoutMs });
      output = parsePicksOutput(JSON.parse(stdout));
    } catch (error) {
      const message = commandErrorMessage(error, { command: this.command, timeoutMs: this.timeoutMs, contract: "paper-bot picks" });
      await this.report(sink, { ok: false, at, error: message });
      return;
    }
    try {
      await this.write(sink, output, at);
    } catch (error) {
      await this.report(sink, { ok: false, at, error: errorMessage(error) });
      return;
    }
    await this.report(sink, { at, ...scanHealth(output, now) });
  }

  /**
   * Stores the Picks with the Keeps recorded so far, records the new Scan
   * Events, then each new Keep's Event and the Picks showing it, one Keep at
   * a time. So at most the newest Keep Event is ahead of the stored Picks,
   * and `seenFromStored` counts it: a refused write and a restart neither
   * lose nor repeat a Keep. `seen` moves only with what was written.
   */
  private async write(sink: ItemSink, output: PicksOutput, at: string): Promise<void> {
    const store = async (kept: ReadonlySet<string>) => {
      await refused("could not store Picks", () => sink.replaceItems(this.id, PAPER_ITEM_TYPE, normalizePicks(output, at, kept)));
      this.seen = { ...this.seen, kept };
    };
    const record = async (events: HubEvent[], seen: PaperBotSeen) => {
      if (events.length > 0) await refused("could not record Events", () => sink.emitEvents(events));
      this.seen = seen;
    };
    const recorded = recordedKeeps(this.seen, output);
    await store(recorded);
    const scans = scanEvents(this.seen, output, at);
    await record(scans.events, scans.seen);
    for (const pick of unrecordedKeeps(recorded, output)) {
      const kept = new Set([...(this.seen.kept ?? []), paperItemId(pick.id)]);
      await record([keptEvent(pick, at)], { ...this.seen, kept });
      await store(kept);
    }
  }

  private async report(sink: ItemSink, health: Omit<Health, "staleAfterMs">): Promise<void> {
    try {
      await sink.reportHealth(this.id, { ...health, staleAfterMs: this.staleAfterMs });
    } catch {
      // A broken sink must not kill the poll loop.
    }
  }
}

/** Runs a sink write, naming what was refused in the error. */
async function refused(what: string, write: () => void | Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    throw new Error(`${what}: ${errorMessage(error)}`);
  }
}
