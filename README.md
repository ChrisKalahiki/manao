# Manaʻo

**Manaʻo** is a personal hub for turning thoughts, tasks, and information into clarity and purposeful action. It brings agents, Todos, appointments, research Picks and daily Measurements into one read-only view. `manao run` starts the hub process: it reads the Herdr app's herdr-core socket, turns agent state into normalized hub Items and transition Events, and keeps them with each Source's Health in a SQLite store that other processes can read. It also serves a small read-only HTTP API on localhost for the dashboard, and `manao mcp` lets agents read the same store over MCP. Nothing here can type into a terminal, focus, close, or stop anything.

The name comes from the Hawaiian word *manaʻo*, whose meanings include thought, idea, intention and meaning ([Pukui–Elbert dictionary](https://wehe.hilo.hawaii.edu/?q=mana%CA%BBo)).

## Run it on the hub host

Needs Node 22+ and bun.

```
bun install
bun run build
node dist/cli.js run                 # the hub: keeps enabled Sources in the SQLite store
```

The package exposes the `manao` binary: `manao run`, `manao mcp` (see "Use from an agent"), and `manao auth google` (see "Google connection"). `run` reads its config from `MANAO_CONFIG`, else `$XDG_CONFIG_HOME/manao/config.json` (fallback `~/.config/manao/config.json`); with no file it runs Herdr with defaults. `config.example.json` documents every option, and an invalid config stops startup with an error naming the field. The store lives at `MANAO_DB`, else the config's `dbPath`, else `$XDG_DATA_HOME/manao/hub.db` (fallback `~/.local/share/manao/hub.db`); other processes can open it read-only while it runs. At startup the hub removes the Items and Health of any Source the config no longer enables (logging each; their Events stay), and it prunes Events older than `eventRetentionDays` (default 30) at startup and once a day.

Herdr agents come from the Herdr app's herdr-core, at `$XDG_STATE_HOME/herdr-core/default/default.sock` (fallback `~/.local/state/herdr-core/default/default.sock`); `sources.herdr.socketPath` overrides it. If the Source is not Healthy, `hc server status` says whether the core is running. The Source is `herdr:local`; a store from before the Herdr app still has `herdr:default`, which the hub removes at startup (its Events age out).

## Enable Brain-Dump Todos

Add `brainDump` under `sources` in the hub config (keep `herdr` there too if you want both):

```json
{
  "sources": {
    "herdr": {},
    "brainDump": {
      "command": "brain-dump",
      "intervalSeconds": 60,
      "staleAfterSeconds": 180
    }
  }
}
```

Leaving out `brainDump` turns this Source off. `command` accepts a bare executable on PATH, an absolute path or `~/...`; it defaults to `brain-dump`. Under launchd, both `brain-dump` and its `bun` interpreter must be resolvable in the service's environment. The installed Brain-Dump must support `vault`, `todos --date YYYY-MM-DD` and the JSON contract in [ChrisKalahiki/Brain-Dump#117](https://github.com/ChrisKalahiki/Brain-Dump/issues/117).

The `brain-dump:todos` Adapter runs that command at startup and every `intervalSeconds` (default 60), with Today from the hub's clock in the system time zone. It reads only command output, never note files. Each checkbox becomes a `todo` Item with Status `open`, `done` or `dropped`, no Attention, and `data` containing `note`, `groupPath`, `line` and `parentId`. Identities survive changes to Status and line; editing text or moving to another Todo Group changes identity. Duplicate text remains separate Items. Unchanged Items keep `updatedAt`.

Read them with `curl -s 'localhost:7420/api/items?type=todo'` or MCP `list_items` with `{ "type": "todo", "status": "open" }`. A failed command, timeout (10s) or invalid output reports unhealthy Health and preserves the last known Todos as Stale; the next successful poll recovers. A missing Weekly Note (`exists: false`) is a Healthy, empty read. Health becomes Stale after `staleAfterSeconds` (default 3x the poll interval).

The Adapter also runs `brain-dump vault` once to resolve the vault root and watches only the folder holding the vault-relative `note`. Folder changes re-read Todos after 2 seconds without further changes; the watch moves when the note changes folders. The debounce is an Adapter option, not config. If resolving the vault or watching the folder fails, polling continues and Health `note` names the cause. Unresolved roots and failed watches are retried on later reads. Stopping the hub closes the watch and clears polling and debounce timers.

## Enable paper-bot Picks

Add `paperBot` under `sources` in the hub config:

```json
{
  "sources": {
    "paperBot": {
      "command": "paper-bot",
      "intervalSeconds": 900,
      "staleAfterSeconds": 2700
    }
  }
}
```

Leaving out `paperBot` turns this Source off. `command` accepts a bare executable on PATH, an absolute path or `~/...`; it defaults to `paper-bot`, and under launchd it must be resolvable in the service's environment. The installed paper-bot must support `picks --json` and the JSON contract in [`src/paper-bot/contract.ts`](src/paper-bot/contract.ts).

The `paper-bot:picks` Adapter runs `paper-bot picks --json` at startup and every `intervalSeconds` (default 900, 15 minutes). It never writes to paper-bot or the vault. Each of this week's Picks becomes a `paper` Item with Status `picked` or `kept`, no Attention (so never on the Agenda), and `data` containing `title`, `url`, `date`, `interests`, `wildcard`, `why`, `briefing` (its Daily Briefing, relative to the vault) and `keptAt`. Every good read replaces the week, so last week's Picks drop out when paper-bot's week rolls over. Each new Scan result is a `scan.daily` or `scan.weekly` Event, and each Pick newly kept a `paper.kept` Event; neither polling nor a restart repeats one.

Read them with `curl -s 'localhost:7420/api/items?type=paper'`, MCP `list_items` with `{ "type": "paper" }`, or the dashboard's Papers widget. Health follows paper-bot's Scans: the Source is Healthy only when the latest Daily Scan did not fail and is under 26 hours old, the latest Weekly Scan did not fail and no Keep is failing; each broken rule is named in Health `error`. A skipped Scan is Healthy, and sources that failed while the Daily Scan itself did not are named in Health `note` only. A failed command, timeout (10s) or output off the contract keeps the last Picks as Stale; the next successful poll recovers. Health becomes Stale after `staleAfterSeconds` (default 3x the poll interval).

## Google connection

The Google Calendar and Google Health Sources read your calendar and your Fitbit tracker's daily Measurements through your own Google Cloud project. You set it up once, and one sign-in covers both Sources; after that the hub refreshes its own access and never writes anything to Google. Nothing here goes in the repo: the client file and the token both live in your home folder.

1. **Create a project.** In [Google Cloud Console](https://console.cloud.google.com/), create a new project (any name).
2. **Enable the Calendar API.** In that project, open APIs & Services, then Library, search for Google Calendar API and choose Enable. Skip this and the Source reports `calendarList: forbidden (accessNotConfigured: enable the Google Calendar API in your Cloud project)`. For Measurements, enable the Google Health API the same way (`steps: forbidden (SERVICE_DISABLED: enable the Google Health API in your Cloud project)` otherwise).
3. **Set up the consent screen.** Open Google Auth Platform (APIs & Services, then OAuth consent screen). Choose External and fill in an app name and the contact emails it asks for. Publishing needs a home page and a privacy policy link under Branding: the repo's URL serves as the home page, and any public page saying the app reads your calendar only for you and stores nothing elsewhere (a public gist will do) serves as the policy. For Measurements, add the three Health scopes under Data Access (Add or remove scopes; paste them under Manually add scopes if they are not listed): `googlehealth.activity_and_fitness.readonly`, `googlehealth.sleep.readonly` and `googlehealth.health_metrics_and_measurements.readonly`, each prefixed with `https://www.googleapis.com/auth/`. Google calls them Restricted, which needs no verification for your own account. Then, under Audience, choose Publish app so its status is **In production**. Do not submit it for verification: it stays unverified, which is fine for your own account. The difference matters: in Testing, Google expires the sign-in after 7 days; In production it lasts until it is revoked or goes unused for about 6 months.
4. **Create a Desktop OAuth client.** Under Clients, choose Create client, application type **Desktop app**, any name. Download its JSON.
5. **Put the client file where the config says.** Move the download outside the repo, make it readable only by you, and point `google.client` at it:

   ```
   mv ~/Downloads/client_secret_*.json ~/.config/manao/google.client.json
   chmod 600 ~/.config/manao/google.client.json
   ```

   ```json
   {
     "sources": { "herdr": {}, "googleCalendar": {}, "googleHealth": {} },
     "google": { "client": "~/.config/manao/google.client.json" }
   }
   ```

   Google treats a Desktop client's secret as public, so the file needs no env variable or secret store, only owner-only permissions.
6. **Sign in on the hub host.**

   ```
   node dist/cli.js auth google      # or: manao auth google
   ```

   It prints a Google address and opens it in the browser. Sign in, and expect one warning that Google has not verified the app: choose Advanced, then Go to (your app's name). Allow every permission it asks for: it asks for those of each Google Source the config enables (your calendar list and events for the Calendar; activity and fitness, sleep, and health metrics for Health), so enabling a Google Source later means signing in again. Google then sends the browser back to the command on `127.0.0.1`, which writes the token to `$XDG_DATA_HOME/manao/google-token.json` (`~/.local/share/manao/google-token.json`, mode 0600) and prints the scopes Google granted. A running hub uses the new token on its next fetch; there is no need to restart it.

   If it fails (you deny access, untick a permission, the browser's answer does not match this sign-in, the client file is missing or malformed, or the port is taken) it says why, exits non-zero and writes nothing, so an earlier token keeps working.

**From another machine over SSH.** The browser and the command must meet on the same `127.0.0.1` port, so forward it. Pick a port, forward it as you connect, and give the command the same port:

```
ssh -L 8765:127.0.0.1:8765 <hub-host>
node dist/cli.js auth google --port 8765
```

Open the printed address in the browser on your laptop. Over SSH the command does not try to open a browser on the hub host. Without `--port` it picks a free port and prints the `ssh -N -L` line to run from a second terminal on the laptop.

**Reconnecting.** A sign-in stops working when you revoke the app's access in your Google Account, when it goes unused for about 6 months, or when the token file is missing. The hub then reports the Source as not Healthy with the error ``not connected: run `manao auth google` ``, and a permission you did not grant shows as ``missing scope <scope>: run `manao auth google` ``. You see it in `GET /api/sources`, in the dashboard's Sources widget and banner, and in the MCP tools' Stale warning; the Appointments and Measurements already fetched stay listed, marked Stale. Run the sign-in again and the next fetch recovers.

**Other calendars.** `sources.googleCalendar.calendars` lists calendar ids of the signed-in account; `primary` is its own. A calendar from another account, such as a school one, works once it reaches this account's calendar list: share it from the other account with "See all event details", accept it (or add it under Other calendars) in Google Calendar, then add its id, which is usually that account's email address and is shown in the calendar's settings under Integrate calendar:

```json
"googleCalendar": { "calendars": ["primary", "someone@school.example"] }
```

A calendar that is not in the list fails the fetch with `calendar <id>: not found`, and the whole Source stays Stale until the config or the sharing is fixed.

**Scopes.** The sign-in asks only for the read scopes of the enabled Google Sources: `calendar.calendarlist.readonly` and `calendar.events.readonly` for the Calendar (issue `legacy-55`), and the three `googlehealth.*.readonly` scopes for Health (issue `legacy-67`), all under `https://www.googleapis.com/auth/`. The Google Health API refuses an access token that carries any other scope, so each Source reads with an access token narrowed to its own scopes, minted from the one sign-in (issue `legacy-74`).

**Measurements.** With `"googleHealth": {}` in `sources`, the hub reads four daily Metrics every hour: steps, sleep (minutes asleep in every session ending that day, naps included, so last night counts on the day you woke), resting heart rate and active zone minutes (Google's weighted total, as the Fitbit app shows it). The first read backfills `backfillDays` (default 30, at most 90); later reads rewrite yesterday and Today and catch up on days missed while the hub was off. A day the tracker recorded nothing has no Measurement, which is not the same as zero. Measurements are kept forever, also when you turn the Source off.

## Run as a service

`launchd/dev.manao.hub.plist` is a LaunchAgent template (label `dev.manao.hub`). Once installed, launchd starts the hub at login, restarts it after a crash or a failed start (10s apart), keeps it down after a deliberate stop, and writes its output to `~/Library/Logs/manao/`. Nothing installs it for you. Run these from the repo checkout, after `bun run build`.

Stop any hub running in a terminal first; two hubs fight over port 7420 and the store. The checkout, home and `node` paths must not contain `&`, `|` or `\`: the `sed` command below would mangle them (and `&` is invalid in the plist's XML).

```
launchctl bootout gui/$(id -u)/dev.manao.hub   # only if already loaded; errors harmlessly when it is not
mkdir -p ~/Library/Logs/manao ~/Library/LaunchAgents
sed -e "s|__NODE_DIR__|$(dirname "$(command -v node)")|g" -e "s|__NODE__|$(command -v node)|g" -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" launchd/dev.manao.hub.plist > ~/Library/LaunchAgents/dev.manao.hub.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.manao.hub.plist
launchctl print gui/$(id -u)/dev.manao.hub     # state = running, last exit code
curl -s localhost:7420/api/sources               # both Sources Healthy
```

After `git pull && bun run build`, restart with `launchctl kickstart -k gui/$(id -u)/dev.manao.hub`. To uninstall, `launchctl bootout gui/$(id -u)/dev.manao.hub` and delete the plist.

Stopping on purpose: `launchctl bootout` unloads the job, so it stays down until you `bootstrap` it again. `kill -TERM` on the hub exits 0, so launchd does not restart it now, but the job stays loaded and `RunAtLoad` starts it again at the next login; `launchctl kickstart gui/$(id -u)/dev.manao.hub` starts it sooner.

Logs are `~/Library/Logs/manao/hub.out.log` (the startup lines) and `hub.err.log` (why a start failed: invalid config, taken port, unreadable store). The service reads the same config and store as a manual run (`MANAO_CONFIG`, `~/.config/manao/config.json`, `~/.local/share/manao/hub.db`); the template sets neither.

The `node` path is written into the plist. With nvm it contains the Node version, so after an nvm upgrade or uninstall the service fails to start: fill the template in again and `launchctl bootout` then `bootstrap` it (the install block above does both). Full Disk Access grants (below) are keyed to the binary path, so grant the new `node` again too.

macOS may refuse processes launchd starts access to `~/Documents`, where a Brain-Dump vault usually lives. Until `node` and `bun` are allowed, the Brain-Dump Source reports a permission error and its Todos go Stale. In System Settings, Privacy & Security, Full Disk Access, add both binaries (`command -v node`, `~/.bun/bin/bun`); in the file picker press Cmd+Shift+. to show hidden folders such as `~/.nvm` and `~/.bun`. Files and Folders, Documents, also works if the binaries appear there after a prompt, but it only lists apps that have already prompted, so Full Disk Access is the reliable route. Then restart it with `launchctl kickstart -k gui/$(id -u)/dev.manao.hub` and check `/api/sources` again.

The first time the service's `bun` reads `~/Documents`, macOS may also ask "would like to access files in your Documents folder", and the read waits on that dialog (the Brain-Dump Source times out) until you click Allow. The dialog can open behind other windows or on another Space, so look for it if Todos stay Stale after granting Full Disk Access.

Keep the vault out of an iCloud-synced folder. With iCloud Drive's Desktop & Documents Folders and Optimize Mac Storage on, iCloud replaces uploaded files with placeholders, and macOS will not download a placeholder for a process launchd started: Brain-Dump fails with `EDEADLK` until something in the foreground reads the file. Obsidian Sync already keeps the vault current, so move it out of `~/Documents` (download every file first with Finder's Download Now, so no placeholder is moved), point Brain-Dump at it with `vault = <new path>` in `~/.config/brain-dump/config`, reopen it in Obsidian, and restart the hub with `launchctl kickstart -k gui/$(id -u)/dev.manao.hub`.

## The API

`manao run` serves a read-only JSON API on `127.0.0.1` and prints its address at startup. Config: `"api": { "port": 7420 }` (the default; `0` picks a free port), or `"api": false` to run the hub without it. If the port is taken, the hub refuses to start and names the port.

```
curl -s localhost:7420/api/items                            # every Item
curl -s 'localhost:7420/api/items?type=agent&attention=true' # agents that need you
curl -s localhost:7420/api/sources                          # how each Source is doing
```

`GET /api/items` returns `{ now, items }`. `now` is the hub's clock, so "3 minutes ago" is computed against the hub, not the phone. Every Item carries `sourceOk` (false means Stale: its Source is not Healthy) and `lastOkAt`. Optional filters: `type`, `status`, `attention` (`true` or `false`).

```
curl -s 'localhost:7420/api/events?after=0&limit=100'          # the first page of Events
curl -s 'localhost:7420/api/events?since=2026-10-19T08:00:00Z' # every Event since 08:00 UTC
```

`GET /api/events` returns `{ now, events, next, more }`, Events in id order. Page with `after` (an Event id, default 0) and `limit` (1 to 500, default 100): `next` is the highest id returned, or `after` when none were, and `more` is true when the page is full. Poll with `after=<next>` to never miss or repeat an Event. Or ask for every Event at or after a time with `since`, an ISO 8601 date or a time with `Z` or an offset (write `+` as `%2B`). A plain date such as `2026-10-19` means midnight UTC, not midnight on the hub's clock. `since` cannot be combined with `after` or `limit`, and its `more` is always false. Its `next` is the highest id returned, or the newest stored Event's id when nothing matched (0 if there are no Events), so polling on with `after=<next>` never replays older Events.

`GET /api/sources` returns `{ now, sources }`, one entry per Source that has reported, ordered by Source: its latest Health (`ok`, `at`, `error` and `note` when present, `staleAfterMs`), `lastOkAt` (its last success, kept through failures; null if it never succeeded) and `healthy`, the hub's Healthy rule: the latest report is ok and no older than `staleAfterMs`. It takes no parameters. It is not a liveness check: if the hub is down, the request simply fails.

`GET /api/measurements` returns `{ now, measurements }`: one entry per Metric and day, `{ source, metric, date, value, unit, sourceOk, lastOkAt }`, ordered by Metric, then date. `metric` (`steps`, `sleep`, `resting-heart-rate` or `active-zone-minutes`) is optional; `from` and `to` are local dates (`YYYY-MM-DD`), inclusive, defaulting to the 7 days ending Today (`to` alone gives the 7 days ending `to`), at most 366 days, `from` not after `to`.

`GET /api/agenda` returns the Agenda, what is on your plate Today: `{ now, attention, appointments, todos, staleSources }`. `attention` holds every Item with Attention, from any Source and of any type, ordered by Source, type, then as the Adapter sent them; `appointments` holds every Appointment running at any time Today (the hub's date, in its time zone), ended ones included, all-day first, then by start, then by title; `staleSources` holds the Health of every Source that is not Healthy, so you know what the Agenda may be missing. Items are as `/api/items` returns them, and a Stale Source's Items stay, marked `sourceOk: false`. `todos` holds the open Todos of the current Weekly Note in line order, each keeping `groupPath`, `line` and `parentId` in `data`; done and dropped ones are left out. It takes no parameters.

Every endpoint is GET only and answers with JSON. Errors are `{ "error": "..." }`: 400 for an unknown, repeated or malformed parameter (the message names it), 403 for a `Host` other than `localhost:<port>`, `127.0.0.1:<port>` or a `*.ts.net` name (this blocks DNS rebinding from a browser on the same machine), 404 for an unknown path and 405 for any method but GET. There is no authentication and no CORS: the API only listens on localhost, and your tailnet is the boundary.

To reach it from your phone, put it on your tailnet with HTTPS (one command on the hub host, run once; it persists across restarts):

```
tailscale serve --bg 7420      # https://<machine>.<tailnet>.ts.net/api/items -> 127.0.0.1:7420
tailscale serve status         # check it
tailscale serve --https=443 off   # undo
```

Never use `tailscale funnel`: it publishes the API to the internet.

## Dashboard

The hub serves a read-only dashboard at `/`, beside `/api` on the same port. It opens on **Today** (`/#today`), the Agenda: what needs you now, from every Source, then Today's Appointments, then your open Todos nested as the Weekly Note reads them. The **All** tab (`/#all`, which you can bookmark) has the full detail: agents, the week's Appointments, the Weekly Note's Todos, your Measurements over the last 7 days (latest value and a bar per day, an empty slot for a day without data), this week's paper-bot Picks and each Source's Health. Each view reads only its own endpoints, every 10 seconds while the page is open, and at once when you switch. `bun run build` builds it into `dist/dashboard` together with the hub, so a hub restarted after a build always serves the matching dashboard. Without a build, `/` answers 404 saying to run `bun run build`, and the API keeps working.

On the hub host, build, (re)start the hub, and put the port on your tailnet with HTTPS. Use your `api.port` if you changed it from 7420:

```
bun run build
launchctl kickstart -k gui/$(id -u)/dev.manao.hub   # or: node dist/cli.js run
tailscale serve --bg 7420
tailscale serve status    # prints the https://<machine>.<tailnet>.ts.net address
```

Never `tailscale funnel`. On the phone (signed in to the same tailnet), open the `https://…ts.net/` address that `tailscale serve status` printed. To install it on Android, open Chrome's menu and choose Add to home screen, then Install; it opens full screen like an app. The install needs HTTPS, which `tailscale serve` provides; plain `http://` to the hub host's tailnet IP shows the dashboard but cannot install it.

The installed app keeps only its shell (the page, scripts, styles and icons) in a service worker cache, so it opens at once and can say the hub is unreachable while offline. It never caches `/api`: what it shows always came from the hub. After a rebuild and restart, the next time the app opens or reloads it finds the new service worker, which takes over at once (it does not wait for open windows to close) and removes the old shell. A window that was already open keeps the page it loaded until it reloads.

Papers lists the week's Picks by day, newest first. Each shows its title (a link to the paper, only when the link is `https:`), its Interests, why it was picked, and whether it is a Wildcard or kept. Each day's heading links to that day's Briefing as `obsidian://open?file=<path in the vault>`. manao does not know the vault's name, so the link names none and Obsidian opens the note in the vault it has open. That works when the device has one vault; with several, open the vault that holds the Briefings first.

For UI work, `bun run dev:dashboard` runs Vite's dev server with `/api` proxied to a running hub (`MANAO_API`, default `http://127.0.0.1:7420`); it does not install the service worker.

## Use from an agent

`manao mcp` is a read-only MCP server over stdio. An agent's client launches it; it reads the store `manao run` writes (the same `MANAO_DB`, config `dbPath` or default lookup) and needs no config of its own. Register it with Claude Code on the hub host (build first, and use absolute paths):

```
claude mcp add manao -- node /path/to/manao/dist/cli.js mcp
```

From another machine, run the same command over SSH on the hub host. Remote SSH registration has not yet been verified. `BatchMode` keeps SSH from prompting, and the remote command must print nothing to stdout but the protocol (no shell banners):

```
claude mcp add manao -- ssh -o BatchMode=yes <hub-host> /path/to/node /path/to/manao/dist/cli.js mcp
```

Tools (each marked `readOnlyHint`, so a client can run it without asking):

- `list_items`: optional `type`, `status`, `attention` (a boolean). Returns `{ now, items }`, each Item with `sourceOk` and `lastOkAt`, the same as `GET /api/items`.
- `list_events`: `after` (an Event id, default 0) with `limit` (1 to 500), or `since` (ISO 8601) alone. Returns `{ now, events, next, more }` with the same rules as `GET /api/events`, except that `limit` defaults to 25, not 100: Claude Code cuts tool output beyond about 11k characters, and a smaller page arrives whole. Pass `next` as `after` until `more` is false.
- `list_sources`: no arguments. Returns `{ now, sources }`, each Source that has reported with its latest Health, `lastOkAt` (its last success) and `healthy`, the same as `GET /api/sources`. Use it to answer "is the hub working".
- `agenda`: no arguments. Returns `{ now, attention, appointments, todos, staleSources }`, the same as `GET /api/agenda` and exactly what the dashboard's Today view shows. Use it to answer "what is on my plate today" or "what needs me".
- `list_measurements`: optional `metric`, `from`, `to`, with the same rules and defaults as `GET /api/measurements`. Returns `{ now, measurements }`, each with its unit. Use it to answer "how have I slept this week".

Every result's text starts with a Stale warning when a Source is not Healthy, naming it and when it last reported success, then the JSON. A bad argument is an error result naming the parameter. If the store cannot be read (the hub has never run, is still creating it, or it was written by a newer manao), the tool returns an error naming the path; if the config cannot be read, it names the config and the field. Either way the next call tries again, so there is no need to restart the client once the hub is running or the config is fixed. The server never writes to the store.

## Status vocabulary

Each agent reports its own status to herdr-core (the program, not the screen, says what it is doing).

| herdr-core | Hub               | Meaning                                                      |
| ---------- | ----------------- | ------------------------------------------------------------ |
| working    | `running`         | In flight                                                    |
| blocked    | `needs_attention` | Waiting on a permission or a question (`data.blockedKind`)   |
| error      | `needs_attention` | Stopped on an error (`data.statusLabel` is `error`)          |
| done       | `finished`        | Finished its work; `idle` 30 minutes after it finished       |
| idle       | `idle`            | Ready for input                                              |
| other      | `unknown`         | A status manao does not know yet                           |

A terminal running a plain shell reports no status and is not an agent. `data.activity` is the agent's own status message, else the terminal's title.

## How it plugs into the hub

`HerdrAdapter` implements `SourceAdapter` (`src/core/types.ts`). It calls an `ItemSink`:

- `replaceItems(source, "agent", items)` with the full current list every refresh
- `emitEvents([...])` with `agent.transition` events (kinds: `appeared`, `changed`, `cycled`, `gone`; `completed: true` when work finished)
- `reportHealth(source, health)` every refresh; on failure the item list is left as it was, so stale data is visible rather than silently empty

The SQLite store (`src/store/`) is that sink in the hub; the API (`src/api/`) reads it inside the hub process, and the MCP server reads it read-only from its own process. Item `id` is herdr-core's terminal address (`t7`), stable for the terminal's life.

## Safety model

Keep runtime configuration, OAuth credentials, stores and logs outside the checkout, in the default home-directory locations described above. The ignore rules cover common local copies, but fixtures and shared issue reports must use synthetic data; redact personal paths, account ids, task content and health data before sharing output or screenshots.

herdr-core's socket has no authentication, and the same surface can type into terminals, run programs, write files and stop the core. `src/herdr/client.ts` holds an allowlist (`READ_ONLY_METHODS`: `hello`, `server.status`, `terminal.list`, `terminal.get`, `events.subscribe`) and throws before sending anything else; `test/client.test.ts` checks that every other method is refused without touching the socket. `terminal.read`, `terminal.attach`, `file.read` and `doc.get` are excluded on purpose because they return screen text, files or documents. A terminal's command line (`argv`, `foreground`) is never stored.

## Refresh model

A poll (default 5s) is the safety net. An `events.subscribe` subscription on its own connection is a best-effort nudge: an `event` or `missed` notification triggers a re-read of `terminal.list` (bursts coalesced into one), a `heartbeat` does not, nor do `title`, `size`, `doc` and `keep` events (a working agent retitles its terminal about every 100ms), and payloads are never trusted. After a drop or a refused subscription it reconnects with backoff, and re-reads once subscribed again.

## What is and is not verified

References such as `legacy-77` identify pre-publication development tickets, not issues in this repository. The technical decisions are documented here; new issues belong to ChrisKalahiki/manao.

Verified by tests (`bun run test`): the store (replace, `updatedAt`, Events paging, Health and Staleness, removing Sources, retention pruning); the hub and its config; the API over real HTTP (filters, Events paging, the Host, method, path and parameter guards, startup and shutdown); the MCP server through an MCP client (`list_items` filters, `list_events` paging, `since` and its default of 25, `list_sources` Health and Healthy, argument errors, the Stale warning, a missing, schema-less or newer store, an unreadable config, recovery once the store exists) and over stdio; state mapping and transition logic against a synthetic `terminal.list`; the client, its protocol generation check and read-only guard; the adapter's poll, coalescing, failure and recovery behavior; the event channel's nudges, coalescing, reconnect and resubscribe behavior. The socket tests run against a fake herdr-core written from `hc` 0.1.16's own answers.

Verified against herdr-core (`hc` 0.1.16, issue `legacy-87`): the hub under launchd reaches the default socket; Claude Code and Codex agents map as expected through working, a permission prompt, done and idle, with the matching Attention and Events; the Agents widget and Today's "Needs you" render correctly in the mobile dashboard. Viewing a finished Codex terminal clears its `done`; Claude Code keeps `done` until its next prompt, which is why `finished` ages out after 30 minutes.

Verified against Brain-Dump: Todo Status, grouping and parent relationships match the CLI; synced changes trigger refreshes; missing commands preserve Stale data and recover on a later poll.

Verified against the Google Health API (issues `legacy-67` and `legacy-72`): backfill and aggregation matched API responses; Calendar and Health share one sign-in; API and MCP Measurements agree; Stale indicators recover after a successful refresh.

Timestamps are when the hub observed a change, not when Herdr did, so their resolution is the poll interval or event latency.
