import net from "node:net";
import { assertReadOnly } from "./client.js";
import { PROTOCOL_GENERATION } from "./types.js";

export interface NudgerOptions {
  socketPath: string;
  onNudge: () => void;
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Coalesce bursts into one nudge: an agent sends a `status` event for every new status message. */
  debounceMs?: number;
}

const HELLO_ID = 1;
const SUBSCRIBE_ID = 2;

/** Notifications that mean "something changed, go re-read". `heartbeat` (every 15 s) does not. */
const NUDGING_NOTIFICATIONS: ReadonlySet<string> = new Set(["event", "missed"]);

/**
 * `event` types that never change what manao stores. A working agent retitles its
 * terminal about every 100ms, so nudging on `title` would re-read continuously; the
 * title only backs `activity`, which the poll keeps current. A denylist, so an event
 * type herdr-core adds later still nudges.
 */
const QUIET_EVENT_TYPES: ReadonlySet<string> = new Set(["title", "size", "doc", "keep"]);

/** The event's type only decides whether to re-read, never what is stored (hard rule 3). */
function isQuiet(msg: { method?: unknown; params?: { type?: unknown } }): boolean {
  const type = msg.params?.type;
  return msg.method === "event" && typeof type === "string" && QUIET_EVENT_TYPES.has(type);
}

/**
 * Best-effort push channel over herdr-core's `events.subscribe`, on its own
 * long-lived connection. Its payloads are never read (hard rule 3): an `event`
 * or `missed` notification only nudges the adapter to re-read. If the channel
 * is down the poll loop still works; this only makes updates faster. It
 * reconnects with backoff and nudges once subscribed, since anything that
 * changed while it was down is only visible by re-reading.
 */
export class EventNudger {
  private sock: net.Socket | null = null;
  private stopped = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private backoff: number;
  private readonly baseBackoff: number;
  private readonly maxBackoff: number;
  private readonly debounceMs: number;

  constructor(private readonly opts: NudgerOptions) {
    this.baseBackoff = opts.backoffMs ?? 1000;
    this.maxBackoff = opts.maxBackoffMs ?? 30_000;
    this.debounceMs = opts.debounceMs ?? 250;
    this.backoff = this.baseBackoff;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.retryTimer = this.debounceTimer = null;
    this.sock?.destroy();
    this.sock = null;
  }

  private nudge(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.opts.onNudge();
    }, this.debounceMs);
  }

  private connect(): void {
    if (this.stopped) return;
    assertReadOnly("hello");
    assertReadOnly("events.subscribe");

    const sock = net.createConnection(this.opts.socketPath);
    this.sock = sock;
    sock.setEncoding("utf8");
    let buf = "";
    const send = (id: number, method: string, params: Record<string, unknown>) =>
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

    sock.on("connect", () => send(HELLO_ID, "hello", { generation: PROTOCOL_GENERATION }));

    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: {
          id?: unknown;
          method?: unknown;
          params?: { type?: unknown };
          error?: unknown;
          result?: { generation?: unknown };
        };
        try {
          msg = JSON.parse(line);
        } catch {
          // Unparseable line: treat as a nudge rather than guessing at framing.
          this.nudge();
          continue;
        }
        if (msg.error || (msg.id === HELLO_ID && msg.result?.generation !== PROTOCOL_GENERATION)) {
          // A refused hello or subscription: the adapter's reads report why. Retry later.
          sock.destroy();
          return;
        }
        if (msg.id === HELLO_ID) {
          send(SUBSCRIBE_ID, "events.subscribe", {});
        } else if (msg.id === SUBSCRIBE_ID) {
          this.backoff = this.baseBackoff;
          this.nudge();
        } else if (typeof msg.method === "string" && NUDGING_NOTIFICATIONS.has(msg.method) && !isQuiet(msg)) {
          this.nudge();
        }
      }
    });

    sock.on("error", () => {
      // 'close' always follows; nothing to do here.
    });

    sock.on("close", () => {
      if (this.sock === sock) this.sock = null;
      if (this.stopped) return;
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    });
  }
}
