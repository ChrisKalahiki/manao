#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { signIn } from "./google/sign-in.js";
import { startHubFromConfig } from "./hub/hub.js";
import { loadConfig } from "./hub/config.js";
import { googleScopes } from "./hub/google-sources.js";
import { resolveConfigPath, resolveDbPath, resolveGoogleTokenPath } from "./hub/paths.js";
import { homeRelative } from "./home-path.js";
import { manaoMcp } from "./mcp/server.js";

const USAGE = `manao: a personal hub over Herdr and other Sources

Usage:
  manao run
  manao mcp
  manao auth google [--port PORT]

  run    Start the hub: read every Source the config enables and keep
         what it finds in the store. Config at MANAO_CONFIG, default
         $XDG_CONFIG_HOME/manao/config.json (see config.example.json);
         store at MANAO_DB, else the config's dbPath, default
         $XDG_DATA_HOME/manao/hub.db. Serves the read-only API on
         127.0.0.1 (config api.port, default 7420) and, beside it at /,
         the dashboard \`bun run build\` builds. Ctrl+C to stop.
  mcp    Serve the read-only MCP server over stdio, for an agent's client
         to launch. Reads the store \`run\` writes (same lookup), read-only.
  auth google
         Sign in to Google once so the hub can read what every enabled
         Google Source (calendar, health) needs. Opens
         the browser, waits for Google to send it back to 127.0.0.1 (on
         PORT, default a free one), then writes the token to
         $XDG_DATA_HOME/manao/google-token.json. Needs the config's
         google.client. Run it again to reconnect, or after enabling
         another Google Source; no restart needed.
`;

function parseArgs(argv: string[]) {
  const [command, subcommand, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return { command, subcommand, flags };
}

function str(flags: Map<string, string | true>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
}

async function run(): Promise<void> {
  const configPath = resolveConfigPath();
  const config = loadConfig(configPath);
  const dbPath = resolveDbPath(process.env, config);
  const hub = await startHubFromConfig(config, { dbPath });
  console.log(homeRelative(`manao: hub running, config at ${configPath}, store at ${dbPath}`));
  console.log(hub.apiUrl ? `manao: API at ${hub.apiUrl}/api, dashboard at ${hub.apiUrl}/` : "manao: API off");
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void hub.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/**
 * stdout is the protocol channel, so everything else goes to stderr. A config
 * that cannot be read does not stop the server: each tool call reports it
 * until it is fixed.
 */
function mcp(): void {
  const dbPath = () => resolveDbPath(process.env, loadConfig(resolveConfigPath()));
  const manao = manaoMcp({ dbPath });
  const handle = serveStdio(() => manao.newServer(), {
    onerror: (err) => console.error(`manao mcp: ${err.message}`),
  });
  try {
    console.error(homeRelative(`manao mcp: serving on stdio, store at ${dbPath()}`));
  } catch (err) {
    console.error(`manao mcp: serving on stdio; ${err instanceof Error ? err.message : String(err)}`);
  }
  const stop = () => {
    void handle.close().then(() => {
      manao.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function authGoogle(flags: Map<string, string | true>): Promise<void> {
  const fail = (message: string) => new Error(`manao auth google: ${message}`);
  const configPath = resolveConfigPath();
  const config = loadConfig(configPath);
  const clientFile = config.google?.client;
  if (!clientFile) {
    throw fail(
      `google.client is not set in ${configPath}. Point it at the OAuth client JSON from Cloud Console (see the README's "Google connection").`,
    );
  }
  const scopes = googleScopes(config);
  if (scopes.length === 0) {
    throw fail(`no Google Source is enabled in ${configPath}. Enable sources.googleCalendar or sources.googleHealth first.`);
  }
  const port = flags.has("port") ? Number(str(flags, "port")) : 0;
  if (flags.has("port") && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
    throw fail("--port must be a port number from 1 to 65535.");
  }
  try {
    await signIn({
      clientFile,
      tokenFile: resolveGoogleTokenPath(),
      scopes,
      port,
      openBrowser,
      print: (line) => console.log(line),
    });
  } catch (err) {
    throw fail(err instanceof Error ? err.message : String(err));
  }
}

/** Over SSH the browser to use is on the other machine, so only the printed address helps. */
function openBrowser(url: string): void {
  if (process.env.SSH_CONNECTION) return;
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => console.log(`(Could not run ${command}; open the address above yourself.)`));
  child.unref();
}

async function main(): Promise<void> {
  const { command, subcommand, flags } = parseArgs(process.argv.slice(2));
  if (command === "run") return run();
  if (command === "mcp") return mcp();
  if (command === "auth" && subcommand === "google") return authGoogle(flags);
  console.log(USAGE);
  process.exitCode = command ? 2 : 0;
}

main().catch((err) => {
  console.error(homeRelative(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
