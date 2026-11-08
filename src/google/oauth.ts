import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "../error-message.js";

/** Where Google lives; tests point these at a fake. */
export interface GoogleEndpoints {
  /** The consent page the sign-in opens. */
  authorize: string;
  token: string;
  calendar: string;
  /** The Google Health API, v4. */
  health: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  calendar: "https://www.googleapis.com/calendar/v3",
  health: "https://health.googleapis.com/v4",
};

export const RECONNECT = "run `manao auth google`";

/**
 * What a Google reader branches on; each message already says what to do.
 * - `not-connected`: the token file is missing, unreadable or corrupt, or Google no longer honours it. Sign in again.
 * - `missing-scope`: the token lacks a scope the reader needs. Sign in again.
 * - `unreachable`: network failure, timeout or a 5xx. Retry as is.
 * - `refused`: the config names a calendar that is not found, forbidden or named twice, or Google forbids a read. Fix what it names.
 * - `client`: the OAuth client file is missing or malformed. Fix the file.
 * - `unexpected`: Google answered something this module does not understand.
 */
export type GoogleFailure = "not-connected" | "missing-scope" | "unreachable" | "refused" | "client" | "unexpected";

export class GoogleError extends Error {
  override name = "GoogleError";
  constructor(
    readonly kind: GoogleFailure,
    message: string,
  ) {
    super(message);
  }
}

export const notConnected = () => new GoogleError("not-connected", `not connected: ${RECONNECT}`);

/** The Desktop OAuth client Cloud Console downloads. Google treats its secret as public. */
export interface GoogleClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * What the sign-in writes. Readers use only the refresh token and the granted
 * scopes; the sign-in's access token carries every scope, which the Health API
 * refuses, so each reader mints its own narrowed one.
 */
export interface GoogleToken {
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token stops working. */
  expiresAt: string;
  /** What Google says was granted, which may be less than what was asked. */
  scopes: string[];
}

const clientFileSchema = z.object({
  installed: z.object({ client_id: z.string().min(1), client_secret: z.string().optional() }),
});

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  scopes: z.array(z.string()),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  scope: z.string().optional(),
  refresh_token: z.string().min(1).optional(),
});

/** A 200 from the token endpoint; a refresh may leave out the refresh token and the scopes, meaning unchanged. */
export interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  /** ISO time, from `expires_in` on the clock of the answer. */
  expiresAt: string;
  scopes?: string[];
}

/** Parses a token endpoint's 200; `what` names the exchange in the error. */
export function tokenGrant(body: unknown, now: Date, what: string): TokenGrant {
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) throw unexpected(`${what}: ${z.prettifyError(parsed.error)}`);
  const { access_token, expires_in, refresh_token, scope } = parsed.data;
  return {
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt: new Date(now.getTime() + expires_in * 1000).toISOString(),
    scopes: scope?.split(" "),
  };
}

/** The OAuth `error` code of a refused token request, when the body carries one. */
export function oauthError(body: unknown): string | undefined {
  const parsed = z.object({ error: z.string() }).safeParse(body);
  return parsed.success ? parsed.data.error : undefined;
}

export async function readClient(file: string): Promise<GoogleClient> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const reason = isMissing(error) ? "not found" : errorMessage(error);
    throw new GoogleError("client", `Google client file ${file}: ${reason}`);
  }
  try {
    const { installed } = clientFileSchema.parse(JSON.parse(text));
    return { clientId: installed.client_id, clientSecret: installed.client_secret };
  } catch {
    throw new GoogleError("client", `Google client file ${file}: not a Desktop OAuth client JSON from Cloud Console`);
  }
}

/** Every failure means not connected, since the sign-in writes a new token; one that is there but broken says how. */
export async function readToken(file: string): Promise<GoogleToken> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) throw notConnected();
    throw brokenToken(file, `is unreadable (${errorMessage(error)})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw brokenToken(file, "is corrupt (not JSON)");
  }
  const token = tokenSchema.safeParse(json);
  if (!token.success) {
    const [issue] = token.error.issues;
    throw brokenToken(file, `is corrupt (${issue?.path.join(".")}: ${issue?.message})`);
  }
  return token.data;
}

const brokenToken = (file: string, problem: string) =>
  new GoogleError("not-connected", `Google token file ${file} ${problem}: ${RECONNECT}`);

/** Atomic and owner-only: a reader never sees half a token, and no other user any of it. */
export async function writeToken(file: string, token: GoogleToken): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export interface GoogleResponse {
  status: number;
  body: unknown;
}

/** One request and its JSON body within `timeoutMs`; network failures, timeouts and 5xx are `unreachable`. */
export async function googleRequest(url: string, init: RequestInit, timeoutMs: number): Promise<GoogleResponse> {
  let status: number;
  let text: string;
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new GoogleError("unreachable", `timed out after ${timeoutMs}ms`);
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new GoogleError("unreachable", `unreachable: ${errorMessage(cause)}`);
  }
  if (status >= 500) throw new GoogleError("unreachable", `unreachable: HTTP ${status}`);
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    throw unexpected(`HTTP ${status} with a body that is not JSON`);
  }
}

export interface GoogleConnectionOptions {
  clientFile: string;
  tokenFile: string;
  endpoints?: GoogleEndpoints;
  /** The hub's clock, which decides when the access token has expired. */
  now?: () => Date;
  /** Per request. Default 10 seconds. */
  timeoutMs?: number;
}

/** Refresh this long before Google's expiry so a request never carries a token that dies in flight. */
const EXPIRY_MARGIN_MS = 60_000;

/** A narrowed access token, good only while `refreshToken` is still the one in the token file. */
interface NarrowedToken {
  refreshToken: string;
  accessToken: string;
  expiresAt: string;
}

/**
 * One Google account as a reader sees it. Reads the token file on every call,
 * so a sign-in while the hub runs counts on the next read.
 */
export class GoogleConnection {
  readonly endpoints: GoogleEndpoints;
  readonly timeoutMs: number;
  private readonly now: () => Date;
  /** Keyed by the sorted scope set. */
  private readonly narrowed = new Map<string, NarrowedToken>();

  constructor(private readonly opts: GoogleConnectionOptions) {
    this.endpoints = opts.endpoints ?? GOOGLE_ENDPOINTS;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.now = opts.now ?? (() => new Date());
  }

  /** A current access token carrying exactly `scopes`, minted from the refresh token and kept until it nears expiry. */
  async accessToken(scopes: readonly string[]): Promise<string> {
    const token = await readToken(this.opts.tokenFile);
    const missing = scopes.find((scope) => !token.scopes.includes(scope));
    if (missing) throw new GoogleError("missing-scope", `missing scope ${missing}: ${RECONNECT}`);
    const key = [...new Set(scopes)].sort().join(" ");
    const cached = this.narrowed.get(key);
    if (
      cached?.refreshToken === token.refreshToken &&
      Date.parse(cached.expiresAt) - EXPIRY_MARGIN_MS > this.now().getTime()
    ) {
      return cached.accessToken;
    }
    const grant = await this.refresh(token.refreshToken, key);
    // A sign-in may have written a new account's token while this refresh was in flight; it wins.
    const current = await readToken(this.opts.tokenFile);
    if (current.refreshToken !== token.refreshToken) return this.accessToken(scopes);
    const refreshToken = grant.refreshToken ?? token.refreshToken;
    if (refreshToken !== token.refreshToken) await writeToken(this.opts.tokenFile, { ...current, refreshToken });
    this.narrowed.set(key, { refreshToken, accessToken: grant.accessToken, expiresAt: grant.expiresAt });
    return grant.accessToken;
  }

  /** GETs JSON with the account's token; 401 means not connected. */
  getJson(url: string, scopes: readonly string[]): Promise<GoogleResponse> {
    return this.authorized(url, {}, scopes);
  }

  /** POSTs `body` as JSON for a read that Google takes as a POST, such as a roll-up; 401 means not connected. */
  postJson(url: string, body: unknown, scopes: readonly string[]): Promise<GoogleResponse> {
    return this.authorized(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, scopes);
  }

  private async authorized(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    scopes: readonly string[],
  ): Promise<GoogleResponse> {
    const accessToken = await this.accessToken(scopes);
    const headers = { ...init.headers, authorization: `Bearer ${accessToken}` };
    const response = await googleRequest(url, { ...init, headers }, this.timeoutMs);
    if (response.status === 401) throw notConnected();
    return response;
  }

  /** A refresh grant narrowed to `scope`, Google's space-separated list. */
  private async refresh(refreshToken: string, scope: string): Promise<TokenGrant> {
    const client = await readClient(this.opts.clientFile);
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      scope,
    });
    if (client.clientSecret) form.set("client_secret", client.clientSecret);
    const { status, body } = await googleRequest(this.endpoints.token, { method: "POST", body: form }, this.timeoutMs);
    if (status !== 200) {
      const error = oauthError(body);
      if (error === "invalid_grant") throw notConnected();
      throw unexpected(`token refresh answered HTTP ${status}${error ? ` ${error}` : ""}`);
    }
    return tokenGrant(body, this.now(), "token refresh");
  }
}

/**
 * A 403 named by Google's reason code, read by each API from its own error
 * shape, with a hint where one helps. Google's message names the Cloud
 * project, so it is never kept.
 */
export function forbidden(what: string, reason: string | undefined, hints: ReadonlyMap<string, string>): GoogleError {
  const hint = reason && hints.get(reason);
  const detail = reason ? ` (${reason}${hint ? `: ${hint}` : ""})` : "";
  return new GoogleError("refused", `${what}: forbidden${detail}`);
}

export const unexpected = (detail: string) => new GoogleError("unexpected", `unexpected response from Google: ${detail}`);

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
