import { APPOINTMENT_ITEM_TYPE, appointmentAttention, appointmentStatus } from "../appointment.js";
import { CoalescedRefresh } from "../coalesced-refresh.js";
import type { Health, ItemSink, SourceAdapter, StoredState } from "../core/types.js";
import { errorMessage } from "../error-message.js";
import { GoogleConnection, type GoogleEndpoints, GoogleError } from "../google/oauth.js";
import { startOfLocalDay } from "../local-time.js";
import { readCalendars } from "./api.js";
import { type AppointmentItem, normalizeAppointments, storedAppointments } from "./normalize.js";

const STALE_AFTER_INTERVALS = 3;
/** How often Status and Attention are recomputed between fetches. */
const TICK_MS = 30_000;

export interface GoogleCalendarAdapterOptions {
  /** The OAuth client JSON from Cloud Console. */
  clientFile: string;
  /** Written by `manao auth google`; read on every fetch. */
  tokenFile: string;
  /** Default `["primary"]`. */
  calendars?: readonly string[];
  /** Fetch interval. Default 5 minutes. */
  intervalMs?: number;
  /** The fetch reaches the end of Today plus this many days. Default 7. */
  daysAhead?: number;
  /** How long each Health report counts as recent. Default 3x `intervalMs`. */
  staleAfterMs?: number;
  /** Hub clock, also used for Today in the system time zone. */
  now?: () => Date;
  /** Per Google request. Default 10 seconds. */
  timeoutMs?: number;
  endpoints?: GoogleEndpoints;
}

export class GoogleCalendarAdapter implements SourceAdapter {
  /** One Adapter per Google account; there is one account so far. */
  readonly id = "google-calendar:primary";
  private readonly google: GoogleConnection;
  private readonly calendars: readonly string[];
  private readonly intervalMs: number;
  private readonly daysAhead: number;
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private sink: ItemSink | null = null;

  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private readonly refreshes = new CoalescedRefresh(
    () => this.refreshOnce(),
    () => this.stopped,
  );
  private ticker: NodeJS.Timeout | null = null;
  /** The last Appointments stored: the last good fetch, as of the latest tick. */
  private lastStored: AppointmentItem[] = [];

  constructor(opts: GoogleCalendarAdapterOptions) {
    this.now = opts.now ?? (() => new Date());
    this.google = new GoogleConnection({
      clientFile: opts.clientFile,
      tokenFile: opts.tokenFile,
      endpoints: opts.endpoints,
      timeoutMs: opts.timeoutMs,
      now: this.now,
    });
    this.calendars = opts.calendars ?? ["primary"];
    this.intervalMs = opts.intervalMs ?? 300_000;
    this.daysAhead = opts.daysAhead ?? 7;
    this.staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_INTERVALS * this.intervalMs;
  }

  /** Until a fetch succeeds, ticks keep `stored`'s Appointments current, the first right after the first fetch. */
  async start(sink: ItemSink, stored?: StoredState): Promise<void> {
    this.stopped = false;
    this.sink = sink;
    this.lastStored = storedAppointments(stored?.items ?? []);
    await this.refresh();
    if (this.stopped) return;
    await this.tick();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.ticker = setInterval(() => void this.tick(), TICK_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    await this.refreshes.idle();
  }

  refresh(): Promise<void> {
    return this.refreshes.run();
  }

  private async refreshOnce(): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error("GoogleCalendarAdapter.refresh() called before start()");
    const now = this.now();
    const at = now.toISOString();
    let items: AppointmentItem[];
    try {
      const reads = await readCalendars(this.google, this.calendars, {
        timeMin: startOfLocalDay(now),
        timeMax: startOfLocalDay(now, this.daysAhead + 1),
      });
      items = normalizeAppointments(reads, at, now, this.id);
    } catch (error) {
      await this.report(sink, { ok: false, at, error: readErrorMessage(error) });
      return;
    }
    try {
      await sink.replaceItems(this.id, APPOINTMENT_ITEM_TYPE, items);
      this.lastStored = items;
    } catch (error) {
      await this.report(sink, { ok: false, at, error: `could not store Appointments: ${errorMessage(error)}` });
      return;
    }
    await this.report(sink, { ok: true, at });
  }

  /**
   * Recomputes Status and Attention of the last stored Appointments on the
   * clock and stores them only when one changed. Health stays with the fetch.
   */
  private async tick(): Promise<void> {
    const sink = this.sink;
    if (!sink || this.refreshes.running) return;
    const now = this.now();
    const at = now.toISOString();
    const next = this.lastStored.map((item) => ({
      ...item,
      status: appointmentStatus(item.data, now),
      attention: appointmentAttention(item.data, now),
      updatedAt: at,
    }));
    if (next.every((item, i) => item.status === this.lastStored[i]!.status && item.attention === this.lastStored[i]!.attention)) return;
    try {
      await sink.replaceItems(this.id, APPOINTMENT_ITEM_TYPE, next);
      this.lastStored = next;
    } catch (error) {
      await this.report(sink, { ok: false, at, error: `could not store Appointments: ${errorMessage(error)}` });
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

function readErrorMessage(error: unknown): string {
  return error instanceof GoogleError ? error.message : `unexpected failure: ${errorMessage(error)}`;
}
