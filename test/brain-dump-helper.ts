import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TodosOutput } from "../src/brain-dump/normalize.js";

export const todosFixture: TodosOutput = {
  note: "Research/Weekly Meetings/10-19-26 Weekly Update.md",
  exists: true,
  hash: "fixture",
  todos: [
    { text: "Ship", state: "open", groupPath: ["Work", "Manaʻo"], parentIndex: null, line: 4 },
    { text: "Review", state: "open", groupPath: ["Work", "Manaʻo"], parentIndex: 0, line: 5 },
  ],
};

export function fakeBrainDump(dir: string) {
  const command = path.join(dir, "brain-dump");
  const fixture = path.join(dir, "output.json");
  const callsFile = path.join(dir, "calls.jsonl");
  const vaultRoot = path.join(realpathSync(dir), "vault");
  const vaultMode = path.join(dir, "vault-mode");
  mkdirSync(path.join(vaultRoot, path.dirname(todosFixture.note)), { recursive: true });
  writeFileSync(vaultMode, "normal");
  const mode = path.join(dir, "mode");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "vault") {
  if (fs.readFileSync(path.join(dir, "vault-mode"), "utf8") === "fail") {
    console.error("fixture vault unavailable"); process.exit(8);
  }
  if (fs.readFileSync(path.join(dir, "vault-mode"), "utf8") === "hang") { setInterval(() => {}, 1000); }
  else { console.log(path.join(dir, "vault")); process.exit(0); }
  return;
}
const mode = fs.readFileSync(path.join(dir, "mode"), "utf8");
if (mode === "fail") { console.error("fixture command failed"); process.exit(7); }
if (mode === "garbage") { console.log("not JSON"); process.exit(0); }
if (mode === "hang") { setInterval(() => {}, 1000); }
else { process.stdout.write(fs.readFileSync(path.join(dir, "output.json"))); }
`,
  );
  chmodSync(command, 0o755);
  writeFileSync(callsFile, "");
  writeFileSync(mode, "normal");
  writeFileSync(fixture, JSON.stringify(todosFixture));
  const calls = (): string[][] =>
    readFileSync(callsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    command,
    fixture,
    mode,
    vaultRoot,
    vaultMode,
    calls,
    callsOf: (name: string): string[][] => calls().filter(([command]) => command === name),
  };
}
