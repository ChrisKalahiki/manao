/**
 * Source-agnostic contracts for the hub. Every integration (Herdr, Obsidian,
 * Calendar, ...) emits HubItems and HubEvents through an ItemSink; the SQLite
 * store, the dashboard API and the MCP server all sit behind that sink.
 */

import type { Measurement } from "../measurement.js";

/** One normalized thing a source wants the hub to know about right now. */
export interface HubItem<TData = unknown> {
  /** Which adapter instance produced it, e.g. "herdr:local". */
  source: string;
  /** Item kind, e.g. "agent", "task", "appointment". */
  type: string;
  /** Stable within (source, type). Must survive renames and moves. */
  id: string;
  title: string;
  /** Source-defined status vocabulary (see the adapter's own types). */
  status: string;
  /** Raised when the item needs the user now, by the source's own rules. */
  attention: boolean;
  /** ISO time the hub last observed this item change (not source time). */
  updatedAt: string;
  /** Source-specific detail. Keep it JSON-serializable. */
  data: TData;
}

/** Something that happened, as opposed to something that currently is. */
export interface HubEvent<TData = unknown> {
  source: string;
  kind: string;
  /** ISO time the hub observed it. The store sets it when recording the Event; what an Adapter sends is replaced. */
  at: string;
  data: TData;
}

export interface Health {
  ok: boolean;
  at: string;
  error?: string;
  /** Non-fatal observation, e.g. a protocol version mismatch. */
  note?: string;
  /** How long this report counts as recent; past it the Source is not Healthy. */
  staleAfterMs: number;
}

export interface ItemSink {
  /**
   * Replace the full set of items of one type for one source. Adapters call
   * this with the complete current list, never a delta. If a source is
   * unreachable the adapter does NOT call this with an empty list; it calls
   * reportHealth instead so stale data is visible rather than silently wiped.
   */
  replaceItems(source: string, type: string, items: HubItem[]): void | Promise<void>;
  emitEvents(events: HubEvent[]): void | Promise<void>;
  reportHealth(source: string, health: Health): void | Promise<void>;
  /**
   * Write the Measurements of the days a Source read, replacing those days'
   * values and keeping every other day. A day read with no data is left out,
   * never written as zero.
   */
  writeMeasurements(source: string, measurements: readonly Measurement[]): void | Promise<void>;
}

/** What the store holds for one Source from before the hub started. */
export interface StoredState {
  items: readonly HubItem[];
  /** The date of the Source's latest Measurement, or null when it has none. */
  latestMeasurementDate: string | null;
  /** The Source's newest Event of each kind, so it can tell what it already recorded. */
  latestEvents: readonly HubEvent[];
}

export interface SourceAdapter {
  readonly id: string;
  /**
   * `stored` is for an Adapter that carries on from what it stored before
   * the start: one that keeps its Items current from them until its first
   * good read, one that reads on from its latest Measurement, or one that
   * records an Event only for what it has not recorded before. Other
   * Adapters leave it out of their signature.
   */
  start(sink: ItemSink, stored?: StoredState): Promise<void>;
  stop(): Promise<void>;
  /** Pull once now. Safe to call concurrently; calls coalesce. */
  refresh(): Promise<void>;
}
