import { CALENDAR_SCOPES } from "../google-calendar/api.js";
import { DRIVE_SCOPES } from "../google-drive/api.js";
import { HEALTH_SCOPES } from "../google-health/api.js";
import type { HubConfig } from "./config.js";

/** Each Google Source's key under `sources`, and the scopes its reads need. */
export const GOOGLE_SOURCES = {
  googleCalendar: CALENDAR_SCOPES,
  googleHealth: HEALTH_SCOPES,
} as const satisfies Partial<Record<keyof HubConfig["sources"], readonly string[]>>;

export type GoogleSource = keyof typeof GOOGLE_SOURCES;

export const GOOGLE_SOURCE_NAMES = Object.keys(GOOGLE_SOURCES) as GoogleSource[];

/**
 * What `manao auth google` asks for: the scopes of every enabled Google
 * Source, plus `drive.file` for `manao digest --drive`, so one consent covers
 * them all. None when no Google Source is enabled.
 */
export function googleScopes(config: HubConfig): string[] {
  const sources = GOOGLE_SOURCE_NAMES.flatMap((name) => (config.sources[name] ? GOOGLE_SOURCES[name] : []));
  return sources.length > 0 ? [...sources, ...DRIVE_SCOPES] : [];
}
