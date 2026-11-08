import { describe, expect, it } from "vitest";

describe("package exports", () => {
  it("exposes the public API and keeps each store part's internals private", async () => {
    const exported = Object.keys(await import("../src/index.js")).sort();
    expect(exported).toEqual([
      "AGENT_ITEM_TYPE",
      "ConfigError",
      "EventNudger",
      "FINISHED_ATTENTION_MS",
      "HERDR_SOURCE_ID",
      "HerdrAdapter",
      "HerdrClient",
      "HerdrError",
      "PROTOCOL_GENERATION",
      "READ_ONLY_METHODS",
      "ReadOnlyViolationError",
      "TRANSITION_EVENT_KIND",
      "assertReadOnly",
      "createAdapters",
      "loadConfig",
      "openStore",
      "parseConfig",
      "parseTerminalList",
      "reconcile",
      "resolveConfigPath",
      "resolveDbPath",
      "resolveGoogleTokenPath",
      "resolveSocketPath",
      "sortForDashboard",
      "startHub",
      "startHubFromConfig",
      "toHubStatus",
      "transitionToEvent",
    ]);
  });
});
