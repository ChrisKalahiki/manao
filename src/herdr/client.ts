import net from "node:net";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../error-message.js";
import { type HelloResult, PROTOCOL_GENERATION, parseTerminalList, type Terminal } from "./types.js";

/**
 * The only herdr-core methods this package will ever send. The socket has no
 * authentication and the same surface can type into terminals, run programs,
 * write files and stop the core, so "read-only" is enforced here, in code,
 * before any bytes leave the process. `terminal.read`, `terminal.attach`,
 * `file.read` and `doc.get` are deliberately excluded: they return screen
 * text, files or opaque documents, which can include secrets.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "hello",
  "server.status",
  "terminal.list",
  "terminal.get",
  "events.subscribe",
]);

export class ReadOnlyViolationError extends Error {
  constructor(method: string) {
    super(
      `Refusing to call herdr-core method "${method}": this adapter is read-only. ` +
        `Allowed: ${[...READ_ONLY_METHODS].join(", ")}`,
    );
    this.name = "ReadOnlyViolationError";
  }
}

/** A JSON-RPC error from herdr-core; `kind` is its stable `error.data.kind`. */
export class HerdrError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

export function assertReadOnly(method: string): void {
  if (!READ_ONLY_METHODS.has(method)) throw new ReadOnlyViolationError(method);
}

export interface SocketOptions {
  /** Absolute path to the socket. Wins over the default. */
  socketPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/**
 * `socketPath`, else `$XDG_STATE_HOME/herdr-core/default/default.sock`
 * (default `~/.local/state`). `HC_TERMINAL_SOCKET` is ignored on purpose:
 * herdr-core sets it only inside its own terminals, never under launchd.
 */
export function resolveSocketPath(opts: SocketOptions = {}): string {
  if (opts.socketPath) return opts.socketPath;
  const env = opts.env ?? process.env;
  const stateHome = env.XDG_STATE_HOME || path.join(opts.homeDir ?? os.homedir(), ".local", "state");
  return path.join(stateHome, "herdr-core", "default", "default.sock");
}

export interface HerdrClientOptions extends SocketOptions {
  timeoutMs?: number;
}

interface RpcReply {
  id?: unknown;
  result?: unknown;
  error?: { message?: string; data?: { kind?: string; hint?: string } };
}

const HELLO_ID = 1;
const REQUEST_ID = 2;

/**
 * JSON-RPC 2.0 over a Unix domain socket, one line per message and one
 * short-lived connection per request: `hello` with the generation this
 * package speaks, then the request.
 */
export class HerdrClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(opts: HerdrClientOptions = {}) {
    this.socketPath = resolveSocketPath(opts);
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    assertReadOnly(method);

    return new Promise<T>((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      sock.setEncoding("utf8");
      let buf = "";
      let done = false;

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const fail = (err: Error) => finish(() => reject(err));
      const send = (id: number, name: string, body: Record<string, unknown>) =>
        sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: name, params: body })}\n`);
      const timer = setTimeout(
        () => fail(new Error(`herdr-core request "${method}" timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );

      const onReply = (reply: RpcReply) => {
        if (reply.id === HELLO_ID) {
          if (reply.error) {
            const { message = "unknown error", data } = reply.error;
            fail(
              new HerdrError(
                data?.kind ?? "unknown",
                `herdr-core refused protocol generation ${PROTOCOL_GENERATION}: ${message}${data?.hint ? ` (${data.hint})` : ""}`,
              ),
            );
            return;
          }
          const hello = reply.result as HelloResult;
          if (hello.generation !== PROTOCOL_GENERATION) {
            fail(
              new HerdrError(
                "unsupported_generation",
                `herdr-core ${hello.version} speaks protocol generation ${hello.generation}; manao speaks ${PROTOCOL_GENERATION}`,
              ),
            );
            return;
          }
          send(REQUEST_ID, method, params);
        } else if (reply.id === REQUEST_ID) {
          if (reply.error) {
            const { message = "unknown error", data } = reply.error;
            fail(new HerdrError(data?.kind ?? "unknown", message));
          } else {
            finish(() => resolve(reply.result as T));
          }
        }
      };

      sock.on("connect", () => send(HELLO_ID, "hello", { generation: PROTOCOL_GENERATION }));

      sock.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl !== -1 && !done; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let reply: RpcReply;
          try {
            reply = JSON.parse(line);
          } catch {
            fail(new Error("herdr-core sent invalid JSON"));
            return;
          }
          onReply(reply);
        }
      });

      sock.on("error", (err: NodeJS.ErrnoException) => {
        const hint =
          err.code === "ENOENT" || err.code === "ECONNREFUSED"
            ? `herdr-core socket not reachable at ${this.socketPath} (${err.code}). Is the Herdr app running? Try \`hc server status\`.`
            : err.message;
        fail(new Error(hint));
      });
      sock.on("close", () => fail(new Error("herdr-core closed the connection before replying")));
    });
  }

  /** This machine's live terminals; other machines' (`machine/t7`) are left to the caller. */
  async list(): Promise<Terminal[]> {
    const result = await this.request("terminal.list");
    try {
      return parseTerminalList(result);
    } catch (err) {
      throw new Error(`herdr-core's terminal.list is not in the shape manao reads: ${errorMessage(err)}`);
    }
  }
}
