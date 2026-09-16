# TS3 Music Bot

A self-hosted music bot for TeamSpeak 3, plus a web UI to control it —
play/pause, queue, browse a shared music library, upload tracks, and
import songs from Spotify/SoundCloud links.

> **Note:** Spotify/SoundCloud import is not self-contained — it needs a
> separate downloader service to actually be reachable (this repo only
> calls out to one via `IMPORT_API_URL`/`IMPORT_API_KEY`; it doesn't
> include or run one itself). Without that configured, everything else
> works fine and the "Import Link" feature just stays hidden. See
> [Spotify/SoundCloud import bridge](#spotifysoundcloud-import-bridge).

## What it is

Two processes working together on one server:

1. **[TS3AudioBot](https://github.com/Splamy/TS3AudioBot)** — the actual
   TeamSpeak client. It connects to your TeamSpeak server, joins a channel,
   and streams audio. This is an upstream open-source project (not part of
   this repo's code) — `install.sh` downloads the official release binary
   for you.
2. **Web controller** (`server.js` + `public/`) — a small Node/Express app
   that gives you a browser UI for the bot, since TS3AudioBot's own
   built-in web interface is minimal. This is the part actually written
   for this project.

## Architecture

The two processes never talk to each other directly over a custom
protocol — they're connected through two much simpler channels:

- **TS3AudioBot's own local Web API** (`http://127.0.0.1:58913`, only
  reachable from the same machine) — the web controller polls this to
  read the current playback state and sends it commands (play, pause,
  skip, volume, queue).
- **TeamSpeak ServerQuery** (`127.0.0.1:10011`) — used *only* to show
  who's currently in the channel; entirely optional (see Configuration).
- **A shared `music/` folder** on disk — both processes read from the same
  directory. TS3AudioBot plays files from it directly; the web controller
  lists/uploads/tags files in it.

```
 Browser  ──HTTP/WebSocket──▶  web controller (server.js, :9090)
                                     │
                          local Web API (:58913)      shared music/ folder
                                     │                          │
                                     ▼                          ▼
                              TS3AudioBot  ───────────────▶  TeamSpeak server
                           (ServerQuery :10011 too, optional)
```

Nothing here talks to the internet except: TS3AudioBot resolving YouTube
links (if you use that feature) and the optional Spotify/SoundCloud import
bridge, which is a *separate* external service you point `IMPORT_API_URL`
at — it is not part of this repo.

## Spotify/SoundCloud import bridge

The web UI's "Import Link" button doesn't download anything itself — it
makes one HTTP call to an external service and expects that service to
drop the finished file into this project's `music/` folder (over SFTP,
since that service usually runs on a *different* machine — downloading
audio reliably from Spotify/SoundCloud needs its own yt-dlp setup, which
doesn't belong bundled into a TeamSpeak bot).

**Protocol**, exactly as `server.js` calls it:

```
POST {IMPORT_API_URL}/import
  Headers: X-API-Key: {IMPORT_API_KEY}
  Body:    { "url": "<spotify or soundcloud link>" }
  Response: { "ok": true, "filename": "Artist - Title.mp3" }
          | { "ok": false, "error": "..." }
```

That's the entire contract — anything speaking this protocol works,
including something you write yourself. A reference implementation
(`import_api.py`) exists in the author's companion
[media-downloader-bale-telegram](https://github.com/Burdiya/media-downloader-bale-telegram)
project (the Telegram/Bale download bots) — it resolves the link, reuses
that project's yt-dlp setup to fetch it, then SFTPs the result into this
project's `music/` directory using credentials from *its own* `.env`
(`REMOTE_MUSIC_HOST`/`REMOTE_MUSIC_USER`/`REMOTE_MUSIC_DIR`/
`REMOTE_SSH_KEY_PATH`, pointing back at wherever *this* project lives).
Nothing on the media-downloader-bots side needs to be told anything about
TS3 or TeamSpeak — it's a completely generic "give me a link, get back a
file over SFTP" service from this project's point of view.

Skip this entirely if you don't need Spotify/SoundCloud import — the
rest of the app works fine without it.

## Requirements

- Linux server (x86_64, arm64, or armv7)
- Node.js 18+ (installed automatically by `install.sh` if missing)
- ffmpeg (installed automatically by `install.sh` if missing)
- A TeamSpeak 3 server you have ServerQuery access to (the bot needs a
  ServerQuery login to connect as a client — see below)
- ~100MB disk for TS3AudioBot itself, plus however much your music
  library needs

## Installation

```bash
git clone <this-repo-url>
cd ts3-music-bot
sudo ./install.sh
```

The script:
1. Installs ffmpeg/curl/tar if missing
2. Installs Node.js 18+ if missing (via NodeSource) or uses your existing
   Node if it's already new enough
3. Downloads the matching TS3AudioBot release for your architecture into
   `ts3audiobot/` (skipped if already present)
4. Copies `ts3audiobot/ts3audiobot.toml.example` → `ts3audiobot.toml` and
   `.env.example` → `.env` (skipped if either already exists — safe to
   re-run)
5. Runs `npm install` for the web controller
6. Installs `pm2` if missing, and optionally starts both processes under it

It's idempotent — re-running it after editing config just picks up where
it left off rather than overwriting anything.

## Configuration

### `.env` (web controller)

| Variable | Required | Purpose |
|---|---|---|
| `WEB_USERNAME` / `WEB_PASSWORD` | yes | Login for the web UI |
| `TS3_QUERY_USERNAME` / `TS3_QUERY_PASSWORD` | no | Enables the "who's online" panel via ServerQuery. Leave `TS3_QUERY_PASSWORD` blank to disable. Must match the `[query]` block below. |
| `IMPORT_API_URL` / `IMPORT_API_KEY` | no | Points at an external Spotify/SoundCloud downloader service, if you have one. Leave blank to hide the "Import Link" feature. |

### `ts3audiobot/ts3audiobot.toml` (the bot itself)

Full reference is inline as comments in the file; the parts you actually
need to change on a fresh setup:

- `[connect] address` — your TeamSpeak server's `host:port`
- `[query] username` / `password` — a ServerQuery login on that server
  (create one server-side with `serverquerylogin` if you don't have one)
- `[bot.connect] channel` — which channel the bot joins on startup
- `[bot.connect.identity] key` — leave blank to auto-generate a new
  TeamSpeak identity on first run, or paste an existing one
- `[factories] media.path` — defaults to `../music` (the shared folder),
  only change this if you moved things around

The web controller's port and the paths it uses are set directly at the
top of `server.js` (`CONFIG.webPort`, `CONFIG.musicDir`, etc.) rather than
via `.env` — edit those in code if you need to change them.

## Running

### Production (what `install.sh` sets up)

Both processes under `pm2`:

```bash
pm2 start ts3audiobot/TS3AudioBot --name ts3audiobot --cwd ts3audiobot
pm2 start server.js --name ts3-music-web --cwd .
pm2 save          # persist the process list
pm2 startup       # follow the printed instructions to survive a reboot
```

### Development

Run each in its own terminal so you see logs directly:

```bash
cd ts3audiobot && ./TS3AudioBot
```
```bash
node server.js
```

The web UI defaults to **http://localhost:9090**.

## Troubleshooting

**Web controller shows "Missing WEB_USERNAME or WEB_PASSWORD in .env" and exits**
`.env` wasn't filled in — copy `.env.example` to `.env` if `install.sh`
hasn't already, and set both values.

**Web UI loads but says the bot is offline / playback controls don't work**
TS3AudioBot isn't running, or its Web API is disabled. Check
`pm2 logs ts3audiobot`, and confirm `[web] enable = true` and
`[web.api] enabled = true` in `ts3audiobot.toml`.

**Bot won't connect to the TeamSpeak server**
Check `pm2 logs ts3audiobot` for the actual error. Common causes: wrong
`[connect] address`, wrong ServerQuery password, or the server's
ServerQuery whitelist blocking this machine's IP (`query_ip_whitelist.txt`
on the TeamSpeak server).

**"Who's online" panel is empty / ServerQuery features don't work**
This is optional and silently disabled if `TS3_QUERY_PASSWORD` is unset —
that's expected unless you specifically configured it.

**Uploaded/imported tracks show up but won't play**
The web controller sanitizes filenames on upload (strips `()[]`, since
those characters collide with TS3AudioBot's own command syntax). If a
file was placed into `music/` some other way (e.g. `scp`) with those
characters still in the name, rename it to match.

**Port 9090 already in use**
Something else is bound to it — change `CONFIG.webPort` in `server.js`,
or stop the conflicting process.
