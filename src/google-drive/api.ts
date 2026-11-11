import { randomBytes } from "node:crypto";
import { z } from "zod";
import { forbidden, type GoogleConnection, unexpected } from "../google/oauth.js";

/**
 * Only the files this app created: Drive hides everything else from it, so
 * the digest can neither read nor overwrite anything the user made.
 */
export const DRIVE_SCOPES: readonly string[] = ["https://www.googleapis.com/auth/drive.file"];

const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/** Drive ids are URL-safe base64; checking keeps one safe to put in a query. */
const fileSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) });
const fileListSchema = z.object({ files: z.array(fileSchema) });

export interface DriveFile {
  id: string;
  /** False when an earlier upload's file was overwritten in place. */
  created: boolean;
}

/**
 * Writes `content` as the Markdown file `name` in the folder `folder` at the
 * top of the user's Drive, creating either the first time. Later uploads find
 * the same file and overwrite it, so its id and link never change. When there
 * are several of a name (two first runs at once), the oldest wins every time.
 */
export async function uploadMarkdown(
  google: GoogleConnection,
  { folder, name, content }: { folder: string; name: string; content: string },
): Promise<DriveFile> {
  const folderId =
    (await findOldest(google, `name = ${quoted(folder)} and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`)) ??
    (await createFolder(google, folder));
  const fileId = await findOldest(google, `name = ${quoted(name)} and '${folderId}' in parents and trashed = false`);
  if (fileId) {
    await send(google, `${google.endpoints.driveUpload}/files/${fileId}?uploadType=media&fields=id`, "PATCH", {
      headers: { "content-type": "text/markdown; charset=UTF-8" },
      body: content,
    });
    return { id: fileId, created: false };
  }
  const boundary = `manao-${randomBytes(12).toString("hex")}`;
  const metadata = { name, mimeType: "text/markdown", parents: [folderId] };
  const created = await send(google, `${google.endpoints.driveUpload}/files?uploadType=multipart&fields=id`, "POST", {
    headers: { "content-type": `multipart/related; boundary=${boundary}` },
    body: [
      `--${boundary}`,
      "content-type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "content-type: text/markdown; charset=UTF-8",
      "",
      content,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  });
  return { id: created.id, created: true };
}

async function findOldest(google: GoogleConnection, q: string): Promise<string | undefined> {
  const params = new URLSearchParams({ q, spaces: "drive", orderBy: "createdTime", pageSize: "1", fields: "files(id)" });
  const { status, body } = await google.getJson(`${google.endpoints.drive}/files?${params}`, DRIVE_SCOPES);
  const list = checked(status, body, fileListSchema, "Drive files.list");
  return list.files[0]?.id;
}

async function createFolder(google: GoogleConnection, name: string): Promise<string> {
  const { status, body } = await google.postJson(
    `${google.endpoints.drive}/files?fields=id`,
    { name, mimeType: FOLDER_MIME_TYPE },
    DRIVE_SCOPES,
  );
  return checked(status, body, fileSchema, "Drive folder create").id;
}

async function send(
  google: GoogleConnection,
  url: string,
  method: string,
  init: { headers: Record<string, string>; body: string },
): Promise<z.infer<typeof fileSchema>> {
  const { status, body } = await google.request(url, { method, ...init }, DRIVE_SCOPES);
  return checked(status, body, fileSchema, method === "PATCH" ? "Drive file update" : "Drive file create");
}

const REASON_HINTS = new Map([["accessNotConfigured", "enable the Google Drive API in your Cloud project"]]);

const apiErrorSchema = z.object({
  error: z.object({ errors: z.tuple([z.object({ reason: z.string().regex(/^[A-Za-z]{1,64}$/) })], z.unknown()) }),
});

/** Drive's reason code, from the same error shape the Calendar API uses; its message names the Cloud project, so it is never kept. */
function checked<T>(status: number, body: unknown, schema: z.ZodType<T>, what: string): T {
  if (status === 403) {
    const parsed = apiErrorSchema.safeParse(body);
    throw forbidden(what, parsed.success ? parsed.data.error.errors[0].reason : undefined, REASON_HINTS);
  }
  if (status !== 200) throw unexpected(`${what} answered HTTP ${status}`);
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw unexpected(`${what}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** A Drive query string literal. */
function quoted(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
