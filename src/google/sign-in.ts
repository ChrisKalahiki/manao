import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { errorMessage } from "../error-message.js";
import { homeRelative } from "../home-path.js";
import {
  GOOGLE_ENDPOINTS,
  type GoogleClient,
  type GoogleEndpoints,
  type GoogleToken,
  googleRequest,
  oauthError,
  readClient,
  tokenGrant,
  unexpected,
  writeToken,
} from "./oauth.js";

export interface SignInOptions {
  clientFile: string;
  tokenFile: string;
  scopes: readonly string[];
  endpoints?: GoogleEndpoints;
  now?: () => Date;
  /** The loopback port; 0 picks a free one. A fixed port is what an SSH forward set up beforehand needs. */
  port?: number;
  /** Shows the user the consent page. Must not wait for him: the redirect arrives while sign-in is waiting. */
  openBrowser: (url: string) => void;
  print: (line: string) => void;
  /** Per request to Google. Default 10 seconds. */
  timeoutMs?: number;
}

/**
 * The loopback flow for an installed app: consent in the browser, the code back
 * to a listener on 127.0.0.1, exchanged with PKCE. Writes the token only when
 * every one of `scopes` was granted, so a failed or partial sign-in leaves any
 * earlier token in place.
 */
export async function signIn(opts: SignInOptions): Promise<GoogleToken> {
  const endpoints = opts.endpoints ?? GOOGLE_ENDPOINTS;
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const client = await readClient(opts.clientFile);
  const loopback = await listen(opts.port ?? 0);
  try {
    const redirectUri = `http://127.0.0.1:${loopback.port}`;
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    const consent = new URL(endpoints.authorize);
    consent.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: opts.scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    }).toString();

    opts.print("Sign in to Google in your browser to let Manaʻo read what its enabled Google Sources need.");
    opts.print("If no browser opens, open this address on this machine:");
    opts.print("");
    opts.print(`  ${consent.href}`);
    opts.print("");
    opts.print("Signing in from another machine over SSH? Forward this port from it, then open the address there:");
    opts.print(`  ssh -N -L ${loopback.port}:127.0.0.1:${loopback.port} <this machine>`);
    opts.print("");
    opts.print("Waiting for Google...");
    opts.openBrowser(consent.href);

    const redirect = await loopback.redirect;
    try {
      const token = await finish(redirect.params, { client, state, verifier, redirectUri, endpoints, now, timeoutMs, ...opts });
      redirect.reply(200, "Signed in to Manaʻo. You can close this tab.");
      return token;
    } catch (error) {
      redirect.reply(400, `Sign-in failed: ${errorMessage(error)}\nSee the terminal.`);
      throw error;
    }
  } finally {
    await loopback.close();
  }
}

/** This run of the sign-in: what judges the browser's answer and exchanges its code. */
interface SignInAttempt {
  client: GoogleClient;
  state: string;
  verifier: string;
  redirectUri: string;
  endpoints: GoogleEndpoints;
  now: () => Date;
  timeoutMs: number;
  scopes: readonly string[];
  tokenFile: string;
  print: (line: string) => void;
}

async function finish(params: URLSearchParams, attempt: SignInAttempt): Promise<GoogleToken> {
  if (params.get("state") !== attempt.state) {
    throw new Error("the answer from the browser did not carry this sign-in's state; nothing was written. Run it again.");
  }
  const denied = params.get("error");
  if (denied !== null) throw new Error(`Google did not grant access (${denied}); nothing was written.`);
  const code = params.get("code");
  if (!code) throw new Error("the answer from the browser carried no code; nothing was written. Run it again.");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: attempt.verifier,
    redirect_uri: attempt.redirectUri,
    client_id: attempt.client.clientId,
  });
  if (attempt.client.clientSecret) form.set("client_secret", attempt.client.clientSecret);
  const { status, body } = await googleRequest(attempt.endpoints.token, { method: "POST", body: form }, attempt.timeoutMs);
  if (status !== 200) {
    const error = oauthError(body);
    throw new Error(`Google refused the sign-in code (HTTP ${status}${error ? ` ${error}` : ""}); nothing was written.`);
  }
  const { accessToken, refreshToken, expiresAt, scopes: granted } = tokenGrant(body, attempt.now(), "code exchange");
  // `prompt=consent` is what makes Google send a refresh token every time.
  if (refreshToken === undefined) throw unexpected("code exchange: no refresh_token");
  if (granted === undefined) throw unexpected("code exchange: no scope");

  const missing = attempt.scopes.filter((scope) => !granted.includes(scope));
  if (missing.length > 0) {
    throw new Error(
      `Google did not grant ${missing.join(", ")}; nothing was written. Run it again and allow every permission asked for.`,
    );
  }
  const token: GoogleToken = { accessToken, refreshToken, expiresAt, scopes: granted };
  await writeToken(attempt.tokenFile, token);
  attempt.print("");
  attempt.print("Signed in. Google granted:");
  for (const scope of granted) attempt.print(`  ${scope}`);
  attempt.print(`Token written to ${homeRelative(attempt.tokenFile)}. A running hub uses it on its next fetch.`);
  return token;
}

interface Redirect {
  params: URLSearchParams;
  reply: (status: number, text: string) => void;
}

/**
 * Resolves on the first GET of `/` that carries a `state`, addressed to this
 * listener by name. Anything else is a 404 and the wait goes on, so a favicon,
 * another local process or a page aiming at the port cannot end the sign-in.
 */
async function listen(port: number): Promise<{ port: number; redirect: Promise<Redirect>; close: () => Promise<void> }> {
  let arrive: (redirect: Redirect) => void = () => {};
  const redirect = new Promise<Redirect>((resolve) => {
    arrive = resolve;
  });
  let answered = false;
  let hosts: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const addressed = hosts.includes(req.headers.host ?? "");
    if (req.method !== "GET" || url.pathname !== "/" || !addressed || !url.searchParams.has("state") || answered) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
      return;
    }
    answered = true;
    arrive({
      params: url.searchParams,
      reply: (status, text) => res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(`${text}\n`),
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${port} is in use; pick another with --port, or leave it out for a free one.`)
          : error,
      );
    });
    server.listen(port, "127.0.0.1", resolve);
  });
  const bound = (server.address() as AddressInfo).port;
  hosts = [`127.0.0.1:${bound}`, `localhost:${bound}`];
  return {
    port: bound,
    redirect,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
