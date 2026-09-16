
"use strict";

require("dotenv").config();
const net    = require("net");
const http   = require("http");
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");
const express  = require("express");
const { Server } = require("socket.io");

// Optional — run: npm install music-metadata@7
let musicMetadata = null;
try { musicMetadata = require("music-metadata"); } catch { /* covers disabled */ }

// ─── Config ───────────────────────────────────────────────────────────────
const CONFIG = {
  webPort:  9090,
  musicDir: path.resolve(__dirname, "music"),
  botHost:  "127.0.0.1",
  botPort:  58913,
  username: process.env.WEB_USERNAME,
  password: process.env.WEB_PASSWORD,
  /** How often to poll TS3AudioBot (ms). Higher = fewer API calls / less flood risk. */
  botPollMs: 4000,

  // TS3 ServerQuery — fill in password to enable "who's in channel" feature.
  // Leave TS3_QUERY_PASSWORD unset/empty to disable.
  ts3Query: {
    host:     "127.0.0.1",
    port:     10011,
    sid:      1,
    username: process.env.TS3_QUERY_USERNAME || "serveradmin",
    password: process.env.TS3_QUERY_PASSWORD || "",
  },

  // Spotify/SoundCloud import — downloader service on the other server.
  importApi: {
    url: process.env.IMPORT_API_URL || "",
    key: process.env.IMPORT_API_KEY || "",
  },
};

// ─── Sessions ──────────────────────────────────────────────────────────────
// token -> expiry timestamp (ms). Sessions live 12h and are swept lazily.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
function createSession() {
  const t = crypto.randomBytes(24).toString("hex");
  sessions.set(t, Date.now() + SESSION_TTL_MS);
  return t;
}
function validSession(t) {
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(t); return false; }
  return true;
}
function destroySession(t) { sessions.delete(t); }
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of sessions) if (now > exp) sessions.delete(t);
}, 60 * 60 * 1000);

// ─── Playback state ────────────────────────────────────────────────────────
let queue           = [];
let queueIndex      = -1;
let botWasPlaying   = false;
let shuffleMode     = false;
let repeatMode      = "none"; // "none" | "all" | "one"
let shuffledOrder   = [];
let lastKnownVolume = 50;

function reshuffleOrder() {
  shuffledOrder = queue.map((_,i)=>i).sort(()=>Math.random()-0.5);
}
function nextIdx() {
  if (shuffleMode) {
    if (!shuffledOrder.length) reshuffleOrder();
    const p = shuffledOrder.indexOf(queueIndex);
    return shuffledOrder[(p+1) % shuffledOrder.length];
  }
  return queueIndex + 1;
}
function prevIdx() {
  if (shuffleMode) {
    if (!shuffledOrder.length) reshuffleOrder();
    const p = shuffledOrder.indexOf(queueIndex);
    return shuffledOrder[(p-1+shuffledOrder.length) % shuffledOrder.length];
  }
  return queueIndex - 1;
}

// ─── Raw TCP bot helper ────────────────────────────────────────────────────
// Uses net.createConnection instead of http.request to bypass Node's URL
// validation. This sends the path byte-for-byte, exactly like curl does.
function botGet(urlPath) {
  return new Promise((resolve) => {
    const client = net.createConnection({ host: CONFIG.botHost, port: CONFIG.botPort });
    const timer  = setTimeout(() => { client.destroy(); resolve(null); }, 5000);
    let raw = Buffer.alloc(0);

    client.on("connect", () => {
      client.write(`GET ${urlPath} HTTP/1.0\r\nHost: ${CONFIG.botHost}:${CONFIG.botPort}\r\nConnection: close\r\n\r\n`);
    });
    client.on("data",  chunk => { raw = Buffer.concat([raw, chunk]); });
    client.on("end",   () => {
      clearTimeout(timer);
      try {
        const text = raw.toString("utf8");
        const sep  = text.indexOf("\r\n\r\n");
        const body = (sep >= 0 ? text.slice(sep + 4) : text).trim();
        resolve(body ? JSON.parse(body) : null);
      } catch { resolve(null); }
    });
    client.on("error", e => { clearTimeout(timer); console.error("[botGet]", e.message); resolve(null); });
  });
}

const botPlay = f => {
  // encodeURIComponent handles spaces and special chars in the filename.
  // Raw TCP (not http.request) means the () in the path structure are sent
  // byte-for-byte exactly like curl — no Node URL validation issues.
  const urlPath = `/api/bot/use/0/(/play/${encodeURIComponent(f)})`;
  console.log("[botPlay] →", urlPath);
  return botGet(urlPath).then(r => { console.log("[botPlay] ←", JSON.stringify(r)); return r; });
};
const botCmd    = cmd => botGet(`/api/bot/use/0/(/${cmd})`);
const botVolume = v   => botGet(`/api/bot/use/0/(/volume/${Math.round(v)})`);
const botSeek   = sec => botGet(`/api/bot/use/0/(/seek/${Math.max(0, Math.round(sec))})`);

// ─── TS3 ServerQuery client list ──────────────────────────────────────────
function ts3Decode(s) {
  return (s||"").replace(/\\s/g," ").replace(/\\n/g,"\n").replace(/\\p/g,"|").replace(/\\\\/g,"\\");
}

// Resolves { ok, clients }. ok=false means connect/login/parse failed —
// distinct from ok=true with an empty clients array (genuinely empty channel).
function fetchTs3Clients() {
  const q = CONFIG.ts3Query;
  if (!q || !q.password) return Promise.resolve({ ok: true, clients: [] });
  return new Promise((resolve) => {
    const sock  = net.createConnection({ host: q.host, port: q.port });
    const timer = setTimeout(() => {
      console.error("[ts3query] Timed out connecting to", q.host + ":" + q.port);
      sock.destroy(); resolve({ ok: false, clients: [] });
    }, 8000);
    // steps: 0=banner 1=login 2=use 3=clientlist data
    let buf = "", step = 0, clientsRaw = "";

    const send = cmd => { console.log("[ts3query] →", cmd); sock.write(cmd + "\n"); };

    sock.on("data", chunk => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        console.log("[ts3query] ←", line.slice(0, 120));

        if (step === 0) {
          // Wait for the TS3 welcome banner, then login
          if (line === "TS3") continue;
          if (line.startsWith("Welcome to")) {
            step = 1;
            send(`login client_login_name=${q.username} client_login_password=${q.password}`);
          }
          continue;
        }

        if (line.startsWith("error ")) {
          if (!line.startsWith("error id=0")) {
            clearTimeout(timer); sock.destroy();
            console.error("[ts3query] Server returned error:", line);
            resolve({ ok: false, clients: [] }); return;
          }
          if (step === 1) {
            step = 2;
            send(`use sid=${q.sid}`);
          } else if (step === 2) {
            step = 3;
            send("clientlist");
          } else if (step === 3) {
            clearTimeout(timer); sock.destroy();
            try {
              const clients = clientsRaw.split("|").map(e => {
                const g = k => ((e.match(new RegExp(`\\b${k}=([^\\s|]+)`)) || [])[1] || "");
                return {
                  id:   g("clid"),
                  cid:  g("cid"),
                  name: ts3Decode(g("client_nickname")),
                  type: parseInt(g("client_type")) || 0,
                };
              }).filter(c => c.type === 0); // type 0 = regular user, not query client
              console.log("[ts3query] Found", clients.length, "users:", clients.map(c=>c.name).join(", "));
              resolve({ ok: true, clients });
            } catch(e) { console.error("[ts3query] Parse error:", e.message); resolve({ ok: false, clients: [] }); }
            return;
          }
        } else if (step === 3) {
          clientsRaw += line;
        }
      }
    });
    sock.on("error", e => {
      clearTimeout(timer);
      console.error("[ts3query] Connection error:", e.message);
      resolve({ ok: false, clients: [] });
    });
    sock.on("close", () => { clearTimeout(timer); resolve({ ok: false, clients: [] }); });
  });
}

let cachedClients       = [];
let clientsLastFetch    = 0;
let ts3ConsecutiveFails  = 0;
let ts3NextRetryAt       = 0;
let ts3LastAlertedFailed = false;
const TS3_BACKOFF_STEPS_MS = [10000, 30000, 60000, 120000, 300000]; // 10s,30s,1m,2m,5m cap

async function fetchTs3ClientsWithBackoff() {
  if (!CONFIG.ts3Query.password) return [];
  if (Date.now() < ts3NextRetryAt) return cachedClients;

  const { ok, clients } = await fetchTs3Clients();

  if (ok) {
    if (ts3ConsecutiveFails > 0) console.log("[ts3query] Recovered after", ts3ConsecutiveFails, "failed attempt(s)");
    ts3ConsecutiveFails = 0;
    ts3NextRetryAt = 0;
    ts3LastAlertedFailed = false;
    return clients;
  }

  ts3ConsecutiveFails++;
  const step = Math.min(ts3ConsecutiveFails - 1, TS3_BACKOFF_STEPS_MS.length - 1);
  ts3NextRetryAt = Date.now() + TS3_BACKOFF_STEPS_MS[step];
  console.error(
    `[ts3query] Fetch failed (${ts3ConsecutiveFails} in a row). Backing off ${TS3_BACKOFF_STEPS_MS[step] / 1000}s.`
  );
  return cachedClients; // keep last-known-good list instead of flashing empty
}

// ─── Music scanner ─────────────────────────────────────────────────────────
function scanMusic() {
  if (!fs.existsSync(CONFIG.musicDir)) fs.mkdirSync(CONFIG.musicDir, { recursive: true });
  return fs.readdirSync(CONFIG.musicDir)
    .filter(f => /\.(mp3|ogg|flac|wav|m4a|opus)$/i.test(f))
    .sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(f => {
      const st = fs.statSync(path.join(CONFIG.musicDir, f));
      return {
        file: f,
        name: path.basename(f, path.extname(f)),
        ext:  path.extname(f).slice(1).toUpperCase(),
        size: st.size,
        mtime: st.mtimeMs,
      };
    });
}

/** Parsed tags from disk (TS3AudioBot /song often omits artist for local files). */
const fileMetaCache = new Map();
async function getCachedFileMeta(file) {
  if (!file || !musicMetadata) return null;
  if (fileMetaCache.has(file)) return fileMetaCache.get(file);
  const fp = path.join(CONFIG.musicDir, file);
  try {
    const m = await musicMetadata.parseFile(fp, { duration: false, skipCovers: true });
    const artist = m.common.artist || (m.common.artists && m.common.artists[0]) || null;
    const title = m.common.title || null;
    const album = m.common.album || null;
    const meta = { artist, title, album };
    fileMetaCache.set(file, meta);
    return meta;
  } catch {
    fileMetaCache.set(file, {});
    return {};
  }
}

function songArtistFromBot(song) {
  if (!song || song.ErrorCode) return null;
  return song.Artist || song.AudioArtist || song.ResourceSubtitle || song.ResourceOwnerLine || null;
}

// ─── Bot state ─────────────────────────────────────────────────────────────
async function fetchBotState() {
  try {
    const [song, vol] = await Promise.all([
      botGet("/api/bot/use/0/(/song)"),
      botGet("/api/bot/use/0/(/volume)"),
    ]);
    const ok = song && !song.ErrorCode;
    const volNum = (typeof vol === "number" && !isNaN(vol)) ? Math.round(vol) : null;
    if (volNum !== null) lastKnownVolume = volNum;
    const botArtist = ok ? songArtistFromBot(song) : null;
    const botTitle = ok ? song.Title : null;
    return {
      online:    true,
      isPlaying: ok && !song.Paused,
      isPaused:  ok &&  song.Paused,
      title:     botTitle,
      artist:    botArtist,
      position:  ok ? song.Position : 0,
      duration:  ok ? song.Length   : 0,
      volume:    lastKnownVolume,
    };
  } catch {
    return { online:false, isPlaying:false, isPaused:false, title:null, artist:null, position:0, duration:0, volume:lastKnownVolume };
  }
}

async function buildState(bot) {
  const library = scanMusic();
  const cur = queue[queueIndex];
  let displayTitle = bot.title;
  let displayArtist = bot.artist || null;
  if (cur && cur.file) {
    const meta = await getCachedFileMeta(cur.file);
    if (meta) {
      if (!displayArtist && meta.artist) displayArtist = meta.artist;
      if (meta.title) displayTitle = meta.title;
    }
    if (!displayTitle) displayTitle = cur.name;
  }
  return {
    ...bot,
    displayTitle: displayTitle || null,
    displayArtist: displayArtist || null,
    library,
    queue,
    queueIndex,
    shuffleMode,
    repeatMode,
    clients: cachedClients,
    ts3Enabled: !!CONFIG.ts3Query.password,
  };
}

// ─── Auto-advance ──────────────────────────────────────────────────────────
async function checkAutoAdvance() {
  const s = await fetchBotState();
  if (botWasPlaying && !s.isPlaying && !s.isPaused && queueIndex >= 0) {
    if (repeatMode === "one") {
      await botPlay(queue[queueIndex].file); botWasPlaying = true;
    } else {
      const n = nextIdx();
      const canAdvance = shuffleMode ? true : n < queue.length;
      if (canAdvance && queue[n]) {
        queueIndex = n; botWasPlaying = true; await botPlay(queue[queueIndex].file);
      } else if (repeatMode === "all" && queue.length) {
        if (shuffleMode) reshuffleOrder();
        queueIndex = shuffleMode ? shuffledOrder[0] : 0;
        botWasPlaying = true; await botPlay(queue[queueIndex].file);
      } else {
        queueIndex = -1; botWasPlaying = false;
      }
    }
  } else {
    botWasPlaying = s.isPlaying;
  }
  return s;
}

// ─── Multipart file upload parser ──────────────────────────────────────────
function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks);
        const ct   = req.headers["content-type"] || "";
        const bm   = ct.match(/boundary=(.+)$/);
        if (!bm) return reject(new Error("No boundary"));
        const boundary = Buffer.from("--" + bm[1].trim());
        let start = 0;
        const parts = [];
        for (let i = 0; i <= body.length - boundary.length; i++) {
          if (body.slice(i, i+boundary.length).equals(boundary)) {
            if (start > 0) parts.push(body.slice(start, i-2));
            start = i + boundary.length + 2;
          }
        }
        const files = [];
        for (const part of parts) {
          const sep = part.indexOf("\r\n\r\n");
          if (sep < 0) continue;
          const headers = part.slice(0, sep).toString();
          const content = part.slice(sep+4);
          const nm = headers.match(/filename="([^"]+)"/);
          if (!nm) continue;
          files.push({ filename: path.basename(nm[1]), content });
        }
        resolve(files);
      } catch(e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ─── Express ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin:"*" } });

app.use(express.json());

function sessionTokenFromRequest(req) {
  const h = req.headers["x-session"];
  if (h && validSession(h)) return h;
  const q = req.query && (req.query.token || req.query.session);
  if (q && validSession(String(q))) return String(q);
  const auth = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && validSession(m[1].trim())) return m[1].trim();
  return null;
}

function requireAuth(req, res, next) {
  if (sessionTokenFromRequest(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}

app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === CONFIG.username && password === CONFIG.password) {
    res.json({ token: createSession() });
  } else {
    res.status(401).json({ error: "Wrong username or password" });
  }
});

app.post("/auth/logout", requireAuth, (req, res) => {
  destroySession(sessionTokenFromRequest(req));
  res.json({ ok: true });
});

// If `safe` already exists on disk, append " (2)", " (3)", ... before the
// extension so a same-named upload never silently clobbers an existing track.
function dedupeFilename(safe) {
  const ext  = path.extname(safe);
  const base = path.basename(safe, ext);
  let candidate = safe;
  let n = 2;
  while (fs.existsSync(path.join(CONFIG.musicDir, candidate))) {
    candidate = `${base} (${n})${ext}`;
    n++;
  }
  return candidate;
}

app.post("/upload", requireAuth, async (req, res) => {
  try {
    const files = await parseUpload(req);
    const saved = [];
    for (const { filename, content } of files) {
      if (!/\.(mp3|ogg|flac|wav|m4a|opus)$/i.test(filename)) continue;
      const safe = dedupeFilename(filename.replace(/[()[\]]/g, "").replace(/\s+/g, " ").trim());
      fs.writeFileSync(path.join(CONFIG.musicDir, safe), content);
      fileMetaCache.delete(safe);
      saved.push(safe);
    }
    res.json({ saved });
    io.emit("library", scanMusic());
  } catch(e) {
    console.error("[upload]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Spotify/SoundCloud import — proxies to the downloader service on the
// other server, which downloads the track and drops it straight into
// musicDir via SFTP; we just rescan afterward so it shows up immediately.
app.post("/api/import", requireAuth, async (req, res) => {
  const url = (req.body && req.body.url || "").trim();
  if (!url) return res.status(400).json({ error: "لینک ارسال نشده" });
  if (!CONFIG.importApi.url || !CONFIG.importApi.key) {
    return res.status(503).json({ error: "سرویس دریافت پیکربندی نشده است" });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const resp = await fetch(CONFIG.importApi.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": CONFIG.importApi.key },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      return res.status(resp.status || 500).json({ error: data.error || "دانلود ناموفق بود" });
    }
    fileMetaCache.delete(data.filename);
    io.emit("library", scanMusic());
    res.json({ filename: data.filename });
  } catch (e) {
    console.error("[import]", e.message);
    const timedOut = e.name === "AbortError";
    res.status(504).json({ error: timedOut ? "زمان دانلود بیش از حد طول کشید" : "خطا در ارتباط با سرویس دانلود" });
  }
});

// File download
app.get("/download/:file", requireAuth, (req, res) => {
  const file = path.basename(req.params.file);
  const fp   = path.join(CONFIG.musicDir, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Not found" });
  res.download(fp, file);
});

// Cover art
app.get("/cover/:file", requireAuth, async (req, res) => {
  if (!musicMetadata) return res.status(404).end();
  const file = path.basename(req.params.file);
  const fp   = path.join(CONFIG.musicDir, file);
  if (!fs.existsSync(fp)) return res.status(404).end();
  try {
    const meta  = await musicMetadata.parseFile(fp, { skipCovers: false });
    const cover = musicMetadata.selectCover(meta.common.picture);
    if (!cover) return res.status(404).end();
    res.set("Content-Type", cover.format);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(cover.data);
  } catch { res.status(404).end(); }
});

app.use(express.static(path.join(__dirname, "public")));

// ─── Socket.io ────────────────────────────────────────────────────────────
io.use((socket, next) => {
  if (validSession(socket.handshake.auth?.token)) return next();
  next(new Error("Unauthorized"));
});

async function broadcastState() {
  const s = await checkAutoAdvance();
  if (Date.now() - clientsLastFetch > 10000) {
    cachedClients    = await fetchTs3ClientsWithBackoff();
    clientsLastFetch = Date.now();
  }
  io.emit("state", await buildState(s));
}

setInterval(broadcastState, CONFIG.botPollMs || 4000);

io.on("connection", async (socket) => {
  console.log("[web] connected:", socket.id);
  cachedClients    = await fetchTs3ClientsWithBackoff();
  clientsLastFetch = Date.now();
  socket.emit("state", await buildState(await fetchBotState()));

  async function playIdx(idx) {
    if (idx < 0 || idx >= queue.length) return;
    queueIndex = idx; botWasPlaying = true;
    await botPlay(queue[idx].file);
    setTimeout(broadcastState, 700);
  }

  socket.on("playNow", async ({ file }) => {
    const lib   = scanMusic();
    const track = lib.find(t => t.file === file);
    if (!track) { console.warn("[playNow] Not found:", file); return; }
    const idx = queue.findIndex(t => t.file === file);
    if (idx >= 0) { await playIdx(idx); }
    else {
      queue = [track]; queueIndex = 0;
      if (shuffleMode) reshuffleOrder();
      botWasPlaying = true;
      await botPlay(file);
      setTimeout(broadcastState, 700);
    }
  });

  socket.on("addToQueue", async ({ file }) => {
    const track = scanMusic().find(t => t.file === file);
    if (!track) { console.warn("[addToQueue] Not found:", file); return; }
    queue.push(track);
    if (shuffleMode) reshuffleOrder();
    if (queueIndex < 0) { queueIndex = queue.length-1; botWasPlaying = true; await botPlay(file); }
    setTimeout(broadcastState, 400);
  });

  socket.on("addAll", async () => {
    const lib = scanMusic();
    if (!lib.length) return;
    queue = [...lib];
    if (shuffleMode) reshuffleOrder();
    if (queueIndex < 0) {
      queueIndex = shuffleMode ? shuffledOrder[0] : 0;
      botWasPlaying = true;
      await botPlay(queue[queueIndex].file);
    }
    setTimeout(broadcastState, 400);
  });

  socket.on("playQueueIndex", ({ index }) => playIdx(index));

  socket.on("reorderQueue", ({ from, to }) => {
    if (from<0||to<0||from>=queue.length||to>=queue.length) return;
    const item = queue.splice(from,1)[0];
    queue.splice(to,0,item);
    if      (queueIndex === from)                     queueIndex = to;
    else if (from < queueIndex && to >= queueIndex)   queueIndex--;
    else if (from > queueIndex && to <= queueIndex)   queueIndex++;
    if (shuffleMode) reshuffleOrder();
    broadcastState();
  });

  socket.on("removeFromQueue", ({ index }) => {
    if (index<0||index>=queue.length) return;
    queue.splice(index,1);
    if (queueIndex >= queue.length) queueIndex = queue.length-1;
    if (shuffleMode) reshuffleOrder();
    broadcastState();
  });

  socket.on("clearQueue", async () => {
    await botCmd("stop");
    queue=[]; queueIndex=-1; botWasPlaying=false; shuffledOrder=[];
    setTimeout(broadcastState,300);
  });

  socket.on("pause", async () => {
    const s = await fetchBotState();
    if (s.isPlaying) { await botCmd("pause"); botWasPlaying=false; }
    else if (s.isPaused) { await botCmd("play"); botWasPlaying=true; }
    setTimeout(broadcastState,400);
  });

  socket.on("stop", async () => {
    await botCmd("stop"); botWasPlaying=false; queueIndex=-1;
    setTimeout(broadcastState,300);
  });

  socket.on("next", async () => {
    if (!queue.length) return;
    const n = nextIdx();
    if (n < queue.length) { await playIdx(n); }
    else if (repeatMode==="all") { await playIdx(0); }
  });

  socket.on("prev", async () => {
    if (!queue.length) return;
    const p = prevIdx();
    if (p >= 0) await playIdx(p);
  });

  socket.on("volume", async ({ value }) => {
    lastKnownVolume = Math.round(value);
    await botVolume(value);
    setTimeout(broadcastState,300);
  });

  socket.on("seek", async ({ seconds }) => {
    const sec = Math.max(0, Math.round(Number(seconds) || 0));
    await botSeek(sec);
    setTimeout(broadcastState, 400);
  });

  socket.on("toggleShuffle", () => {
    shuffleMode = !shuffleMode;
    if (shuffleMode) reshuffleOrder(); else shuffledOrder=[];
    broadcastState();
  });

  socket.on("cycleRepeat", () => {
    repeatMode = repeatMode==="none"?"all":repeatMode==="all"?"one":"none";
    broadcastState();
  });

  socket.on("deleteFile", ({ file, confirmPhrase }) => {
    if (confirmPhrase !== "DELETE") {
      console.warn("[deleteFile] rejected: confirmPhrase must be DELETE");
      return;
    }
    const base = path.basename(String(file || ""));
    if (!base || base !== String(file || "").replace(/\\/g, "/").split("/").pop()) {
      console.warn("[deleteFile] rejected: invalid file");
      return;
    }
    const p = path.join(CONFIG.musicDir, base);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      fileMetaCache.delete(base);
      queue = queue.filter(t => t.file !== base);
      if (queueIndex >= queue.length) queueIndex = queue.length - 1;
    }
    broadcastState();
  });

  socket.on("rescan", async () => {
    fileMetaCache.clear();
    socket.emit("state", await buildState(await fetchBotState()));
  });

  socket.on("disconnect", () => console.log("[web] disconnected:", socket.id));
});

if (!CONFIG.username || !CONFIG.password) {
  console.error("Missing WEB_USERNAME or WEB_PASSWORD in .env");
  process.exit(1);
}

server.listen(CONFIG.webPort, "0.0.0.0", () => {
  console.log(`[web]   http://0.0.0.0:${CONFIG.webPort}`);
  console.log(`[auth]  user "${CONFIG.username}" configured (see .env)`);
  console.log(`[music] ${CONFIG.musicDir}`);
  if (CONFIG.ts3Query.password)
    console.log(`[ts3]   ServerQuery enabled @ ${CONFIG.ts3Query.host}:${CONFIG.ts3Query.port}`);
  else
    console.log(`[ts3]   ServerQuery disabled (set TS3_QUERY_PASSWORD in .env to enable)`);
});
