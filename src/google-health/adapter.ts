import { CoalescedRefresh } from "../coalesced-refresh.js";
import type { Health, ItemSink, SourceAdapter, StoredState } from "../core/types.js";
import { errorMessage } from "../error-message.js";
import { GoogleConnection, type GoogleEndpoints, GoogleError } from "../google/oauth.js";
import { addDays, localDate } from "../local-time.js";
import type { Measurement } from "../measurement.js";
import { type DayRange, readMeasurements } from "./api.js";

const STALE_AFTER_INTERVALS = 3;

export interface GoogleHealthAdapterOptions {
  /** The OAuth client JSON from Cloud Console. */
  clientFile: string;
  /** Written by `manao auth google`; read on every refresh. */
  tokenFile: string;
  /** Refresh interval. Default 1 hour. */
  intervalMs?: number;
  /** How many days before Today a refresh reaches back at most. Default 30. */
  backfillDays?: number;
  /** How long each Health report counts as recent. Default 3x `intervalMs`. */
  staleAfterMs?: number;
  /** Hub clock, also used for Today in the system time zone. */
  now?: () => Date;
  /** Per Google request. Default 10 seconds. */
  timeoutMs?: number;
  endpoints?: GoogleEndpoints;
}

/**
 * Daily Measurements from the Google Health API. Each refresh reads from the
 * earlier of yesterday and the day after the latest stored Measurement through
 * Today, at most `backfillDays` back: the backfill on the first run, two days
 * normally, and a catch-up after downtime.
 */
export class GoogleHealthAdapter implements SourceAdapter {
  /** One Adapter per Google account; there is one account so far. */
  readonly id = "google-health:primary";
  private readonly google: GoogleConnection;
  private readonly intervalMs: number;
  private readonly backfillDays: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private sink: ItemSink | null = null;
  /** The date of the latest Measurement stored, which the next window reads on from. */
  private latestDate: string | null = null;

  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly refreshes = new CoalescedRefresh(
    () => this.refreshOnce(),
    () => this.stopped,
  );

  constructor(opts: GoogleHealthAdapterOptions) {
    this.now = opts.now ?? (() => new Date());
    this.google = new GoogleConnection({
      clientFile: opts.clientFile,
      tokenFile: opts.tokenFile,
      endpoints: opts.endpoints,
      timeoutMs: opts.timeoutMs,
      now: this.now,
    });
    this.intervalMs = opts.intervalMs ?? 3_600_000;
    this.backfillDays = opts.backfillDays ?? 30;
    this.staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_INTERVALS * this.intervalMs;
  }

  async start(sink: ItemSink, stored?: StoredState): Promise<void> {
    this.stopped = false;
    this.sink = sink;
    this.latestDate = stored?.latestMeasurementDate ?? null;
    await this.refresh();
    if (this.stopped) return;
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
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

  private window(today: string): DayRange {
    const yesterday = addDays(today, -1);
    const earliest = addDays(today, -this.backfillDays);
    const next = this.latestDate === null ? earliest : addDays(this.latestDate, 1);
    // Local dates as YYYY-MM-DD compare as text.
    const from = next < yesterday ? next : yesterday;
    return { from: from > earliest ? from : earliest, to: today };
  }

  /** All or nothing: writes only when every Metric was read. */
  private async refreshOnce(): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error("GoogleHealthAdapter.refresh() called before start()");
    const now = this.now();
    const at = now.toISOString();
    let measurements: Measurement[];
    try {
      measurements = await readMeasurements(this.google, this.window(localDate(now)));
    } catch (error) {
      await this.report(sink, { ok: false, at, error: readErrorMessage(error) });
      return;
    }
    try {
      await sink.writeMeasurements(this.id, measurements);
    } catch (error) {
      await this.report(sink, { ok: false, at, error: `could not store Measurements: ${errorMessage(error)}` });
      return;
    }
    for (const { date } of measurements) {
      if (this.latestDate === null || date > this.latestDate) this.latestDate = date;
    }
    await this.report(sink, { ok: true, at });
  }

  private async report(sink: ItemSink, health: Omit<Health, "staleAfterMs">): Promise<void> {
    try {
      await sink.reportHealth(this.id, { ...health, staleAfterMs: this.staleAfterMs });
    } catch {
      // A broken sink must not kill the poll loop.
    }
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof GoogleError ? error.message : `unexpected failure: ${errorMessage(error)}`;
}
