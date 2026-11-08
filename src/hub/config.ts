import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrainDumpAdapter } from "../brain-dump/adapter.js";
import type { SourceAdapter } from "../core/types.js";
import { GoogleCalendarAdapter } from "../google-calendar/adapter.js";
import { GoogleHealthAdapter } from "../google-health/adapter.js";
import type { GoogleEndpoints } from "../google/oauth.js";
import { HerdrAdapter } from "../herdr/adapter.js";
import { PaperBotAdapter } from "../paper-bot/adapter.js";
import { GOOGLE_SOURCE_NAMES } from "./google-sources.js";
import { resolveGoogleTokenPath } from "./paths.js";

/** A Source read by running a CLI behind a JSON contract: Brain-Dump and paper-bot. */
export interface CommandSourceConfig {
  command?: string;
  intervalSeconds: number;
  staleAfterSeconds?: number;
}

export interface HerdrConfig {
  /** Overrides the herdr-core socket, `$XDG_STATE_HOME/herdr-core/default/default.sock` by default. */
  socketPath?: string;
  intervalSeconds: number;
  /** Subscribe to herdr-core events as refresh nudges. */
  events: boolean;
  /** How long a Health report counts as recent. Defaults to 3x the interval. */
  staleAfterSeconds?: number;
}

export interface GoogleCalendarConfig {
  /** Calendar ids of the connected account; `primary` is its own calendar. */
  calendars: string[];
  intervalSeconds: number;
  /** The fetch reaches the end of Today plus this many days. */
  daysAhead: number;
  staleAfterSeconds?: number;
}

export interface GoogleHealthConfig {
  intervalSeconds: number;
  /** How many days before Today a refresh reaches back at most: the first run's backfill and the longest catch-up. */
  backfillDays: number;
  staleAfterSeconds?: number;
}

/** The one connected Google account; room for a later `accounts`. */
export interface GoogleConfig {
  /** The OAuth client JSON downloaded from Cloud Console. */
  client: string;
}

/** The read-only HTTP API, on 127.0.0.1. */
export interface ApiConfig {
  /** 0 picks a free port. */
  port: number;
}

/** What the hub runs. Each key under `sources` is one enabled Source. */
export interface HubConfig {
  sources: {
    herdr?: HerdrConfig;
    brainDump?: CommandSourceConfig;
    googleCalendar?: GoogleCalendarConfig;
    googleHealth?: GoogleHealthConfig;
    paperBot?: CommandSourceConfig;
  };
  /** Required when a Google Source is enabled. */
  google?: GoogleConfig;
  eventRetentionDays: number;
  /** `false` runs the hub without the API. */
  api: ApiConfig | false;
  /** Where the store lives; `MANAO_DB` wins over it. */
  dbPath?: string;
}

/** A config the hub refuses to start with. The message names the field. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

// Keyed by every option so the compiler flags a type change the validator misses.
const CONFIG_KEYS = Object.keys({
  sources: true,
  google: true,
  eventRetentionDays: true,
  api: true,
  dbPath: true,
} satisfies Record<keyof HubConfig, true>);
const SOURCES = Object.keys({
  herdr: true,
  brainDump: true,
  googleCalendar: true,
  googleHealth: true,
  paperBot: true,
} satisfies Record<keyof HubConfig["sources"], true>);
const HERDR_KEYS = Object.keys({
  socketPath: true,
  intervalSeconds: true,
  events: true,
  staleAfterSeconds: true,
} satisfies Record<keyof HerdrConfig, true>);
const COMMAND_SOURCE_KEYS = Object.keys({
  command: true,
  intervalSeconds: true,
  staleAfterSeconds: true,
} satisfies Record<keyof CommandSourceConfig, true>);
const GOOGLE_CALENDAR_KEYS = Object.keys({
  calendars: true,
  intervalSeconds: true,
  daysAhead: true,
  staleAfterSeconds: true,
} satisfies Record<keyof GoogleCalendarConfig, true>);
const GOOGLE_HEALTH_KEYS = Object.keys({
  intervalSeconds: true,
  backfillDays: true,
  staleAfterSeconds: true,
} satisfies Record<keyof GoogleHealthConfig, true>);
const MAX_BACKFILL_DAYS = 90;
const GOOGLE_KEYS = Object.keys({ client: true } satisfies Record<keyof GoogleConfig, true>);
const API_KEYS = Object.keys({ port: true } satisfies Record<keyof ApiConfig, true>);
const DEFAULT_API_PORT = 7420;

/** Reads and validates the config at `file`. A missing file means the defaults. */
export function loadConfig(file: string): HubConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw err;
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (err) {
    const reason = err instanceof SyntaxError ? `not valid JSON (${err.message})` : (err as Error).message;
    throw new ConfigError(`Invalid config ${file}: ${reason}`);
  }
}

/**
 * Checks a parsed config and fills in defaults. Leaving `sources` out enables
 * Herdr; keys starting with "//" are comments and ignored at every level.
 */
export function parseConfig(raw: unknown): HubConfig {
  const root = object(raw, "config", CONFIG_KEYS);
  const sources = root.sources === undefined ? { herdr: {} } : object(root.sources, "sources", SOURCES, "Source");
  const googleCalendar = sources.googleCalendar === undefined ? undefined : googleCalendarConfig(sources.googleCalendar);
  const googleHealth = sources.googleHealth === undefined ? undefined : googleHealthConfig(sources.googleHealth);
  const google = root.google === undefined ? undefined : googleConfig(root.google);
  for (const name of GOOGLE_SOURCE_NAMES) {
    if (sources[name] !== undefined && !google?.client) {
      throw new ConfigError(`google.client is required when sources.${name} is enabled`);
    }
  }
  return {
    sources: {
      herdr: sources.herdr === undefined ? undefined : herdrConfig(sources.herdr),
      brainDump: sources.brainDump === undefined ? undefined : commandSourceConfig(sources.brainDump, "sources.brainDump", 60),
      googleCalendar,
      googleHealth,
      paperBot: sources.paperBot === undefined ? undefined : commandSourceConfig(sources.paperBot, "sources.paperBot", 900),
    },
    google,
    eventRetentionDays: optional(root.eventRetentionDays, "eventRetentionDays", positiveInteger) ?? 30,
    api: root.api === undefined ? { port: DEFAULT_API_PORT } : apiConfig(root.api),
    dbPath: optional(root.dbPath, "dbPath", absolutePath),
  };
}

function herdrConfig(raw: unknown): HerdrConfig {
  const field = "sources.herdr";
  const herdr = object(raw, field, HERDR_KEYS);
  return {
    socketPath: optional(herdr.socketPath, `${field}.socketPath`, absolutePath),
    intervalSeconds: optional(herdr.intervalSeconds, `${field}.intervalSeconds`, positiveNumber) ?? 5,
    events: optional(herdr.events, `${field}.events`, boolean) ?? true,
    staleAfterSeconds: optional(herdr.staleAfterSeconds, `${field}.staleAfterSeconds`, positiveNumber),
  };
}

function commandSourceConfig(raw: unknown, field: string, defaultIntervalSeconds: number): CommandSourceConfig {
  const source = object(raw, field, COMMAND_SOURCE_KEYS);
  return {
    command: optional(source.command, `${field}.command`, command),
    intervalSeconds: optional(source.intervalSeconds, `${field}.intervalSeconds`, positiveNumber) ?? defaultIntervalSeconds,
    staleAfterSeconds: optional(source.staleAfterSeconds, `${field}.staleAfterSeconds`, positiveNumber),
  };
}

function googleCalendarConfig(raw: unknown): GoogleCalendarConfig {
  const field = "sources.googleCalendar";
  const calendar = object(raw, field, GOOGLE_CALENDAR_KEYS);
  return {
    calendars: optional(calendar.calendars, `${field}.calendars`, calendarIds) ?? ["primary"],
    intervalSeconds: optional(calendar.intervalSeconds, `${field}.intervalSeconds`, positiveNumber) ?? 300,
    daysAhead: optional(calendar.daysAhead, `${field}.daysAhead`, wholeNumber) ?? 7,
    staleAfterSeconds: optional(calendar.staleAfterSeconds, `${field}.staleAfterSeconds`, positiveNumber),
  };
}

function googleHealthConfig(raw: unknown): GoogleHealthConfig {
  const field = "sources.googleHealth";
  const health = object(raw, field, GOOGLE_HEALTH_KEYS);
  return {
    intervalSeconds: optional(health.intervalSeconds, `${field}.intervalSeconds`, positiveNumber) ?? 3600,
    backfillDays: optional(health.backfillDays, `${field}.backfillDays`, wholeNumberUpTo(MAX_BACKFILL_DAYS)) ?? 30,
    staleAfterSeconds: optional(health.staleAfterSeconds, `${field}.staleAfterSeconds`, positiveNumber),
  };
}

function googleConfig(raw: unknown): GoogleConfig | undefined {
  const google = object(raw, "google", GOOGLE_KEYS);
  const client = optional(google.client, "google.client", absolutePath);
  return client === undefined ? undefined : { client };
}

function apiConfig(raw: unknown): ApiConfig | false {
  if (raw === false) return false;
  if (typeof raw === "boolean") throw new ConfigError("api must be false or an object");
  const api = object(raw, "api", API_KEYS);
  return { port: optional(api.port, "api.port", port) ?? DEFAULT_API_PORT };
}

/** What the config does not say: where Google lives and how long to wait for it, which tests point at a fake. */
export interface AdapterEnvironment {
  googleEndpoints?: GoogleEndpoints;
  /** Per Google request. Default 10 seconds. */
  googleTimeoutMs?: number;
}

/** One Adapter per enabled Source, built from that Source's options and running on `now`. */
export function createAdapters(config: HubConfig, now?: () => Date, env: AdapterEnvironment = {}): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];
  const { herdr, brainDump, googleCalendar, googleHealth, paperBot } = config.sources;
  if (herdr) {
    adapters.push(
      new HerdrAdapter({
        socket: { socketPath: herdr.socketPath },
        intervalMs: herdr.intervalSeconds * 1000,
        events: herdr.events,
        staleAfterMs: herdr.staleAfterSeconds === undefined ? undefined : herdr.staleAfterSeconds * 1000,
        now,
      }),
    );
  }
  if (brainDump) {
    adapters.push(
      new BrainDumpAdapter({
        command: brainDump.command,
        intervalMs: brainDump.intervalSeconds * 1000,
        staleAfterMs: brainDump.staleAfterSeconds === undefined ? undefined : brainDump.staleAfterSeconds * 1000,
        now,
      }),
    );
  }
  if (googleCalendar && config.google) {
    adapters.push(
      new GoogleCalendarAdapter({
        clientFile: config.google.client,
        tokenFile: resolveGoogleTokenPath(),
        calendars: googleCalendar.calendars,
        intervalMs: googleCalendar.intervalSeconds * 1000,
        daysAhead: googleCalendar.daysAhead,
        staleAfterMs: googleCalendar.staleAfterSeconds === undefined ? undefined : googleCalendar.staleAfterSeconds * 1000,
        endpoints: env.googleEndpoints,
        timeoutMs: env.googleTimeoutMs,
        now,
      }),
    );
  }
  if (googleHealth && config.google) {
    adapters.push(
      new GoogleHealthAdapter({
        clientFile: config.google.client,
        tokenFile: resolveGoogleTokenPath(),
        intervalMs: googleHealth.intervalSeconds * 1000,
        backfillDays: googleHealth.backfillDays,
        staleAfterMs: googleHealth.staleAfterSeconds === undefined ? undefined : googleHealth.staleAfterSeconds * 1000,
        endpoints: env.googleEndpoints,
        timeoutMs: env.googleTimeoutMs,
        now,
      }),
    );
  }
  if (paperBot) {
    adapters.push(
      new PaperBotAdapter({
        command: paperBot.command,
        intervalMs: paperBot.intervalSeconds * 1000,
        staleAfterMs: paperBot.staleAfterSeconds === undefined ? undefined : paperBot.staleAfterSeconds * 1000,
        now,
      }),
    );
  }
  return adapters;
}

type Check<T> = (value: unknown, field: string) => T;

function optional<T>(value: unknown, field: string, check: Check<T>): T | undefined {
  return value === undefined ? undefined : check(value, field);
}

function object(
  value: unknown,
  field: string,
  known: readonly string[],
  what = "option",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${field} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("//") || known.includes(key)) continue;
    const name = field === "config" ? key : `${field}.${key}`;
    throw new ConfigError(`${name} is not a known ${what} (expected one of: ${known.join(", ")})`);
  }
  return value as Record<string, unknown>;
}

const positiveNumber: Check<number> = (value, field) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${field} must be a positive number`);
  }
  return value;
};

const positiveInteger: Check<number> = (value, field) => {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new ConfigError(`${field} must be a positive whole number`);
  return value as number;
};

const wholeNumber: Check<number> = (value, field) => {
  if (!Number.isInteger(value) || (value as number) < 0) throw new ConfigError(`${field} must be a whole number, 0 or more`);
  return value as number;
};

function wholeNumberUpTo(max: number): Check<number> {
  return (value, field) => {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
      throw new ConfigError(`${field} must be a whole number from 1 to ${max}`);
    }
    return value as number;
  };
}

const calendarIds: Check<string[]> = (value, field) => {
  const ids = Array.isArray(value) ? value : [];
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || id === "") || new Set(ids).size !== ids.length) {
    throw new ConfigError(`${field} must be a non-empty list of distinct calendar ids`);
  }
  return ids;
};

const port: Check<number> = (value, field) => {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 65535) {
    throw new ConfigError(`${field} must be a whole number from 0 to 65535`);
  }
  return value as number;
};

const boolean: Check<boolean> = (value, field) => {
  if (typeof value !== "boolean") throw new ConfigError(`${field} must be true or false`);
  return value;
};

const nonEmptyString: Check<string> = (value, field) => {
  if (typeof value !== "string" || value === "") throw new ConfigError(`${field} must be a non-empty string`);
  return value;
};

/** An absolute path, or one starting with `~/`. */
const absolutePath: Check<string> = (value, field) => {
  const raw = nonEmptyString(value, field);
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) throw new ConfigError(`${field} must be an absolute path or start with ~/`);
  return expanded;
};

const command: Check<string> = (value, field) => {
  const raw = nonEmptyString(value, field);
  if (raw.startsWith("~/") || path.isAbsolute(raw)) return absolutePath(raw, field);
  if (raw.includes("/") || raw.trim() === "" || raw === "." || raw === "..") {
    throw new ConfigError(`${field} must be a bare command name, an absolute path or start with ~/`);
  }
  return raw;
};
