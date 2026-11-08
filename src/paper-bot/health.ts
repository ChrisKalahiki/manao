import type { Health } from "../core/types.js";
import type { PicksOutput } from "./contract.js";

/** A Daily Scan this old means paper-bot's 06:00 Scan did not run. */
const DAILY_SCAN_MAX_AGE_MS = 26 * 60 * 60 * 1000;

/**
 * paper-bot's own Health from a good read: ok unless the Daily Scan failed,
 * is 26 hours old or has never run, the Weekly Scan failed, or a Keep is
 * failing. Sources that failed in a Daily Scan are only noted.
 */
export function scanHealth(output: PicksOutput, now: Date): Pick<Health, "ok" | "error" | "note"> {
  const { daily, weekly } = output.scans;
  const problems: string[] = [];
  if (daily === null) problems.push("no Daily Scan yet");
  else if (daily.outcome === "failed") problems.push(failed("Daily Scan", daily.reason));
  else if (now.getTime() - Date.parse(daily.at) >= DAILY_SCAN_MAX_AGE_MS) {
    problems.push(`last Daily Scan at ${daily.at}, 26 hours or more ago`);
  }
  if (weekly?.outcome === "failed") problems.push(failed("Weekly Scan", weekly.reason));
  for (const keep of output.keeps.failing) {
    problems.push(`Keep failing since ${keep.since}: ${keep.title} (${keep.error})`);
  }
  const failedSources = (daily?.sources ?? [])
    .filter((source) => !source.ok)
    .map((source) => (source.error === null ? source.name : `${source.name} (${source.error})`));
  return {
    ok: problems.length === 0,
    error: problems.length === 0 ? undefined : problems.join("; "),
    note: failedSources.length === 0 ? undefined : `Daily Scan sources failed: ${failedSources.join(", ")}`,
  };
}

function failed(scan: string, reason: string | null): string {
  return reason === null ? `${scan} failed` : `${scan} failed: ${reason}`;
}
