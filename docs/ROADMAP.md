# Roadmap

References such as `legacy-77` identify pre-publication development tickets, not issues in this repository. The technical decisions are documented here; new issues belong to ChrisKalahiki/manao.

Ordered. Each step should leave `bun run typecheck` and `bun run test` green. Read `CLAUDE.md` first.

## 0. Validate the Herdr adapter (done)

Validated against Herdr 0.9.5; that Adapter was replaced in step 10.

## 1. SQLite store and hub process (done)

Spec: issue `legacy-4`. Design: `GLOSSARY.md`, ADR 0001.

- Tables (`src/store/`, schema `user_version` 1):
  - `items(source, type, id, position, title, status, attention, updated_at, data)`, primary key `(source, type, id)`.
  - `events(id INTEGER PRIMARY KEY AUTOINCREMENT, source, kind, at, data)`, indexed on `at`.
  - `health(source PRIMARY KEY, ok, at, error, note, stale_after_ms, last_ok_at)`.
- `replaceItems` replaces the full set for `(source, type)` in one transaction and keeps `updated_at` for unchanged Items. Events are append-only apart from retention (`eventRetentionDays`, default 30), pruned at startup and daily.
- Queries shared by every consumer: `items.list({ type, status, attention })` with `sourceOk`/`lastOkAt` per Item, `events.after(id, limit)`, `events.since(time)`, `health.list()`.
- `manao run` loads the config, removes Sources it no longer enables, prunes Events, and runs the enabled Adapters with the store as sink.
- Tests at two seams: the store (in-memory, injected clock) and the hub (real Herdr Adapter against `FakeHerdr`).

## 2. Core read API (done)

Spec: issue `legacy-16` (tickets `legacy-17` items, `legacy-18` events, `legacy-19` sources).

- An HTTP server inside the hub process (ADR 0001), on Node's built-in `http`, reading the hub's own store through the step 1 queries. No new dependency. Code in `src/api/`.
- Listens on `127.0.0.1` only. Config `api`: `{ "port": 7420 }` by default, `false` to turn it off, validated with errors naming the field. Starts after the store and Adapters; `port: 0` picks a free port; the bound address is printed at startup and exposed as `hub.apiUrl`; a taken port stops startup, naming it, after stopping what already started; `stop()` closes the server.
- Tailnet access with `tailscale serve` (HTTPS on the machine's `*.ts.net` name), documented in the README and not automated. Never `tailscale funnel`. No authentication: the tailnet is the boundary.
- Guards shared by every endpoint: a `Host` other than `localhost:<port>`, `127.0.0.1:<port>` or a `*.ts.net` name gets 403; any method but GET gets 405; unknown paths get 404; unknown, repeated or malformed parameters get 400 naming the parameter. Every error body is `{ error }`. No CORS. Every success body carries `now`, the hub's clock.
- Endpoints, all under `/api` so the PWA can be served from `/` later:
  - `GET /api/items` (done, `legacy-17`): optional `type`, `status`, `attention` (`true`/`false`). Returns `{ now, items }` in the store's order, each Item with `sourceOk` and `lastOkAt`.
  - `GET /api/events` (done, `legacy-18`): `after` (integer >= 0, default 0) with `limit` (1 to 500, default 100), or `since` (ISO 8601 time), never both. Returns `{ now, events, next, more }`: `next` is the highest id returned, or when none were, `after` (or with `since`, the newest stored Event's id); `more` is true when the limit was reached.
  - `GET /api/sources` (done, `legacy-19`): `{ now, sources }`, one entry per Source that has reported: its latest Health, `lastOkAt` and `healthy`.
- Tests at the hub seam: hub started from config with `api.port` 0 against `FakeHerdr`, injected clock, real HTTP requests. Config validation alongside the config tests.
- Out of scope: the PWA and static files (step 6), a `/api/today` endpoint (became `/api/agenda`, step 5), SSE or WebSockets (polling with `next` instead), CORS, authentication, write endpoints, automating `tailscale serve`, launchd.

## 3. Read-only MCP server (done)

Spec: issue `legacy-21` (tickets `legacy-22` `list_items`, `legacy-23` `list_events`, `legacy-24` `list_sources`).

- `manao mcp`: a separate process an agent's client launches over stdio (ADR 0001). Opens the store read-only, never touches the Adapters. No HTTP transport. stdout carries only protocol messages; logs go to stderr. `@modelcontextprotocol/server` v2 with `zod` 4, the only new dependencies. Code in `src/mcp/`.
- Store lookup as the hub's (`resolveDbPath`, reading the config only for `dbPath`); no `mcp` config key. Opened lazily on the first tool call and retried on every call until it opens: a missing file, a newer schema (`user_version`) or a refused read-only open is a tool error naming the path, never a startup failure. A read-only open of a WAL store works before the hub has created its `-shm`/`-wal` files.
- One query layer (`src/query/`) holds the parameter rules and queries behind `/api/items`, `/api/events` and `/api/sources`; the HTTP routes and the tools both call it, and the API's behaviour is unchanged.
- Results: `{ now, ... }` as structured content validated against the output schema, plus one text block: a Stale warning naming each Source that is not Healthy and when it last reported success, then the JSON. Bad arguments are error results naming the parameter. Every tool carries `readOnlyHint: true`.
- Tools:
  - `list_items` (done, `legacy-22`): optional `type`, `status`, `attention` (boolean). `{ now, items }`, each Item with `sourceOk` and `lastOkAt`.
  - `list_events` (done, `legacy-23`): `after` (integer >= 0, default 0) with `limit` (1 to 500, default 25, the one rule that differs from the API, so a page fits Claude Code's tool output), or `since` (ISO 8601). `{ now, events, next, more }` with the API's rules.
  - `list_sources` (done, `legacy-24`): no parameters. `{ now, sources }` with each Source's latest Health, `lastOkAt` and `healthy`.
- Remote use: other machines run it over SSH on the hub host (`claude mcp add manao -- ssh -o BatchMode=yes <host> <node> <path>/dist/cli.js mcp`); documented in the README, not automated, remote SSH registration remains unverified. No `.mcp.json` in the repo.
- Tests at the MCP seam: a temp store written as the hub would, the server reading it read-only, an in-process client, injected clock. One subprocess smoke test runs `node dist/cli.js mcp` over stdio.
- Out of scope: an HTTP transport, a summary tool such as `whats_on_my_plate` (became `agenda`, step 5), paging `list_items`, MCP resources and prompts, any write tool.


## 4. Run as a service (done)

Spec: issue `legacy-35` (tickets `legacy-36` template, README and run exit contract; `legacy-37` verified in a live deployment).

- A user LaunchAgent template checked into the repo (`KeepAlive`, logs to `~/Library/Logs/manao/`), with install steps in the README. Documented, not automated, like `tailscale serve`.

## 5. Thin dashboard PWA (done)

Spec: issue `legacy-39` (tickets `legacy-40` serving and Health, `legacy-41` polling and banner, `legacy-42` Agents, `legacy-43` Todos, `legacy-44` installable; `legacy-45` verified in a live deployment and mobile dashboard). Second part: the Agenda, spec issue `legacy-59` (tickets `legacy-60` tracer bullet with Needs you and the Today and All views, `legacy-61` Today's Appointments, `legacy-62` open Todos; `legacy-63` verified in a live deployment and mobile dashboard). Design: `GLOSSARY.md` (Agenda).

- Preact + Vite, built to static files the hub serves at `/`, so the PWA and `/api` share one origin (no CORS). Reached over `tailscale serve` HTTPS.
- First widgets: agents (Attention first, then done-unseen, running, idle), per-Source health, and a banner whenever data is Stale.
- Polls `/api/items` and `/api/sources` every 10s while visible; stops while hidden.
- Installable: manifest plus a service worker that caches the app shell only, never data.
- A Todos widget grouped by Todo Group, with subtodos under their parent: the raw `/api/items?type=todo` list is accurate but hard to read.
- The Agenda: one shared query served as `GET /api/agenda` and the `agenda` MCP tool, rendered by the dashboard's Today view (its home); the four widgets moved to the All view (`#all`). Each view polls only what it shows.
- Out of scope: push notifications (a later step of their own).

## 6. Brain-Dump Todos adapter (done)

Spec: issue `legacy-27` (tickets `legacy-28` Items, `legacy-29` failures, `legacy-30` folder watch, `legacy-31` verified in a live deployment; Brain-Dump#117 for the command). Design: `GLOSSARY.md` (Todo, Todo Group, Weekly Note), ADR 0002.

- First, in Brain-Dump: `brain-dump todos --date <iso>` returning `{ note, exists, todos: [{ text, done, groupPath, parentIndex, line }] }` for that date's Weekly Note, with its own tests.
- The adapter calls that command; it never parses the vault or imports Brain-Dump code. Source `brain-dump:todos`; no vault path in manao's config.
- Re-reads: poll every 60s, plus a watch on the vault folder (`brain-dump vault`) that re-reads 2s after the last change, which also rides out Obsidian Sync's partial writes.
- One Item of type `todo` per checkbox, subtodos included. Status `open` or `done`; ticked Todos stay for the week. id: hash of group path, text and occurrence index, so editing the text makes a new Item. `data` carries the group path, parent, line and note path.
- Only the current Weekly Note; last week's leftovers are not read. Plain `- [ ]` only. Todos never raise Attention.

## 7. Google Calendar adapter (done)

Spec: issue `legacy-49` (tickets `legacy-50` tracer bullet, `legacy-51` `manao auth google`, `legacy-52` Attention and the tick, `legacy-53` failures, `legacy-54` widget, `legacy-55` verified in a live deployment and mobile dashboard). Design: `GLOSSARY.md` (Appointment).

- OAuth through a user-managed Cloud project, set to In production and left unverified (one user, no verification or CASA, and no 7-day refresh-token expiry as in Testing mode). Scopes `calendar.calendarlist.readonly` and `calendar.events.readonly`, which proved enough on a real sign-in.
- No `.env`: the Desktop OAuth client JSON from Cloud Console sits at the config's `google.client` (mode 0600, outside the repo). launchd never reads a repo `.env`, and Google treats a Desktop client's secret as not confidential. The token in `$XDG_DATA_HOME/manao/google-token.json`, mode 0600, written by a one-time `manao auth google` loopback flow (PKCE, `state`, `access_type=offline`, `prompt=consent`) and refreshed in place by the hub, which reads it on every fetch, so a new sign-in needs no restart. Plain `fetch`, no Google library.
- A missing, revoked or lapsed token is Health `ok: false` with "not connected: run `manao auth google`": the "reconnect" state. A scope not granted is named the same way. Every failure keeps the Items Stale.
- Source `google-calendar:primary`, opt-in through `sources.googleCalendar`: calendar ids (default primary only), every 5 minutes, from the start of Today to the end of Today plus `daysAhead` (default 7). Recurrences expanded by the API (`singleEvents`). Declined, cancelled, working-location and birthday entries left out; tentative and unanswered invitations kept with the user's response.
- Items of type `appointment`, id calendar id plus instance id; Status `upcoming`, `ongoing` or `ended` (ended ones drop off at the end of Today). Attention from 15 minutes before start until the end; never for all-day, out-of-office or focus-time Appointments. Descriptions, attendees and dial-ins are never stored.

## 8. Measurements (Google Health API) (done)

Spec: issue `legacy-66` (tickets `legacy-67` probe, `legacy-68` tracer bullet with steps, `legacy-69` the other Metrics, `legacy-70` widget, `legacy-71` failures, `legacy-74` narrowed access tokens, `legacy-72` verified in a live deployment and mobile dashboard). Design: `GLOSSARY.md` (Metric, Measurement).

- Source `google-health`, reusing step 7's Cloud project and `manao auth google` with the Health read scopes added. All Google Health API scopes are Restricted; fine for one user on an unverified In production app. The Fitbit Web API turns off on 2026-11-02, so it is not an option. The Health API refuses a token carrying any other scope, so each Google Source reads with an access token narrowed to its own (`legacy-74`).
- Steps and active zone minutes from `dailyRollUp` (`activity_and_fitness`); resting heart rate (`health_metrics_and_measurements`) and sleep (`sleep`, minutes asleep summed by wake date, naps included) from filtered lists. Scopes confirmed by the probe (`legacy-67`).
- Measurements are a new store part: one value per Source, metric and day, kept forever (outside `eventRetentionDays`). Not Items: Items keep only the present.
- Backfill 30 days on first run, then refresh hourly, rewriting Today and yesterday because Fitbit syncs late.
- `GET /api/measurements?metric&from&to` and a `list_measurements` MCP tool through the shared query layer, plus a dashboard widget.

## 9. paper-bot Source

Spec: issue `legacy-77` (tickets `legacy-78` tracer bullet with Picks and Health, `legacy-79` Events, `legacy-80` Papers widget, `legacy-81` verify in a live deployment and mobile dashboard). paper-bot's side: ChrisKalahiki/paper-bot#18.

- Source `paper-bot:picks`, opt-in through `sources.paperBot`: polls `paper-bot picks --json` every 15 minutes, a JSON contract paper-bot owns (ADR 0002's pattern). Never writes to paper-bot or the vault.
- This week's Picks (Monday to Sunday) as `paper` Items, Status `picked` or `kept`, never Attention, so never on the Agenda; last week's drop out when the week rolls over.
- Health follows paper-bot's Scans: Unhealthy when the Daily Scan failed or is 26 hours old, the Weekly Scan failed, or a Keep is failing. A skipped Scan or one failed source stays Healthy, the source named in the note.
- Events for each new Scan result and each Pick kept.
- A Papers widget on the All view: Picks by day, newest first, with Interests, the why line, Wildcard and kept markers, and an `obsidian://` link to each day's Briefing.
- Not yet verified against the real paper-bot (`legacy-81`).

## 10. Herdr on herdr-core (the Herdr app)

Spec: issue `legacy-83` (tickets `legacy-84` tracer bullet with Items and Health, `legacy-85` Events and nudger, `legacy-86` remove Herdr 0.9.5 leftovers, `legacy-87` verify in a live deployment and mobile dashboard). The Herdr app replaces the terminal Herdr (0.9.5) integration and runs its terminals on herdr-core (`hc` 0.1.16, protocol generation 1): JSON-RPC 2.0 over `~/.local/state/herdr-core/default/default.sock`, terminals instead of workspaces, tabs and panes.

- Replaces the Herdr 0.9.5 Adapter, its client, the `manao herdr once/watch` commands, its fixtures and `docs/herdr-api.schema.json`.
- Source `herdr:local`, still configured through `sources.herdr` (`session` removed; `socketPath`, `intervalSeconds`, `events`, `staleAfterSeconds` kept). The hub drops `herdr:default`'s Items and Health at startup; its Events age out.
- A new read-only allowlist: `hello`, `server.status`, `terminal.list`, `terminal.get`, `events.subscribe`. Never `terminal.read`, `terminal.attach` or `file.read` (screen text and files), nor anything that writes, runs or stops.
- One `agent` Item per live terminal whose program reports a status (OSC 7501), keyed by its address (`t7`). Status from the program's own word, so no screen inference; Attention for blocked, done and error. `argv` and `foreground` never stored.
- `agent.transition` Events as before, a finished cycle read from `turn`; `events.subscribe` as the nudge.

## 11. Later

GitHub (notifications, PRs awaiting review, CI), Tailscale device status, a Discord bot channel, alarms defined inside the hub (phone alarms cannot be read from outside the device), push notifications for agents that need Attention, several Herdr machines through one Adapter (herdr-core's `machine.add` and `machine/t7` addresses), one Source per machine (`herdr:<machine>`).

## Cross-cutting

- Config file for paths, enabled adapters and intervals (done in step 1); nothing machine-specific in code. No `.env` yet: step 7's Google client is a file the config names, not env, so `.env.example` waits for a Source with a secret that env must carry.
- A `timeZone` config option (default: the system zone) that defines Today for every Source and consumer.
- GitHub Actions running `bun run check` on push (done).

## Open questions

- When agents get write access, what the permission and audit model looks like.
