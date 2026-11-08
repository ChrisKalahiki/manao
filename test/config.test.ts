import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/hub/config.js";
import { type Hub, startHubFromConfig } from "../src/hub/hub.js";
import { resolveConfigPath, resolveDbPath } from "../src/hub/paths.js";
import { FakeHerdrCore, terminal, waitFor } from "./helpers.js";

describe("hub config", () => {
  let dir: string;
  let server: FakeHerdrCore;
  let hub: Hub | undefined;

  const writeConfig = (config: unknown) => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  };
  // The API is off so no test binds its real port; test/api.test.ts covers it.
  const start = (file: string, now?: () => Date) =>
    startHubFromConfig({ ...loadConfig(file), api: false }, { dbPath: ":memory:", now, log: () => {} });

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-config-"));
    server = await new FakeHerdrCore().listen();
    server.terminals = [terminal({ address: "t1", status: "blocked" })];
    // Keeps every test off the real herdr-core socket: the default one is the fake's.
    vi.stubEnv("XDG_STATE_HOME", server.stateHome);
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    await server.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs Herdr on the default herdr-core socket with default options when there is no config file", async () => {
    const config = loadConfig(path.join(dir, "missing.json"));

    expect(config).toEqual({
      sources: { herdr: { intervalSeconds: 5, events: true } },
      eventRetentionDays: 30,
      api: { port: 7420 },
    });
    hub = await start(path.join(dir, "missing.json"));
    expect(hub.store.items.list().map((i) => [i.source, i.id])).toEqual([["herdr:local", "t1"]]);
    await waitFor(() => server.subscribeCount === 1);
  });

  it("passes a file's Herdr options to the Adapter", async () => {
    vi.stubEnv("XDG_STATE_HOME", path.join(dir, "no-core-here"));
    const file = writeConfig({
      sources: { herdr: { socketPath: server.socketPath, intervalSeconds: 0.01, events: false } },
    });

    hub = await start(file);
    await waitFor(() => server.lists >= 3);

    expect(hub.store.items.list().map((i) => [i.source, i.id])).toEqual([["herdr:local", "t1"]]);
    expect(server.methods).not.toContain("events.subscribe");
  });

  it("runs the Adapters on the hub's clock", async () => {
    const now = new Date("2026-10-19T08:00:00.000Z");

    hub = await start(writeConfig({ sources: { herdr: { events: false } } }), () => now);

    expect(hub.store.health.list().map((h) => [h.at, h.healthy])).toEqual([[now.toISOString(), true]]);
  });

  it.each([
    ["the configured staleness limit", { intervalSeconds: 2, staleAfterSeconds: 60 }, 60_000],
    ["3x the interval by default", { intervalSeconds: 2 }, 6000],
  ])("gives Herdr Health reports %s", async (_name, herdr, staleAfterMs) => {
    hub = await start(writeConfig({ sources: { herdr: { ...herdr, events: false } } }));

    expect(hub.store.health.list().map((h) => [h.source, h.ok, h.staleAfterMs])).toEqual([
      ["herdr:local", true, staleAfterMs],
    ]);
  });

  it.each([
    ["an unknown Source", { sources: { obsidian: {} } }, /sources\.obsidian is not a known Source/],
    ["a wrong type", { sources: { herdr: { intervalSeconds: "5" } } }, /sources\.herdr\.intervalSeconds must be a positive number/],
    ["an unknown option", { sources: { herdr: { interval: 5 } } }, /sources\.herdr\.interval is not a known option/],
    ["Herdr 0.9.5's session", { sources: { herdr: { session: "work" } } }, /sources\.herdr\.session is not a known option/],
    ["a relative socket path", { sources: { herdr: { socketPath: "hc.sock" } } }, /sources\.herdr\.socketPath must be an absolute path/],
    ["a negative retention", { eventRetentionDays: -1 }, /eventRetentionDays must be a positive whole number/],
    ["a fractional retention", { eventRetentionDays: 1.5 }, /eventRetentionDays must be a positive whole number/],
    ["a relative database path", { dbPath: "hub.db" }, /dbPath must be an absolute path/],
    ["a non-object", [], /config must be an object/],
    ["the API switched on with true", { api: true }, /api must be false or an object/],
    ["an unknown API option", { api: { host: "0.0.0.0" } }, /api\.host is not a known option/],
    ["a fractional API port", { api: { port: 74.2 } }, /api\.port must be a whole number from 0 to 65535/],
    ["an API port out of range", { api: { port: 70_000 } }, /api\.port must be a whole number from 0 to 65535/],
    ["an API port as a string", { api: { port: "7420" } }, /api\.port must be a whole number from 0 to 65535/],
  ])("refuses to start with %s, naming the field", async (_name, config, message) => {
    const file = writeConfig(config);

    await expect(async () => start(file)).rejects.toThrow(message);
    await expect(async () => start(file)).rejects.toThrow(file);
  });

  it.each([
    ["off", { api: false }, false],
    ["on the default port", { api: {} }, { port: 7420 }],
    ["on a chosen port", { api: { port: 8080 } }, { port: 8080 }],
  ])("reads the API %s", (_name, config, api) => {
    expect(loadConfig(writeConfig(config)).api).toEqual(api);
  });

  it("refuses to start when the file is not JSON", async () => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, "{ sources: }");

    await expect(async () => start(file)).rejects.toThrow(/not valid JSON/);
  });
});

describe("Brain-Dump config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-brain-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (config: unknown) => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  };
  it("reads every Brain-Dump option, expanding home paths", () => {
    expect(
      loadConfig(
        writeConfig({
          sources: {
            brainDump: {
              command: "~/bin/brain-dump",
              intervalSeconds: 2.5,
              staleAfterSeconds: 11,
            },
          },
        }),
      ).sources.brainDump,
    ).toEqual({
      command: path.join(os.homedir(), "bin/brain-dump"),
      intervalSeconds: 2.5,
      staleAfterSeconds: 11,
    });
    expect(
      loadConfig(writeConfig({ sources: { brainDump: { intervalSeconds: 2 } } })).sources.brainDump?.staleAfterSeconds,
    ).toBeUndefined();
  });

  it.each([
    ["command", ""],
    ["command", 3],
    ["command", "bin/brain-dump"],
    ["command", "./brain-dump"],
    ["intervalSeconds", 0],
    ["intervalSeconds", -1],
    ["intervalSeconds", "60"],
    ["staleAfterSeconds", 0],
    ["staleAfterSeconds", -1],
    ["staleAfterSeconds", "60"],
    ["unexpected", true],
  ])("rejects Brain-Dump %s=%s, naming the field and file", (field, value) => {
    const file = writeConfig({ sources: { brainDump: { [field]: value } } });
    expect(() => loadConfig(file)).toThrow(`sources.brainDump.${field}`);
    expect(() => loadConfig(file)).toThrow(file);
  });

  it.each([false, null, [], "brain-dump"])("rejects a non-object Brain-Dump config: %s", (brainDump) => {
    expect(() => loadConfig(writeConfig({ sources: { brainDump } }))).toThrow("sources.brainDump must be an object");
  });

  it("enables Brain-Dump only when configured, with defaults", () => {
    expect(loadConfig(writeConfig({})).sources).not.toHaveProperty("brainDump", expect.anything());
    expect(loadConfig(writeConfig({ sources: { brainDump: {} } })).sources).toEqual({
      brainDump: { command: undefined, intervalSeconds: 60, staleAfterSeconds: undefined },
    });
  });
});

describe("paper-bot config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-paper-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (config: unknown) => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  };

  it("enables paper-bot only when configured, polling every 15 minutes", () => {
    expect(loadConfig(writeConfig({})).sources).not.toHaveProperty("paperBot", expect.anything());
    expect(loadConfig(writeConfig({ sources: { paperBot: {} } })).sources).toEqual({
      paperBot: { command: undefined, intervalSeconds: 900, staleAfterSeconds: undefined },
    });
  });

  it.each([
    ["a home path", "~/bin/paper-bot", path.join(os.homedir(), "bin/paper-bot")],
    ["an absolute path", "/opt/paper-bot/bin/paper-bot", "/opt/paper-bot/bin/paper-bot"],
    ["a bare name", "paper-bot", "paper-bot"],
  ])("reads every paper-bot option, with the command as %s", (_name, command, expected) => {
    const paperBot = { command, intervalSeconds: 60, staleAfterSeconds: 600 };

    expect(loadConfig(writeConfig({ sources: { paperBot } })).sources.paperBot).toEqual({ ...paperBot, command: expected });
  });

  it.each([
    ["command", ""],
    ["command", "bin/paper-bot"],
    ["intervalSeconds", 0],
    ["intervalSeconds", "900"],
    ["staleAfterSeconds", -1],
    ["unexpected", true],
  ])("rejects paper-bot %s=%j, naming the field and file", (field, value) => {
    const file = writeConfig({ sources: { paperBot: { [field]: value } } });

    expect(() => loadConfig(file)).toThrow(`sources.paperBot.${field}`);
    expect(() => loadConfig(file)).toThrow(file);
  });

  it.each([false, null, [], "paper-bot"])("rejects a non-object paper-bot config: %j", (paperBot) => {
    expect(() => loadConfig(writeConfig({ sources: { paperBot } }))).toThrow("sources.paperBot must be an object");
  });
});

describe("Google Calendar config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-google-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (config: unknown) => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  };
  const client = { client: "~/secrets/google.client.json" };

  it("enables the Calendar only when configured, reading the primary calendar a week ahead every 5 minutes", () => {
    expect(loadConfig(writeConfig({})).sources).not.toHaveProperty("googleCalendar", expect.anything());
    const config = loadConfig(writeConfig({ google: client, sources: { googleCalendar: {} } }));

    expect(config.google).toEqual({ client: path.join(os.homedir(), "secrets/google.client.json") });
    expect(config.sources).toEqual({
      googleCalendar: { calendars: ["primary"], intervalSeconds: 300, daysAhead: 7, staleAfterSeconds: undefined },
    });
  });

  it("reads every Calendar option", () => {
    const googleCalendar = { calendars: ["primary", "team@example.test"], intervalSeconds: 60, daysAhead: 0, staleAfterSeconds: 600 };

    expect(loadConfig(writeConfig({ google: client, sources: { googleCalendar } })).sources.googleCalendar).toEqual(googleCalendar);
  });

  it.each([
    ["calendars", []],
    ["calendars", "primary"],
    ["calendars", [""]],
    ["calendars", ["primary", "primary"]],
    ["intervalSeconds", 0],
    ["intervalSeconds", "300"],
    ["daysAhead", -1],
    ["daysAhead", 1.5],
    ["staleAfterSeconds", 0],
    ["unexpected", true],
  ])("rejects Calendar %s=%j, naming the field and file", (field, value) => {
    const file = writeConfig({ google: client, sources: { googleCalendar: { [field]: value } } });

    expect(() => loadConfig(file)).toThrow(`sources.googleCalendar.${field}`);
    expect(() => loadConfig(file)).toThrow(file);
  });

  it.each([
    ["no google section", {}, "google.client is required when sources.googleCalendar is enabled"],
    ["no client", { google: {} }, "google.client is required when sources.googleCalendar is enabled"],
    ["a relative client path", { google: { client: "google.client.json" } }, "google.client must be an absolute path"],
    ["an unknown google option", { google: { ...client, accounts: [] } }, "google.accounts is not a known option"],
    ["a non-object google section", { google: "client.json" }, "google must be an object"],
  ])("refuses %s", (_name, config, message) => {
    expect(() => loadConfig(writeConfig({ ...config, sources: { googleCalendar: {} } }))).toThrow(message);
  });
});

describe("Google Health config", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-health-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (config: unknown) => {
    const file = path.join(dir, "config.json");
    writeFileSync(file, JSON.stringify(config));
    return file;
  };
  const google = { client: "~/secrets/google.client.json" };

  it("enables Health only when configured, reading hourly with 30 days of backfill", () => {
    expect(loadConfig(writeConfig({})).sources).not.toHaveProperty("googleHealth", expect.anything());

    expect(loadConfig(writeConfig({ google, sources: { googleHealth: {} } })).sources).toEqual({
      googleHealth: { intervalSeconds: 3600, backfillDays: 30, staleAfterSeconds: undefined },
    });
  });

  it("reads every Health option", () => {
    const googleHealth = { intervalSeconds: 600, backfillDays: 90, staleAfterSeconds: 7200 };

    expect(loadConfig(writeConfig({ google, sources: { googleHealth } })).sources.googleHealth).toEqual(googleHealth);
  });

  it.each([
    ["intervalSeconds", 0],
    ["backfillDays", 0],
    ["backfillDays", 91],
    ["backfillDays", 1.5],
    ["backfillDays", "30"],
    ["staleAfterSeconds", -1],
    ["metrics", ["steps"]],
  ])("rejects Health %s=%j, naming the field and file", (field, value) => {
    const file = writeConfig({ google, sources: { googleHealth: { [field]: value } } });

    expect(() => loadConfig(file)).toThrow(`sources.googleHealth.${field}`);
    expect(() => loadConfig(file)).toThrow(file);
  });

  it("refuses Health without google.client", () => {
    expect(() => loadConfig(writeConfig({ sources: { googleHealth: {} } }))).toThrow(
      "google.client is required when sources.googleHealth is enabled",
    );
  });
});

describe("config.example.json", () => {
  it("is a valid config that spells out every option", () => {
    const example = loadConfig(fileURLToPath(new URL("../config.example.json", import.meta.url)));

    expect(example).toEqual({
      sources: {
        herdr: { intervalSeconds: 5, events: true, staleAfterSeconds: 15 },
        brainDump: { command: "brain-dump", intervalSeconds: 60, staleAfterSeconds: 180 },
        googleCalendar: { calendars: ["primary"], intervalSeconds: 300, daysAhead: 7, staleAfterSeconds: 900 },
        googleHealth: { intervalSeconds: 3600, backfillDays: 30, staleAfterSeconds: 10800 },
        paperBot: { command: "paper-bot", intervalSeconds: 900, staleAfterSeconds: 2700 },
      },
      google: { client: path.join(os.homedir(), ".config/manao/google.client.json") },
      eventRetentionDays: 30,
      api: { port: 7420 },
    });
  });
});

describe("config and database paths", () => {
  const home = os.homedir();

  it.each([
    ["MANAO_CONFIG first", { MANAO_CONFIG: "/etc/manao.json", XDG_CONFIG_HOME: "/xdg" }, "/etc/manao.json"],
    ["then XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "/xdg" }, "/xdg/manao/config.json"],
    ["then ~/.config", {}, path.join(home, ".config", "manao", "config.json")],
  ])("finds the config file: %s", (_name, env, expected) => {
    expect(resolveConfigPath(env)).toBe(expected);
  });

  it.each([
    ["MANAO_DB first", { MANAO_DB: "/env.db" }, "/config.db", "/env.db"],
    ["then the config's dbPath", { XDG_DATA_HOME: "/xdg" }, "/config.db", "/config.db"],
    ["then XDG_DATA_HOME", { XDG_DATA_HOME: "/xdg" }, undefined, "/xdg/manao/hub.db"],
    ["then ~/.local/share", {}, undefined, path.join(home, ".local", "share", "manao", "hub.db")],
  ])("places the database: %s", (_name, env, dbPath, expected) => {
    expect(resolveDbPath(env, { dbPath })).toBe(expected);
  });
});
