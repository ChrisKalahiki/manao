import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PicksOutput } from "../src/paper-bot/contract.js";

/** The hub's clock in these tests: Monday 26 October 2026, two hours after the Daily Scan. */
export const T0 = "2026-10-26T12:00:00.000Z";

export const picksFixture: PicksOutput = {
  scans: {
    daily: {
      at: "2026-10-26T10:00:00.000Z",
      date: "2026-10-26",
      outcome: "briefing",
      reason: null,
      sources: [
        { name: "arxiv", ok: true, error: null },
        { name: "semantic-scholar", ok: true, error: null },
      ],
    },
    weekly: { at: "2026-10-26T10:05:00.000Z", week: "2026-W44", outcome: "briefing", reason: null },
  },
  keeps: { failing: [] },
  week: "2026-W44",
  picks: [
    {
      id: "arxiv:2610.32109",
      title: "Context windows that remember",
      url: "https://arxiv.org/abs/2610.32109",
      date: "2026-10-26",
      interests: ["Context management in AI"],
      wildcard: false,
      why: "Extends compaction to tool results.",
      kept: false,
      keptAt: null,
      briefing: "Research/Briefings/Daily/2026-10-26 Daily Briefing.md",
    },
    {
      id: "arxiv:2610.30001",
      title: "Sleep and memory consolidation",
      url: "https://arxiv.org/abs/2610.30001",
      date: "2026-10-26",
      interests: [],
      wildcard: true,
      why: "Outside the usual Interests, but close to agents' memory.",
      kept: true,
      keptAt: "2026-10-26T11:30:00.000Z",
      briefing: "Research/Briefings/Daily/2026-10-26 Daily Briefing.md",
    },
  ],
};

/** An executable stand-in for `paper-bot`: prints `output.json`, or fails as `mode` says, and logs its arguments. */
export function fakePaperBot(dir: string) {
  const command = path.join(dir, "paper-bot");
  const fixture = path.join(dir, "output.json");
  const mode = path.join(dir, "mode");
  const callsFile = path.join(dir, "calls.jsonl");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
const mode = fs.readFileSync(path.join(__dirname, "mode"), "utf8");
if (mode === "fail") { console.error("cannot read the paper-bot store"); process.exit(2); }
if (mode === "garbage") { console.log("not JSON"); process.exit(0); }
if (mode === "hang") { setInterval(() => {}, 1000); }
else { process.stdout.write(fs.readFileSync(path.join(__dirname, "output.json"))); }
`,
  );
  chmodSync(command, 0o755);
  writeFileSync(callsFile, "");
  writeFileSync(mode, "normal");
  const write = (output: unknown) => writeFileSync(fixture, JSON.stringify(output));
  write(picksFixture);
  return {
    command,
    mode,
    /** Has the next read print `output`. */
    write,
    calls: (): string[][] =>
      readFileSync(callsFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
