import { CoalescedRefresh } from "../coalesced-refresh.js";
import type { Health, ItemSink, SourceAdapter } from "../core/types.js";
import { errorMessage } from "../error-message.js";
import { HerdrClient, type SocketOptions } from "./client.js";
import { EventNudger } from "./nudger.js";
import { AGENT_ITEM_TYPE, type AgentItem, reconcile, sortForDashboard, transitionToEvent } from "./normalize.js";

/** The one herdr-core this hub reads: the core on its own machine. */
export const HERDR_SOURCE_ID = "herdr:local";

/** A report older than this many poll intervals means the hub stopped polling. */
const STALE_AFTER_INTERVALS = 3;

export interface HerdrAdapterOptions {
  client?: HerdrClient;
  socket?: SocketOptions;
  /** Safety-net poll interval. Events make updates faster; polling makes them certain. */
  intervalMs?: number;
  /** How long each Health report counts as recent. Default 3x `intervalMs`. */
  staleAfterMs?: number;
  /** Subscribe to herdr-core events as refresh nudges. Default true. */
  events?: boolean;
  /** Reconnect backoff for the event channel (tests use a small value). */
  eventBackoffMs?: number;
  /** Emit "appeared" transitions for agents already running at startup. Default false. */
  emitInitial?: boolean;
  now?: () => Date;
}

export class HerdrAdapter implements SourceAdapter {
  readonly id = HERDR_SOURCE_ID;
  private readonly client: HerdrClient;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly useEvents: boolean;
  private readonly eventBackoffMs?: number;
  private readonly emitInitial: boolean;
  private readonly now: () => Date;

  private sink: ItemSink | null = null;
  private timer: NodeJS.Timeout | null = null;
  private nudger: EventNudger | null = null;
  private readonly refreshes = new CoalescedRefresh(() => this.refreshOnce());
  private primed = false;
  private prev = new Map<string, AgentItem>();

  constructor(opts: HerdrAdapterOptions = {}) {
    this.client = opts.client ?? new HerdrClient(opts.socket);
    this.intervalMs = opts.intervalMs ?? 5000;
    this.staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_INTERVALS * this.intervalMs;
    this.useEvents = opts.events ?? true;
    this.eventBackoffMs = opts.eventBackoffMs;
    this.emitInitial = opts.emitInitial ?? false;
    this.now = opts.now ?? (() => new Date());
  }

  async start(sink: ItemSink): Promise<void> {
    this.sink = sink;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    if (this.useEvents) {
      this.nudger = new EventNudger({
        socketPath: this.client.socketPath,
        onNudge: () => void this.refresh(),
        backoffMs: this.eventBackoffMs,
      });
      this.nudger.start();
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nudger?.stop();
    this.nudger = null;
    await this.refreshes.idle();
  }

  /** Concurrent callers coalesce: at most one extra pass runs after the current one. */
  refresh(): Promise<void> {
    return this.refreshes.run();
  }

  private async refreshOnce(): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error("HerdrAdapter.refresh() called before start()");
    const at = this.now().toISOString();

    try {
      const terminals = await this.client.list();
      const { items, transitions } = reconcile(this.prev, terminals, at, this.id);
      const first = !this.primed;

      await sink.replaceItems(this.id, AGENT_ITEM_TYPE, sortForDashboard(items));
      if (transitions.length > 0 && (!first || this.emitInitial)) {
        await sink.emitEvents(transitions.map((t) => transitionToEvent(t, this.id, at)));
      }
      this.primed = true;
      this.prev = new Map(items.map((i) => [i.id, i]));
      await this.report(sink, { ok: true, at });
    } catch (err) {
      // Never wipe items on failure: stale-but-visible beats silently empty.
      await this.report(sink, { ok: false, at, error: errorMessage(err) });
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
