import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HubEvent, SourceAdapter } from "../src/core/types.js";
import { type CommandSourceConfig, createAdapters, parseConfig } from "../src/hub/config.js";
import { type Hub, startHub } from "../src/hub/hub.js";
import { PaperBotAdapter } from "../src/paper-bot/adapter.js";
import { MemorySink, waitFor } from "./helpers.js";
import { fakePaperBot, picksFixture, T0 } from "./paper-bot-helper.js";

const SOURCE = "paper-bot:picks";
/** Each read spawns the fake, a Node process; under the full suite's load a few take seconds, not the default wait. */
const SPAWNS_UNDER_LOAD_MS = 10_000;

describe("paper-bot hub seam", () => {
  let dir: string;
  let fake: ReturnType<typeof fakePaperBot>;
  let hub: Hub | undefined;
  let clock: Date;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-paper-"));
    fake = fakePaperBot(dir);
    clock = new Date(T0);
  });
  afterEach(async () => {
    await hub?.stop();
    hub = undefined;
    rmSync(dir, { recursive: true, force: true });
  });
  const start = async (options: Partial<CommandSourceConfig> = {}, api: false | { port: number } = false) => {
    const config = parseConfig({ sources: { paperBot: { command: fake.command, ...options } }, api: false });
    const adapter = createAdapters(config, () => clock)[0]!;
    hub = await startHub({ dbPath: path.join(dir, "hub.db"), adapters: [adapter], now: () => clock, eventRetentionDays: 30, api, log: () => {} });
    return adapter;
  };
  const papers = () => hub!.store.items.list({ type: "paper" });
  const health = () => hub!.store.health.list()[0];

  it("stores this week's Picks as paper Items in paper-bot's order, never with Attention", async () => {
    // #when
    await start();

    // #then
    expect(fake.calls()).toEqual([["picks", "--json"]]);
    expect(papers()).toEqual([
      expect.objectContaining({
        id: "paper-bot:arxiv:2610.32109",
        status: "picked",
        attention: false,
        data: expect.objectContaining({ interests: ["Context management in AI"], wildcard: false, keptAt: null }),
      }),
      {
        source: SOURCE,
        type: "paper",
        id: "paper-bot:arxiv:2610.30001",
        title: "Sleep and memory consolidation",
        status: "kept",
        attention: false,
        updatedAt: T0,
        sourceOk: true,
        lastOkAt: T0,
        data: {
          title: "Sleep and memory consolidation",
          url: "https://arxiv.org/abs/2610.30001",
          date: "2026-10-26",
          interests: [],
          wildcard: true,
          why: "Outside the usual Interests, but close to agents' memory.",
          briefing: "Research/Briefings/Daily/2026-10-26 Daily Briefing.md",
          keptAt: "2026-10-26T11:30:00.000Z",
        },
      },
    ]);
    expect(health()).toMatchObject({ source: SOURCE, ok: true, healthy: true });
  });

  it("replaces last week's Picks with the new week's when the week rolls over", async () => {
    // #given
    const adapter = await start();
    const nextWeek = {
      ...picksFixture,
      week: "2026-W45",
      picks: [{ ...picksFixture.picks[0]!, id: "arxiv:2611.00042", title: "Next week's Pick", date: "2026-11-02" }],
    };
    fake.write(nextWeek);

    // #when
    await adapter.refresh();

    // #then
    expect(papers().map((paper) => [paper.id, paper.title])).toEqual([["paper-bot:arxiv:2611.00042", "Next week's Pick"]]);
  });

  describe("Health follows paper-bot's Scans", () => {
    const { daily, weekly } = picksFixture.scans;
    const failing = { id: "arxiv:2610.11111", title: "A lost Pick", error: "vault not writable", since: "2026-10-25T06:00:00.000Z" };

    it.each([
      ["a failed Daily Scan", { scans: { daily: { ...daily!, outcome: "failed", reason: "every source failed" }, weekly } }, "Daily Scan failed: every source failed"],
      ["a failed Daily Scan with no reason", { scans: { daily: { ...daily!, outcome: "failed", reason: null }, weekly } }, "Daily Scan failed"],
      ["no Daily Scan yet", { scans: { daily: null, weekly } }, "no Daily Scan yet"],
      ["a Daily Scan 26 hours old", { scans: { daily: { ...daily!, at: "2026-10-25T10:00:00.000Z" }, weekly } }, "last Daily Scan at 2026-10-25T10:00:00.000Z, 26 hours or more ago"],
      ["a failed Weekly Scan", { scans: { daily, weekly: { ...weekly!, outcome: "failed", reason: "no Picks to rank" } } }, "Weekly Scan failed: no Picks to rank"],
      ["a failing Keep", { keeps: { failing: [failing] } }, "Keep failing since 2026-10-25T06:00:00.000Z: A lost Pick (vault not writable)"],
    ])("is not Healthy after %s, naming it, and still stores the week's Picks", async (_name, change, error) => {
      // #given
      fake.write({ ...picksFixture, ...change });

      // #when
      await start();

      // #then
      expect(health()).toMatchObject({ ok: false, healthy: false, error });
      expect(papers().map((paper) => [paper.id, paper.sourceOk])).toEqual([
        ["paper-bot:arxiv:2610.32109", false],
        ["paper-bot:arxiv:2610.30001", false],
      ]);
    });

    it("names every reason at once", async () => {
      // #given
      fake.write({ ...picksFixture, scans: { daily: null, weekly: { ...weekly!, outcome: "failed", reason: null } }, keeps: { failing: [failing] } });

      // #when
      await start();

      // #then
      expect(health()?.error).toBe(
        "no Daily Scan yet; Weekly Scan failed; Keep failing since 2026-10-25T06:00:00.000Z: A lost Pick (vault not writable)",
      );
    });

    it.each([
      ["a skipped Daily Scan", { scans: { daily: { ...daily!, outcome: "skipped", reason: "nothing cleared the bar" }, weekly } }],
      ["a skipped Weekly Scan", { scans: { daily, weekly: { ...weekly!, outcome: "skipped", reason: "no Picks this week" } } }],
      ["no Weekly Scan yet", { scans: { daily, weekly: null } }],
      ["a Daily Scan just under 26 hours old", { scans: { daily: { ...daily!, at: "2026-10-25T10:00:01.000Z" }, weekly } }],
    ])("stays Healthy after %s", async (_name, change) => {
      // #given
      fake.write({ ...picksFixture, ...change });

      // #when
      await start();

      // #then
      expect(health()).toMatchObject({ ok: true, healthy: true });
      expect(health()?.error).toBeUndefined();
    });

    it("stays Healthy when some sources failed but the Scan did not, naming them in the note", async () => {
      // #given
      const sources = [
        { name: "arxiv", ok: false, error: "HTTP 503" },
        { name: "semantic-scholar", ok: true, error: null },
        { name: "openreview", ok: false, error: null },
      ];
      fake.write({ ...picksFixture, scans: { daily: { ...daily!, sources }, weekly } });

      // #when
      await start();

      // #then
      expect(health()).toMatchObject({ ok: true, healthy: true, note: "Daily Scan sources failed: arxiv (HTTP 503), openreview" });
    });

    it("still names the failed sources in the note when the Daily Scan itself failed", async () => {
      // #given
      const sources = [{ name: "arxiv", ok: false, error: "HTTP 503" }];
      fake.write({ ...picksFixture, scans: { daily: { ...daily!, outcome: "failed", reason: "every source failed", sources }, weekly } });

      // #when
      await start();

      // #then
      expect(health()).toMatchObject({ ok: false, error: "Daily Scan failed: every source failed", note: "Daily Scan sources failed: arxiv (HTTP 503)" });
    });

    it("measures the Daily Scan's age on the hub's clock at each poll", async () => {
      // #given
      const adapter = await start();
      clock = new Date("2026-10-27T12:00:00.000Z");

      // #when
      await adapter.refresh();

      // #then
      expect(health()).toMatchObject({ ok: false, error: "last Daily Scan at 2026-10-26T10:00:00.000Z, 26 hours or more ago" });
    });
  });

  describe("a failed read", () => {
    it.each([
      ["a non-zero exit", "fail", "exited with code 2: cannot read the paper-bot store"],
      ["output that is not JSON", "garbage", "unparseable output (not JSON)"],
    ])("keeps the last Picks Stale on %s, naming the cause, and recovers on the next good read", async (_name, mode, error) => {
      // #given
      const adapter = await start();
      fake.write({ ...picksFixture, picks: [] });
      writeFileSync(fake.mode, mode);
      clock = new Date("2026-10-26T12:15:00.000Z");

      // #when
      await adapter.refresh();

      // #then
      expect(papers().map((paper) => [paper.id, paper.sourceOk, paper.lastOkAt])).toEqual([
        ["paper-bot:arxiv:2610.32109", false, T0],
        ["paper-bot:arxiv:2610.30001", false, T0],
      ]);
      expect(health()).toMatchObject({ ok: false, healthy: false, error: expect.stringContaining(error) });

      // #when
      writeFileSync(fake.mode, "normal");
      await adapter.refresh();

      // #then
      expect(health()).toMatchObject({ ok: true, healthy: true, lastOkAt: clock.toISOString() });
      expect(papers()).toEqual([]);
    });

    it.each([
      ["a Pick with an unknown field type", { ...picksFixture, picks: [{ ...picksFixture.picks[0]!, wildcard: "no" }] }],
      ["a Pick without an id", { ...picksFixture, picks: [{ ...picksFixture.picks[0]!, id: "" }] }],
      ["a Pick date that is not a date", { ...picksFixture, picks: [{ ...picksFixture.picks[0]!, date: "Monday" }] }],
      ["the same Pick twice", { ...picksFixture, picks: [picksFixture.picks[0]!, picksFixture.picks[0]!] }],
      ["an unknown Scan outcome", { ...picksFixture, scans: { ...picksFixture.scans, daily: { ...picksFixture.scans.daily!, outcome: "partial" } } }],
      ["a Scan time that is not a time", { ...picksFixture, scans: { ...picksFixture.scans, weekly: { ...picksFixture.scans.weekly!, at: "Monday" } } }],
      ["no keeps", { ...picksFixture, keeps: undefined }],
      ["no picks", { ...picksFixture, picks: undefined }],
    ])("rejects output outside the contract (%s), keeping the last Picks Stale", async (_name, output) => {
      // #given
      const adapter = await start();
      fake.write(output);

      // #when
      await adapter.refresh();

      // #then
      expect(health()).toMatchObject({
        ok: false,
        error: expect.stringContaining("output does not match the paper-bot picks contract:"),
      });
      expect(papers().map((paper) => paper.sourceOk)).toEqual([false, false]);
    });

    it("bounds a hung command", async () => {
      // #given
      await start();
      await hub!.stop();
      hub = undefined;
      writeFileSync(fake.mode, "hang");
      const adapter = new PaperBotAdapter({ command: fake.command, timeoutMs: 300, now: () => clock });

      // #when
      hub = await startHub({ dbPath: path.join(dir, "hub.db"), adapters: [adapter], now: () => clock, eventRetentionDays: 30, api: false, log: () => {} });

      // #then
      expect(health()).toMatchObject({ ok: false, error: "timed out after 300ms" });
      expect(papers()).toHaveLength(2);
    }, SPAWNS_UNDER_LOAD_MS);

    it("reports a missing command without failing startup", async () => {
      // #given
      rmSync(fake.command);

      // #when
      await start();

      // #then
      expect(health()).toMatchObject({ ok: false, error: `command not found: ${fake.command}` });
    });
  });

  it("goes Stale after 3 missed polls by default", async () => {
    // #given
    await start({ intervalSeconds: 900 });

    // #when
    clock = new Date(Date.parse(T0) + 3 * 900_000 + 1);

    // #then
    expect(health()).toMatchObject({ ok: true, healthy: false, staleAfterMs: 2_700_000 });
    expect(papers().every((paper) => !paper.sourceOk)).toBe(true);
  });

  it("polls on the configured cadence with the configured staleness limit", async () => {
    // #given
    await start({ intervalSeconds: 0.05, staleAfterSeconds: 5 });

    // #when
    await waitFor(() => fake.calls().length >= 3, SPAWNS_UNDER_LOAD_MS);

    // #then
    expect(health()?.staleAfterMs).toBe(5000);
    expect(new Set(fake.calls().map((args) => args.join(" ")))).toEqual(new Set(["picks --json"]));
  }, 2 * SPAWNS_UNDER_LOAD_MS);

  it("coalesces concurrent refreshes", async () => {
    // #given
    const adapter = await start();

    // #when
    await Promise.all([adapter.refresh(), adapter.refresh(), adapter.refresh()]);

    // #then
    expect(fake.calls()).toHaveLength(3);
  });

  it("stops polling before the store closes", async () => {
    // #given
    await start({ intervalSeconds: 0.05 });
    await waitFor(() => fake.calls().length >= 2, SPAWNS_UNDER_LOAD_MS);

    // #when
    await hub!.stop();
    hub = undefined;
    const count = fake.calls().length;
    await new Promise((resolve) => setTimeout(resolve, 500));

    // #then
    expect(fake.calls()).toHaveLength(count);
  }, 2 * SPAWNS_UNDER_LOAD_MS);

  it("serves the Picks through /api/items with sourceOk and lastOkAt", async () => {
    // #given
    await start({}, { port: 0 });

    // #when
    const response = await fetch(`${hub!.apiUrl}/api/items?type=paper`);

    // #then
    expect(await response.json()).toEqual({
      now: T0,
      items: [
        expect.objectContaining({ source: SOURCE, id: "paper-bot:arxiv:2610.32109", status: "picked", sourceOk: true, lastOkAt: T0 }),
        expect.objectContaining({ source: SOURCE, id: "paper-bot:arxiv:2610.30001", status: "kept", sourceOk: true, lastOkAt: T0 }),
      ],
    });
  });

  it("keeps the Picks off /api/agenda", async () => {
    // #given
    await start({}, { port: 0 });

    // #when
    const response = await fetch(`${hub!.apiUrl}/api/agenda`);

    // #then
    expect(await response.json()).toEqual({ now: T0, attention: [], appointments: [], todos: [], staleSources: [] });
  });

  it("stores an empty week as no Items, Healthy", async () => {
    // #given
    const adapter = await start();
    fake.write({ ...picksFixture, week: "2026-W45", picks: [] });

    // #when
    await adapter.refresh();

    // #then
    expect(papers()).toEqual([]);
    expect(health()?.healthy).toBe(true);
  });

  describe("Events", () => {
    const { daily, weekly } = picksFixture.scans;
    const [picked, kept] = picksFixture.picks;
    const events = () => hub!.store.events.after(0).map((event) => [event.kind, event.data]);
    const restart = async () => {
      await hub!.stop();
      return start();
    };
    const keptNow = { ...picksFixture, picks: [{ ...picked!, kept: true, keptAt: "2026-10-26T12:10:00.000Z" }, kept!] };
    const nextDaily = {
      ...picksFixture,
      scans: { daily: { ...daily!, at: "2026-10-27T10:00:00.000Z", date: "2026-10-27", outcome: "skipped", reason: "nothing cleared the bar" }, weekly },
    };
    const dailyScan = ["scan.daily", { at: daily!.at, date: "2026-10-26", outcome: "briefing", reason: null }];
    const weeklyScan = ["scan.weekly", { at: weekly!.at, week: "2026-W44", outcome: "briefing", reason: null }];
    const keep = [
      "paper.kept",
      { id: "paper-bot:arxiv:2610.32109", title: picked!.title, url: picked!.url, date: "2026-10-26", keptAt: "2026-10-26T12:10:00.000Z" },
    ];

    it("records each Scan result once on the first read, and no Keeps for Picks already kept", async () => {
      // #when
      await start();

      // #then
      expect(events()).toEqual([dailyScan, weeklyScan]);
    });

    it("records nothing more when polling again finds the same Scans and Picks", async () => {
      // #given
      const adapter = await start();

      // #when
      await adapter.refresh();
      await adapter.refresh();

      // #then
      expect(events()).toEqual([dailyScan, weeklyScan]);
    });

    it("records a new Scan result when its `at` changes, on the hub's clock", async () => {
      // #given
      const adapter = await start();
      fake.write(nextDaily);
      clock = new Date("2026-10-27T10:15:00.000Z");

      // #when
      await adapter.refresh();
      await adapter.refresh();

      // #then
      expect(hub!.store.events.after(0).slice(2).map((event) => [event.kind, event.at, event.data])).toEqual([
        ["scan.daily", "2026-10-27T10:15:00.000Z", { at: "2026-10-27T10:00:00.000Z", date: "2026-10-27", outcome: "skipped", reason: "nothing cleared the bar" }],
      ]);
    });

    it("records one Keep when a Pick changes to kept", async () => {
      // #given
      const adapter = await start();
      fake.write(keptNow);

      // #when
      await adapter.refresh();
      await adapter.refresh();

      // #then
      expect(events()).toEqual([dailyScan, weeklyScan, keep]);
    });

    it("repeats no Scan or Keep after a restart", async () => {
      // #given
      const adapter = await start();
      fake.write(keptNow);
      await adapter.refresh();

      // #when
      await restart();

      // #then
      expect(events()).toEqual([dailyScan, weeklyScan, keep]);
    });

    it("records what changed while the hub was down once it restarts", async () => {
      // #given
      await start();
      await hub!.stop();
      fake.write({ ...nextDaily, picks: keptNow.picks });

      // #when
      await start();

      // #then
      expect(events().map(([kind]) => kind)).toEqual(["scan.daily", "scan.weekly", "scan.daily", "paper.kept"]);
    });

    it("is not Healthy when its Events cannot be recorded, and records them on the next read", async () => {
      // #given
      let refuse = true;
      const sink = new (class extends MemorySink {
        override emitEvents(events: HubEvent[]): void {
          if (refuse) throw new Error("store unavailable");
          super.emitEvents(events);
        }
      })();
      const adapter = new PaperBotAdapter({ command: fake.command, now: () => clock });
      await adapter.start(sink);
      expect(sink.lastHealth).toMatchObject({ ok: false, error: "could not record Events: store unavailable" });

      // #when
      refuse = false;
      await adapter.refresh();
      await adapter.stop();

      // #then
      expect(sink.events.map((event) => event.kind)).toEqual(["scan.daily", "scan.weekly"]);
      expect(sink.lastHealth?.ok).toBe(true);
    });

    describe("a refused write followed by a restart", () => {
      const bothPicked = { ...picksFixture, picks: [picked!, { ...kept!, kept: false, keptAt: null }] };
      const bothKept = { ...picksFixture, picks: [keptNow.picks[0]!, kept!] };
      const keepOf = (id: string) => events().filter(([kind, data]) => kind === "paper.kept" && (data as { id: string }).id === id);
      /** Starts the hub with the paper-bot Adapter writing through a sink that throws whenever `refuses` says so. */
      const startRefusing = async (refuses: (method: "replaceItems" | "emitEvents", recorded: readonly HubEvent[]) => boolean) => {
        const adapter = createAdapters(parseConfig({ sources: { paperBot: { command: fake.command } }, api: false }), () => clock)[0]!;
        const recorded: HubEvent[] = [];
        const refusing: SourceAdapter = {
          id: adapter.id,
          refresh: () => adapter.refresh(),
          stop: () => adapter.stop(),
          start: (sink, stored) =>
            adapter.start(
              {
                replaceItems: (source, type, items) => {
                  if (refuses("replaceItems", recorded)) throw new Error("disk full");
                  return sink.replaceItems(source, type, items);
                },
                emitEvents: (events) => {
                  if (refuses("emitEvents", recorded)) throw new Error("disk full");
                  recorded.push(...events);
                  return sink.emitEvents(events);
                },
                reportHealth: (source, report) => sink.reportHealth(source, report),
                writeMeasurements: (source, measurements) => sink.writeMeasurements(source, measurements),
              },
              stored,
            ),
        };
        hub = await startHub({ dbPath: path.join(dir, "hub.db"), adapters: [refusing], now: () => clock, eventRetentionDays: 30, api: false, log: () => {} });
      };

      it("records a Keep whose Event was refused once the hub restarts", async () => {
        // #given
        await start();
        await hub!.stop();
        fake.write(keptNow);
        await startRefusing((method) => method === "emitEvents");
        expect(health()).toMatchObject({ ok: false, error: "could not record Events: disk full" });
        await hub!.stop();

        // #when
        await start();

        // #then
        expect(events()).toEqual([dailyScan, weeklyScan, keep]);
      });

      it("records each Keep once when the Picks' write after it was refused and the hub restarts", async () => {
        // #given
        fake.write(bothPicked);
        await start();
        await hub!.stop();
        fake.write(bothKept);
        await startRefusing((method, recorded) => method === "replaceItems" && recorded.some((event) => event.kind === "paper.kept"));
        expect(health()).toMatchObject({ ok: false, error: "could not store Picks: disk full" });
        await hub!.stop();

        // #when
        await start();

        // #then
        expect(keepOf("paper-bot:arxiv:2610.32109")).toHaveLength(1);
        expect(keepOf("paper-bot:arxiv:2610.30001")).toHaveLength(1);
        expect(papers().map((paper) => paper.status)).toEqual(["kept", "kept"]);
      });
    });

    it("records nothing for a failed read, and the Events it missed on the next good one", async () => {
      // #given
      const adapter = await start();
      fake.write({ ...nextDaily, picks: keptNow.picks });
      writeFileSync(fake.mode, "fail");
      await adapter.refresh();
      expect(events()).toEqual([dailyScan, weeklyScan]);

      // #when
      writeFileSync(fake.mode, "normal");
      await adapter.refresh();

      // #then
      expect(events().map(([kind]) => kind)).toEqual(["scan.daily", "scan.weekly", "scan.daily", "paper.kept"]);
    });
  });
});
