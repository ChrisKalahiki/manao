import { CALENDAR_SCOPES } from "../google-calendar/api.js";
import { HEALTH_SCOPES } from "../google-health/api.js";
import type { HubConfig } from "./config.js";

/** Each Google Source's key under `sources`, and the scopes its reads need. */
export const GOOGLE_SOURCES = {
  googleCalendar: CALENDAR_SCOPES,
  googleHealth: HEALTH_SCOPES,
} as const satisfies Partial<Record<keyof HubConfig["sources"], readonly string[]>>;

export type GoogleSource = keyof typeof GOOGLE_SOURCES;

export const GOOGLE_SOURCE_NAMES = Object.keys(GOOGLE_SOURCES) as GoogleSource[];

/** What `manao auth google` asks for: the scopes of every enabled Google Source, so one consent covers them all. */
export function googleScopes(config: HubConfig): string[] {
  return GOOGLE_SOURCE_NAMES.flatMap((name) => (config.sources[name] ? GOOGLE_SOURCES[name] : []));
}
