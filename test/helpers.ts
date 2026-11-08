import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Health, HubEvent, HubItem, ItemSink } from "../src/core/types.js";
import type { Measurement } from "../src/measurement.js";

export interface TerminalSpec {
  address: string;
  /** The program's reported state; null for a shell that never reports. Default "idle". */
  status?: string | null;
  app?: string;
  msg?: string;
  kind?: string;
  where?: string | null;
  name?: string | null;
  title?: string;
  turn?: number;
  /** When the program's word last changed, ms since the epoch. Default: now, a report just made. */
  statusMs?: number | null;
}

/** A terminal as herdr-core's `terminal.list` sends it, command line and foreground process included. */
export function terminal(spec: TerminalSpec): Record<string, unknown> {
  const state = spec.status === undefined ? "idle" : spec.status;
  const status =
    state === null
      ? null
      : { app: spec.app ?? "claude-code", state, ...(spec.msg ? { msg: spec.msg } : {}), ...(spec.kind ? { kind: spec.kind } : {}) };
  return {
    address: spec.address,
    argv: ["/bin/zsh"],
    cols: 120,
    created_ms: 1793303104858,
    cwd: "/Users/me/Projects/manao",
    foreground: { argv: ["claude", "--token", "secret"], cwd: "/Users/me/Projects/manao", name: "claude", pid: 811 },
    labels: { "herdr.space": "sp1", "herdr.tab": "tb1", ...(spec.where === null ? {} : { where: spec.where ?? "Manaʻo / 1" }) },
    name: spec.name ?? null,
    pid: 811,
    reported: state !== null,
    rows: 40,
    screen: "exact",
    state: "live",
    status,
    status_ms: state === null ? null : spec.statusMs === undefined ? Date.now() : spec.statusMs,
    title: spec.title ?? "",
    turn: spec.turn ?? 0,
  };
}

interface RpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** A stand-in herdr-core on a temp Unix socket, laid out as `$XDG_STATE_HOME/herdr-core/default/default.sock` under `stateHome`. */
export class FakeHerdrCore {
  readonly stateHome = mkdtempSync(path.join(os.tmpdir(), "hub-hc-"));
  readonly socketPath = path.join(this.stateHome, "herdr-core", "default", "default.sock");
  /** Every method name received, in order. */
  readonly methods: string[] = [];
  /** What `terminal.list` returns, as wire terminals. */
  terminals: unknown[] = [];
  /** The protocol generation this core speaks. */
  generation = 1;
  /** "silent" reads every request and never answers. */
  mode: "normal" | "silent" = "normal";
  /** Refuses the next events.subscribe with this error kind, then closes. */
  failNextSubscribe: string | null = null;

  private server = net.createServer((sock) => this.onConnection(sock));
  private sockets = new Set<net.Socket>();
  private subscribers = new Set<net.Socket>();
  private seq = 0;

  async listen(): Promise<this> {
    mkdirSync(path.dirname(this.socketPath), { recursive: true });
    await new Promise<void>((resolve) => this.server.listen(this.socketPath, resolve));
    return this;
  }

  private onConnection(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.on("close", () => {
      this.sockets.delete(sock);
      this.subscribers.delete(sock);
    });
    sock.on("error", () => {});
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        this.handle(sock, JSON.parse(line));
      }
    });
  }

  private handle(sock: net.Socket, req: RpcRequest): void {
    this.methods.push(req.method);
    if (this.mode === "silent") return;
    const send = (body: Record<string, unknown>): void => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, ...body })}\n`);
    };
    const fail = (code: number, kind: string, message: string, hint?: string): void =>
      send({ error: { code, message, data: { kind, ...(hint ? { hint } : {}) } } });
    switch (req.method) {
      case "hello":
        if (req.params.generation !== this.generation) {
          fail(-32000, "unsupported_generation", `protocol generation ${String(req.params.generation)} not supported`, `this core speaks generation ${this.generation}`);
          return;
        }
        send({ result: { generation: this.generation, version: "0.1.16", core: { id: "c0ffee", name: "mini" }, framed: false, methods: [], features: [] } });
        return;
      case "terminal.list":
        send({ result: { hidden_finished: 0, terminals: this.terminals } });
        return;
      case "events.subscribe":
        if (this.failNextSubscribe) {
          fail(-32000, this.failNextSubscribe, "subscription refused");
          this.failNextSubscribe = null;
          sock.end();
          return;
        }
        this.subscribers.add(sock);
        send({ result: { channel: null, seq: this.seq, terminals: this.terminals } });
        return;
      default:
        fail(-32601, "unknown_method", `unknown method "${req.method}"`, "see `hc schema`");
    }
  }

  /** Pushes a notification (`event`, `missed`, `heartbeat`) to every subscriber, as herdr-core does. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.seq++;
    for (const s of this.subscribers) s.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: { seq: this.seq, ...params } })}\n`);
  }

  get subscribeCount(): number {
    return this.methods.filter((m) => m === "events.subscribe").length;
  }

  /** Drops every live connection, as a core restart would. */
  dropConnections(): void {
    for (const s of this.sockets) s.destroy();
  }

  /** How many times `terminal.list` was asked for. */
  get lists(): number {
    return this.methods.filter((m) => m === "terminal.list").length;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.stateHome, { recursive: true, force: true });
  }
}

export class MemorySink implements ItemSink {
  items: HubItem[] = [];
  replaceCalls = 0;
  events: HubEvent[] = [];
  health: Health[] = [];
  measurements: Measurement[] = [];

  replaceItems(_source: string, _type: string, items: HubItem[]): void {
    this.replaceCalls++;
    this.items = items;
  }
  emitEvents(events: HubEvent[]): void {
    this.events.push(...events);
  }
  reportHealth(_source: string, health: Health): void {
    this.health.push(health);
  }
  writeMeasurements(_source: string, measurements: readonly Measurement[]): void {
    this.measurements.push(...measurements);
  }
  get lastHealth(): Health | undefined {
    return this.health[this.health.length - 1];
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export function buildDist(): void {
  execFileSync(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"]);
}
