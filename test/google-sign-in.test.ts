import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SCOPES } from "../src/google-calendar/api.js";
import { HEALTH_SCOPES } from "../src/google-health/api.js";
import { signIn } from "../src/google/sign-in.js";
import { createAdapters, parseConfig } from "../src/hub/config.js";
import { DRIVE_SCOPES } from "../src/google-drive/api.js";
import { googleScopes } from "../src/hub/google-sources.js";
import { startHub } from "../src/hub/hub.js";
import { resolveGoogleTokenPath } from "../src/hub/paths.js";
import { CLIENT_ID, FakeGoogle, writeClientFile } from "./google-helper.js";

describe("manao auth google", () => {
  let dir: string;
  let fake: FakeGoogle;
  let clientFile: string;
  let tokenFile: string;
  let printed: string[];
  let page: Promise<{ status: number; text: string }> | undefined;
  const clock = new Date("2026-10-21T16:00:00.000Z");

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-sign-in-"));
    fake = await new FakeGoogle().listen();
    // Where the hub looks for the token, kept off the real one.
    vi.stubEnv("XDG_DATA_HOME", dir);
    clientFile = path.join(dir, "google.client.json");
    tokenFile = resolveGoogleTokenPath();
    writeClientFile(clientFile, fake.endpoints);
    printed = [];
    page = undefined;
  });
  afterEach(async () => {
    await fake.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Follows the consent URL as a browser would, back to the loopback; `tamper` edits the redirect first. */
  const browser =
    (tamper: (redirect: URL) => void = () => {}) =>
    (url: string) => {
      page = (async () => {
        const consent = await fetch(url, { redirect: "manual" });
        const redirect = new URL(consent.headers.get("location") ?? "");
        tamper(redirect);
        const reply = await fetch(redirect);
        return { status: reply.status, text: await reply.text() };
      })();
    };
  const run = (over: { openBrowser?: (url: string) => void; port?: number; scopes?: readonly string[] } = {}) =>
    signIn({
      clientFile,
      tokenFile,
      scopes: over.scopes ?? CALENDAR_SCOPES,
      endpoints: fake.endpoints,
      now: () => clock,
      port: over.port ?? 0,
      openBrowser: over.openBrowser ?? browser(),
      print: (line) => printed.push(line),
    });
  const output = () => printed.join("\n");

  it("signs in through the loopback with PKCE and writes the token owner-only", async () => {
    await run();

    const [authorize] = fake.requestsTo("/o/oauth2/v2/auth");
    const query = Object.fromEntries(authorize!.query);
    expect(query).toMatchObject({
      client_id: CLIENT_ID,
      response_type: "code",
      scope: CALENDAR_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      state: expect.stringMatching(/^[\w-]{20,}$/),
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    });
    expect(output()).toContain(fake.endpoints.authorize);

    const token = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(token).toEqual({
      accessToken: expect.stringMatching(/^fake-access-/),
      refreshToken: "fake-refresh-2",
      expiresAt: new Date(clock.getTime() + 3_599_000).toISOString(),
      scopes: [...CALENDAR_SCOPES],
    });
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(tokenFile))).toEqual(["google-token.json"]);
    for (const scope of CALENDAR_SCOPES) expect(output()).toContain(scope);
    expect(output()).toContain(tokenFile);
    expect(await page).toMatchObject({ status: 200, text: expect.stringContaining("Signed in") });
  });

  it("ignores what reaches the loopback first without this sign-in's answer, and keeps waiting", async () => {
    const get = (port: number, target: string, host = `127.0.0.1:${port}`) =>
      new Promise<number>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: target, headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on("error", reject);
      });
    let strays: Promise<number[]> | undefined;
    const signingIn = run({
      openBrowser: (url) => {
        const port = Number(new URL(new URL(url).searchParams.get("redirect_uri") ?? "").port);
        strays = (async () => {
          const answers = [
            await get(port, "/?state=forged&code=x", `evil.test:${port}`),
            await get(port, "/?state=forged&code=x", "127.0.0.1"),
            await get(port, "/favicon.ico?state=forged"),
            await get(port, "/"),
            await get(port, "/?code=x"),
            await get(port, "/?error=access_denied"),
          ];
          browser()(url);
          return answers;
        })();
      },
    });

    await signingIn;

    expect(await strays).toEqual([404, 404, 404, 404, 404, 404]);
    expect(await page).toMatchObject({ status: 200 });
    expect(JSON.parse(readFileSync(tokenFile, "utf8")).refreshToken).toBe("fake-refresh-2");
  });

  it("names the token file under the home directory as ~/", async () => {
    vi.stubEnv("HOME", dir);

    await run();

    expect(output()).toContain("Token written to ~/manao/google-token.json.");
  });

  it("replaces the token when run again", async () => {
    await run();
    const first = JSON.parse(readFileSync(tokenFile, "utf8"));

    await run();

    const second = JSON.parse(readFileSync(tokenFile, "utf8"));
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(readdirSync(path.dirname(tokenFile))).toEqual(["google-token.json"]);
  });

  it.each([
    [
      "a wrong state",
      /did not carry this sign-in's state/,
      () => ({ openBrowser: browser((redirect) => redirect.searchParams.set("state", "forged")) }),
    ],
    [
      "a denied consent",
      /Google did not grant access \(access_denied\)/,
      () => {
        fake.consent = "deny";
        return {};
      },
    ],
    [
      "a scope left unticked",
      new RegExp(`Google did not grant ${CALENDAR_SCOPES[1]!.replaceAll(".", "\\.")};`),
      () => {
        fake.grantedScopes = [CALENDAR_SCOPES[0]!];
        return {};
      },
    ],
  ])("refuses %s, says so in the browser, and keeps the earlier token", async (_name, message, arrange) => {
    await run();
    const before = readFileSync(tokenFile, "utf8");

    await expect(run(arrange())).rejects.toThrow(message);

    expect(readFileSync(tokenFile, "utf8")).toBe(before);
    expect(readdirSync(path.dirname(tokenFile))).toEqual(["google-token.json"]);
    expect(await page).toMatchObject({ status: 400, text: expect.stringMatching(/^Sign-in failed: /) });
  });

  it.each([
    ["missing", () => rmSync(clientFile), "not found"],
    [
      "malformed",
      () => writeFileSync(clientFile, JSON.stringify({ web: { client_id: CLIENT_ID } })),
      "not a Desktop OAuth client JSON from Cloud Console",
    ],
  ])("refuses a %s client file before opening the browser", async (_name, breakIt, reason) => {
    breakIt();
    let opened = false;

    await expect(run({ openBrowser: () => (opened = true) })).rejects.toMatchObject({
      kind: "client",
      message: `Google client file ${clientFile}: ${reason}`,
    });

    expect(opened).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);
  });

  describe("with the scopes of the enabled Google Sources", () => {
    const scopesFor = (sources: object) => googleScopes(parseConfig({ google: { client: clientFile }, sources }));

    it.each([
      ["the Calendar", { googleCalendar: {} }, [...CALENDAR_SCOPES, ...DRIVE_SCOPES]],
      ["Health", { googleHealth: {} }, [...HEALTH_SCOPES, ...DRIVE_SCOPES]],
      ["both", { googleCalendar: {}, googleHealth: {} }, [...CALENDAR_SCOPES, ...HEALTH_SCOPES, ...DRIVE_SCOPES]],
      ["neither", { herdr: {} }, []],
    ])("asks for the scopes of %s, plus drive.file for the digest when any", (_name, sources, scopes) => {
      expect(scopesFor(sources)).toEqual(scopes);
    });

    it("asks Google for every enabled Source's scopes at once, and writes them all", async () => {
      const scopes = scopesFor({ googleCalendar: {}, googleHealth: {} });
      fake.grantedScopes = scopes;

      await run({ scopes });

      const [authorize] = fake.requestsTo("/o/oauth2/v2/auth");
      expect(authorize!.query.get("scope")).toBe([...CALENDAR_SCOPES, ...HEALTH_SCOPES, ...DRIVE_SCOPES].join(" "));
      expect(JSON.parse(readFileSync(tokenFile, "utf8")).scopes).toEqual([...CALENDAR_SCOPES, ...HEALTH_SCOPES, ...DRIVE_SCOPES]);
    });

    it("refuses a consent that leaves out Health's scopes and writes nothing", async () => {
      fake.grantedScopes = [...CALENDAR_SCOPES, ...DRIVE_SCOPES];

      await expect(run({ scopes: scopesFor({ googleCalendar: {}, googleHealth: {} }) })).rejects.toThrow(
        `Google did not grant ${HEALTH_SCOPES.join(", ")}; nothing was written.`,
      );
      expect(existsSync(tokenFile)).toBe(false);
    });
  });

  it("refuses a port that is taken, naming it", async () => {
    const taken = http.createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as AddressInfo).port;
    let opened = false;
    try {
      await expect(run({ port, openBrowser: () => (opened = true) })).rejects.toThrow(`port ${port} is in use`);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
    expect(opened).toBe(false);
    expect(existsSync(tokenFile)).toBe(false);
  });

  it("turns a running hub from not connected to Healthy on its next fetch, with no restart", async () => {
    const config = parseConfig({ google: { client: clientFile }, sources: { googleCalendar: {} }, api: false });
    const [adapter] = createAdapters(config, () => clock, { googleEndpoints: fake.endpoints });
    const hub = await startHub({
      dbPath: path.join(dir, "hub.db"),
      adapters: [adapter!],
      eventRetentionDays: 30,
      api: false,
      now: () => clock,
      log: () => {},
    });
    const health = () => hub.store.health.list().find((h) => h.source === "google-calendar:primary");
    try {
      expect(health()).toMatchObject({ ok: false, error: "not connected: run `manao auth google`" });

      await run();
      await adapter!.refresh();

      expect(health()).toMatchObject({ ok: true, healthy: true });
    } finally {
      await hub.stop();
    }
  });
});
