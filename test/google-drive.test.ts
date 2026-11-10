import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALENDAR_SCOPES } from "../src/google-calendar/api.js";
import { DRIVE_SCOPES, uploadMarkdown } from "../src/google-drive/api.js";
import { GoogleConnection, GoogleError, writeToken } from "../src/google/oauth.js";
import { FakeGoogle, REFRESH_TOKEN, writeClientFile } from "./google-helper.js";

const FOLDER = "Manao";
const NAME = "Manao daily.md";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

describe("uploading the digest to Google Drive", () => {
  let dir: string;
  let fake: FakeGoogle;
  let google: GoogleConnection;
  let tokenFile: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "manao-drive-"));
    fake = await new FakeGoogle().listen();
    fake.grantedScopes = [...CALENDAR_SCOPES, ...DRIVE_SCOPES];
    const clientFile = path.join(dir, "google.client.json");
    tokenFile = path.join(dir, "google-token.json");
    writeClientFile(clientFile, fake.endpoints);
    await connect(fake.grantedScopes);
    google = new GoogleConnection({ clientFile, tokenFile, endpoints: fake.endpoints, timeoutMs: 500 });
  });
  afterEach(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = (scopes: readonly string[]) =>
    writeToken(tokenFile, {
      accessToken: fake.issueAccessToken(scopes),
      refreshToken: REFRESH_TOKEN,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: [...scopes],
    });
  const upload = (content: string) => uploadMarkdown(google, { folder: FOLDER, name: NAME, content });
  const failure = async (content = "x") => {
    try {
      await upload(content);
    } catch (error) {
      if (error instanceof GoogleError) return { kind: error.kind, message: error.message };
      throw error;
    }
    throw new Error("expected the upload to fail");
  };
  const visible = () => fake.driveFiles.filter((file) => file.byApp);

  it("creates the folder and the file the first time", async () => {
    const file = await upload("# Monday\n");

    expect(file.created).toBe(true);
    const [folder, created] = visible();
    expect(folder).toMatchObject({ name: FOLDER, mimeType: FOLDER_MIME_TYPE, parents: ["root"] });
    expect(created).toMatchObject({ id: file.id, name: NAME, mimeType: "text/markdown", parents: [folder!.id], content: "# Monday\n" });
  });

  it("overwrites the same file after that, so its id and link never change", async () => {
    const first = await upload("# Monday\n");
    const second = await upload("# Tuesday\n");

    expect(second).toEqual({ id: first.id, created: false });
    expect(visible()).toHaveLength(2);
    expect(visible()[1]!.content).toBe("# Tuesday\n");
    const [patch] = fake.requests.filter((r) => r.method === "PATCH");
    expect(patch!.path).toBe(`/upload/drive/v3/files/${first.id}`);
  });

  it("keeps Markdown special characters and non-ASCII text intact", async () => {
    const content = "# Manaʻo daily\n\n- [ ] it's `done` — 7h 12m\r\n--not-a-boundary\n";
    await upload(content);
    await upload(content);

    expect(visible()[1]!.content).toBe(content);
  });

  it("recreates the file when the user trashed it, in the same folder", async () => {
    const first = await upload("# Monday\n");
    fake.driveFiles.find((f) => f.id === first.id)!.trashed = true;

    const second = await upload("# Tuesday\n");

    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(visible().filter((f) => f.mimeType === FOLDER_MIME_TYPE)).toHaveLength(1);
  });

  it("writes to the oldest when two of a name exist, every time", async () => {
    const folder = fake.addDriveFile({ name: FOLDER, mimeType: FOLDER_MIME_TYPE, parents: ["root"], byApp: true });
    const oldest = fake.addDriveFile({ name: NAME, mimeType: "text/markdown", parents: [folder.id], content: "", byApp: true });
    fake.addDriveFile({ name: NAME, mimeType: "text/markdown", parents: [folder.id], content: "", byApp: true });

    expect(await upload("a")).toEqual({ id: oldest.id, created: false });
    expect(await upload("b")).toEqual({ id: oldest.id, created: false });
  });

  it("never sees or writes a Manao folder the user made themselves", async () => {
    const own = fake.addDriveFile({ name: FOLDER, mimeType: FOLDER_MIME_TYPE, parents: ["root"], byApp: false });

    await upload("# Monday\n");

    expect(visible()[0]!.id).not.toBe(own.id);
    expect(fake.driveFiles.filter((f) => f.parents.includes(own.id))).toEqual([]);
  });

  it("asks for an access token narrowed to drive.file and nothing else", async () => {
    await upload("# Monday\n");

    const [refresh] = fake.requestsTo("/token");
    expect(refresh!.form.get("scope")).toBe(DRIVE_SCOPES.join(" "));
  });

  it("says to sign in again when the token lacks drive.file, and sends nothing", async () => {
    await connect(CALENDAR_SCOPES);

    expect(await failure()).toEqual({
      kind: "missing-scope",
      message: "missing scope https://www.googleapis.com/auth/drive.file: run `manao auth google`",
    });
    expect(fake.requests).toEqual([]);
  });

  it("names Drive's reason and how to fix a disabled API", async () => {
    fake.faults.set("/drive/v3/files", {
      status: 403,
      body: { error: { code: 403, message: "Project 123 has not used it", errors: [{ reason: "accessNotConfigured" }] } },
    });

    expect(await failure()).toEqual({
      kind: "refused",
      message: "Drive files.list: forbidden (accessNotConfigured: enable the Google Drive API in your Cloud project)",
    });
  });

  it("fails as unreachable on a 5xx, having written nothing", async () => {
    fake.faults.set("/upload/drive/v3/files", { status: 503 });

    expect(await failure()).toMatchObject({ kind: "unreachable" });
    expect(visible().filter((f) => f.name === NAME)).toEqual([]);
  });
});
