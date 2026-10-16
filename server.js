  require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so req.ip is the visitor, not the proxy
const server = http.createServer(app);
const io = new Server(server);

// true  = only the host can play/pause/seek
// false = everyone can (good for testing concurrent actions)
const HOST_ONLY = false;

// true  = only the host can pause and unpause (everyone else can still seek and pick videos)
// false = anyone in the room can pause and unpause
const HOST_ONLY_PLAY_PAUSE = true;

// When the host's connection drops (closed tab, bad Wi-Fi) the room waits this long for them to come back.
// If they press Leave / Close room themselves, the room closes at once.
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 15000;

const DEFAULT_VIDEO =
  "https://www.youtube.com/watch?v=B6NVvtIz9_Q&t=2628s";

app.use(express.static(path.join(__dirname, "public")));
  require("./movies")(app);
// Invite link: /room/ABC123 -> same page, the frontend reads the code from the URL
app.get("/room/:code", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ---------- Room storage (in memory) ----------
const rooms = new Map(); // code -> room
   require("./health")(app, io, rooms);

// ---------- Video library (uploaded videos, kept on disk + a small JSON "database") ----------
// On a host with a temporary disk (Render free, etc.) set DATA_DIR to a persistent disk, or uploads are lost on restart.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const LIB_FILE = path.join(DATA_DIR, "library.json");
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 3072) * 1024 * 1024;       // one file (3 GB)
const MAX_LIBRARY = (Number(process.env.MAX_LIBRARY_GB) || 10) * 1024 * 1024 * 1024; // all files together (10 GB)
const VIDEO_TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg" };
fs.mkdirSync(MEDIA_DIR, { recursive: true });

let library = []; // { id, title, file, size, owner (friend id), by (name), addedAt }
try { library = JSON.parse(fs.readFileSync(LIB_FILE, "utf8")); } catch (e) { library = []; }
library = library.filter((v) => fs.existsSync(path.join(MEDIA_DIR, v.file))); // forget entries whose file is gone

function saveLibrary() {
  const tmp = LIB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(library));
  fs.renameSync(tmp, LIB_FILE); // swap in one step so a crash never leaves a half-written file
}
const libraryUrl = (v) => "/media/" + v.file;
function safeDecode(s) { try { return decodeURIComponent(String(s || "Guest")); } catch (e) { return "Guest"; } }
const uploadsByIp = new Map(); // ip -> uploads running right now (we allow 1 at a time)
const libraryTotal = () => library.reduce((n, v) => n + v.size, 0);
const libraryByUrl = (url) => library.find((v) => libraryUrl(v) === url);

// the files themselves (express.static also supports seeking, which the video player needs)
app.use("/media", express.static(MEDIA_DIR, {
  index: false,
  dotfiles: "deny",
  setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
}));

app.get("/api/library", (req, res) => {
  const fid = String(req.query.fid || "").toUpperCase();
  res.json({
    maxMb: Math.round(MAX_UPLOAD / 1024 / 1024),
    // "mine" tells the page whether to show a Delete button. The owner's Friend ID itself is never sent out.
    videos: library.map((v) => ({ id: v.id, title: v.title, size: v.size, by: v.by, addedAt: v.addedAt, url: libraryUrl(v), mine: !!fid && fid === v.owner })),
  });
});

// Upload: the browser sends the raw file as the request body (PUT), we stream it to disk.
// Only people who are inside a room can upload.
app.put("/api/library/upload", (req, res) => {
  const reject = (code, msg) => { res.set("Connection", "close"); res.status(code).json({ error: msg }); };
  const code = String(req.get("x-room-code") || "").toUpperCase();
  if (!rooms.has(code)) return reject(403, "Join a room first, then upload.");
  const name = String(req.query.name || "video").slice(0, 150);
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_TYPES[ext]) return reject(415, "Use an .mp4, .webm, .mov, .m4v or .ogv file.");
  const size = Number(req.get("content-length"));
  if (!Number.isFinite(size) || size <= 0) return reject(411, "Empty or unknown file size.");
  if (size > MAX_UPLOAD) return reject(413, "That file is too big (limit " + Math.round(MAX_UPLOAD / 1024 / 1024) + " MB).");
  if (libraryTotal() + size > MAX_LIBRARY) return reject(507, "The video library is full. Delete a video first.");

  const ip = req.ip;
  if (uploadsByIp.get(ip)) return reject(429, "One upload at a time. Wait for the first one to finish.");
  uploadsByIp.set(ip, true);
  res.on("close", () => uploadsByIp.delete(ip));

  const id = crypto.randomBytes(6).toString("hex");
  const file = id + ext;
  const dest = path.join(MEDIA_DIR, file);
  const out = fs.createWriteStream(dest);
  let received = 0, failed = false;
  const fail = (code2, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.unlink(dest, () => {});
    if (!res.headersSent) reject(code2, msg);
  };
  req.on("data", (chunk) => { received += chunk.length; if (received > size || received > MAX_UPLOAD) { req.unpipe(out); fail(413, "Upload was larger than announced."); } });
  req.on("close", () => { if (!req.complete) fail(499, "Upload cancelled."); });
  req.on("error", () => fail(500, "Upload failed."));
  out.on("error", () => fail(500, "Could not save the file."));
  out.on("finish", () => {
    if (failed) return;
    if (received !== size) return fail(400, "Upload was incomplete.");
    const entry = {
      id,
      title: path.basename(name, ext).replace(/[_]+/g, " ").trim().slice(0, 100) || "Untitled video",
      file,
      size,
      owner: String(req.get("x-owner") || "").toUpperCase().slice(0, 6),
      by: safeDecode(req.get("x-name")).slice(0, 24) || "Guest",
      addedAt: Date.now(),
    };
    library.push(entry);
    saveLibrary();
    io.emit("library:changed");
    res.json({ ok: true, id });
  });
  req.pipe(out);
});

// Delete: only the browser that uploaded it (same Friend ID) can remove it
app.delete("/api/library/:id", (req, res) => {
  const v = library.find((x) => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: "Video not found." });
  const owner = String(req.get("x-owner") || "").toUpperCase();
  if (!owner || owner !== v.owner) return res.status(403).json({ error: "Only the person who uploaded it can delete it." });
  library = library.filter((x) => x.id !== v.id);
  saveLibrary();
  fs.unlink(path.join(MEDIA_DIR, v.file), () => {});
  rooms.forEach((r) => { // take it out of every playlist too
    const before = r.playlist.length;
    r.playlist = r.playlist.filter((i) => i.url !== libraryUrl(v));
    if (r.playlist.length !== before) broadcast(r);
  });
  io.emit("library:changed");
  res.json({ ok: true });
});

const presence = new Map(); // friend id -> Set of socket ids that have the site open

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

// tidy a room name: no line breaks or long runs of spaces, at most 32 characters
function cleanRoomName(s) { return String(s || "").replace(/\s+/g, " ").trim().slice(0, 32); }

function createRoom(hostId, isPublic, roomName) {
  const room = {
    code: makeCode(),
    rid: crypto.randomBytes(4).toString("hex"), // public id of the room, safe to show in lists (the code is the secret)
    name: roomName,
    hostId,
    hostFid: null, // Friend ID of the host, so the same person can take the host seat back after a dropped connection
    closeTimer: null, // set while we wait for a host whose connection dropped
    isPublic: !!isPublic, // true = shown in the public rooms list, false = only people with the code or link can join
    users: new Map(), // socket.id -> name
    nextId: 1, // used to give ids to playlist items and polls
    playlist: [], // { id, title, url, addedBy, addedById }
    poll: null, // see poll:create
    banned: new Set(), // friend ids of people the host removed (they cannot come back)
    state: {
      videoUrl: DEFAULT_VIDEO,
      currentItemId: null, // which playlist item is playing (null = default video)
      isPlaying: false,
      position: 0, // seconds, at the moment of updatedAt
      updatedAt: Date.now(), // server time of last change
      version: 0, // goes up on every playback change
    },
  };
  rooms.set(room.code, room);
  return room;
}

// Poll as the clients see it (counts instead of raw votes)
function pollView(room) {
  const p = room.poll;
  if (!p) return null;
  const counts = p.options.map(() => 0);
  p.votes.forEach((i) => counts[i]++);
  return {
    id: p.id,
    question: p.question,
    creatorId: p.creatorId,
    open: p.open,
    options: p.options.map((o, i) => ({ text: o.text, count: counts[i] })),
    votes: Object.fromEntries(p.votes), // socketId -> option index
  };
}

// What we send to clients. serverNow lets them calculate the current position.
function snapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    isPublic: room.isPublic,
    name: room.name,
    users: [...room.users].map(([id, name]) => ({ id, name })),
    playlist: room.playlist,
    poll: pollView(room),
    ...room.state,
    serverNow: Date.now(),
  };
}

function broadcast(room) {
  io.to(room.code).emit("state:update", snapshot(room));
}

function currentPosition(room) {
  const s = room.state;
  return s.isPlaying ? s.position + (Date.now() - s.updatedAt) / 1000 : s.position;
}

// Playback change: updates the time, bumps the version, tells everyone
function changeState(room, changes) {
  Object.assign(room.state, changes, {
    updatedAt: Date.now(),
    version: room.state.version + 1,
  });
  broadcast(room);
}

function playItem(room, item) {
  changeState(room, {
    videoUrl: item.url,
    currentItemId: item.id,
    isPlaying: true,
    position: 0,
  });
}

function systemMessage(room, text) {
  io.to(room.code).emit("chat:system", text);
}

// The host left: tell everyone, take them all out of the room, and delete the room
function closeRoom(r, message) {
  clearTimeout(r.closeTimer);
  r.closeTimer = null;
  rooms.delete(r.code);
  io.to(r.code).emit("room:closed", { message });
  [...r.users.keys()].forEach((id) => {
    const s = io.sockets.sockets.get(id);
    if (s && s.data.leaveQuietly) s.data.leaveQuietly();
  });
  r.users.clear();
}

// ---------- Socket events ----------
io.on("connection", (socket) => {
  let room = null;

  // Clock sync: the client measures round trip and works out the offset
  socket.on("time:ping", (cb) => cb(Date.now()));

  function enter(r, name) {
    room = r;
    room.users.set(socket.id, name || "Guest");
    socket.join(room.code);
    broadcast(room);
    systemMessage(room, `${name || "Guest"} joined`);
  }

  socket.on("room:create", ({ name, isPublic, roomName, fid } = {}, cb) => {
    adoptFid(fid);
    const hostName = String(name || "Guest").trim().slice(0, 24) || "Guest";
    const r = createRoom(socket.id, isPublic === true, cleanRoomName(roomName) || hostName + "'s room");
    r.hostFid = socket.data.fid || null;
    if (room) leave("button"); // creating a room means leaving the old one
    enter(r, name);
    cb && cb({ ok: true, code: r.code });
  });

  // Also used for late joins AND reconnects (client calls it again on reconnect)
  socket.on("room:join", ({ code, name, rid, fid } = {}, cb) => {
    adoptFid(fid); // before the ban check: on a reconnect this message can arrive before presence:hello
    const r = rooms.get(String(code || "").toUpperCase());
    if (!r) return cb && cb({ ok: false, error: rid ? "That code is not right." : "Room not found" });
    if (rid && r.rid !== rid) return cb && cb({ ok: false, error: "That code is not right for this room." });
    if (socket.data.fid && r.banned.has(socket.data.fid))
      return cb && cb({ ok: false, error: "The host removed you from this room." });
    if (room === r) return cb && cb({ ok: true, code: r.code }); // already inside this room
    if (room) leave("button"); // joining another room means leaving this one
    // the host's connection dropped a moment ago and the same person is back: give the seat back
    const hostIsBack = !!r.closeTimer && !!socket.data.fid && r.hostFid === socket.data.fid;
    if (hostIsBack) {
      clearTimeout(r.closeTimer);
      r.closeTimer = null;
      r.hostId = socket.id;
    }
    enter(r, name);
    if (hostIsBack) systemMessage(r, "The host is back.");
    cb && cb({ ok: true, code: r.code });
  });

  // The lobby asks for the lists of rooms.
  // Public rooms come with their code, so one click joins.
  // Private rooms are shown by name only: their code is never sent, so you have to know it.
  socket.on("rooms:list", (cb) => {
    if (typeof cb !== "function") return;
    const live = [...rooms.values()]
      .filter((r) => r.users.size > 0)
      .sort((a, b) => b.users.size - a.users.size);
    const view = (r, withCode) => ({
      rid: r.rid,
      name: r.name,
      host: r.users.get(r.hostId) || "Guest",
      count: r.users.size,
      ...(withCode ? { code: r.code } : {}),
    });
    cb({
      public: live.filter((r) => r.isPublic).slice(0, 30).map((r) => view(r, true)),
      private: live.filter((r) => !r.isPublic).slice(0, 30).map((r) => view(r, false)),
    });
  });

  // Anyone can ask for the latest state (used for drift checks)
  socket.on("state:get", (cb) => room && cb && cb(snapshot(room)));

  function canControl() {
    return room && (!HOST_ONLY || room.hostId === socket.id);
  }

  // ----- playback -----
  // Guests may not pause or unpause when HOST_ONLY_PLAY_PAUSE is on.
  // auto: true means the video simply reached its end (every client reports that),
  // so a guest's copy of it is ignored quietly instead of being treated as a refused action.
  function guestBlocked(auto) {
    if (!HOST_ONLY_PLAY_PAUSE || room.hostId === socket.id) return false;
    if (!auto) {
      socket.emit("playback:denied", {}); // the guest's player goes back to the room's state
      socket.emit("chat:system", "Only the host can pause or unpause the video.");
    }
    return true;
  }

  socket.on("playback:play", ({ position, auto } = {}) => {
    if (!canControl() || guestBlocked(auto)) return;
    changeState(room, {
      isPlaying: true,
      position: Number.isFinite(position) ? position : currentPosition(room),
    });
  });

  socket.on("playback:pause", ({ position, auto } = {}) => {
    if (!canControl() || guestBlocked(auto)) return;
    changeState(room, {
      isPlaying: false,
      position: Number.isFinite(position) ? position : currentPosition(room),
    });
  });

  socket.on("playback:seek", ({ position } = {}) => {
    if (!canControl() || !Number.isFinite(position)) return;
    changeState(room, { position }); // keeps isPlaying as it was
  });

  // ----- shared playlist -----
  socket.on("playlist:add", ({ title, url } = {}) => {
    if (!room) return;
    url = String(url || "").trim();
    if (!/^https?:\/\//i.test(url) && !libraryByUrl(url)) return; // only http(s) links or videos from our library
    if (room.playlist.length >= 50) return;
    room.playlist.push({
      id: room.nextId++,
      title: String(title || "").trim().slice(0, 100) || url.slice(0, 100),
      url: url.slice(0, 500),
      addedBy: room.users.get(socket.id),
      addedById: socket.id,
    });
    broadcast(room);
  });

  // ----- video library: put an uploaded video in the playlist, or play it right away -----
  function queueLibraryVideo(v) {
    const url = libraryUrl(v);
    let item = room.playlist.find((i) => i.url === url);
    if (item) return item; // already queued
    if (room.playlist.length >= 50) return null;
    item = { id: room.nextId++, title: v.title, url, addedBy: room.users.get(socket.id), addedById: socket.id };
    room.playlist.push(item);
    return item;
  }
  socket.on("library:queue", ({ id } = {}) => {
    if (!room) return;
    const v = library.find((x) => x.id === id);
    if (v && queueLibraryVideo(v)) broadcast(room);
  });
  socket.on("library:play", ({ id } = {}) => {
    if (!canControl()) return;
    const v = library.find((x) => x.id === id);
    const item = v && queueLibraryVideo(v);
    if (item) playItem(room, item); // this also broadcasts
  });

  socket.on("playlist:remove", ({ id } = {}) => {
    if (!room) return;
    const item = room.playlist.find((i) => i.id === id);
    if (!item) return;
    // only the host or the person who added it can remove it
    if (room.hostId !== socket.id && item.addedById !== socket.id) return;
    room.playlist = room.playlist.filter((i) => i.id !== id);
    broadcast(room);
  });

  socket.on("playlist:play", ({ id } = {}) => {
    if (!canControl()) return;
    const item = room.playlist.find((i) => i.id === id);
    if (item) playItem(room, item);
  });

  // Sent by every client when the video ends. Only the first one counts,
  // because after the first one currentItemId changes.
  socket.on("playlist:next", ({ itemId } = {}) => {
    if (!room || room.state.currentItemId !== itemId || itemId == null) return;
    const idx = room.playlist.findIndex((i) => i.id === itemId);
    const next = room.playlist[idx + 1];
    if (idx !== -1 && next) playItem(room, next);
  });

  // ----- group polls -----
  // Either custom options, or fromPlaylist: true to vote on what to watch next
  socket.on("poll:create", ({ question, options, fromPlaylist } = {}) => {
    if (!room) return;
    let opts;
    if (fromPlaylist) {
      opts = room.playlist.slice(0, 6).map((i) => ({ text: i.title, itemId: i.id }));
      question = "What should we watch next?";
    } else {
      opts = (Array.isArray(options) ? options : [])
        .map((o) => String(o).trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 6)
        .map((text) => ({ text }));
      question = String(question || "").trim().slice(0, 150);
    }
    if (opts.length < 2 || !question) return;

    room.poll = {
      id: room.nextId++,
      question,
      options: opts,
      votes: new Map(), // socket.id -> option index
      open: true,
      creatorId: socket.id,
    };
    broadcast(room);
    systemMessage(room, `${room.users.get(socket.id)} started a poll: ${question}`);
  });

  socket.on("poll:vote", ({ index } = {}) => {
    const p = room && room.poll;
    if (!p || !p.open) return;
    if (!Number.isInteger(index) || index < 0 || index >= p.options.length) return;
    p.votes.set(socket.id, index); // voting again changes your vote
    broadcast(room);
  });

  socket.on("poll:close", () => {
    const p = room && room.poll;
    if (!p || !p.open) return;
    if (socket.id !== room.hostId && socket.id !== p.creatorId) return;
    p.open = false;

    const counts = p.options.map(() => 0);
    p.votes.forEach((i) => counts[i]++);
    const max = Math.max(...counts);
    if (max === 0) {
      systemMessage(room, "Poll closed with no votes");
      return broadcast(room);
    }
    const winner = p.options[counts.indexOf(max)]; // ties: first option wins
    systemMessage(room, `Poll closed: "${winner.text}" wins with ${max} vote(s)`);

    const item = winner.itemId && room.playlist.find((i) => i.id === winner.itemId);
    if (item) playItem(room, item); // this also broadcasts
    else broadcast(room);
  });

  // ----- chat, reactions, host -----
  socket.on("chat:message", (text) => {
    if (!room || !text) return;
    io.to(room.code).emit("chat:message", {
      from: room.users.get(socket.id),
      text: String(text).slice(0, 500),
      at: Date.now(),
    });
  });

  socket.on("reaction:send", (emoji) => {
    if (!room) return;
    io.to(room.code).emit("reaction:show", {
      from: room.users.get(socket.id),
      emoji: String(emoji).slice(0, 8),
    });
  });

  socket.on("host:transfer", ({ toId } = {}) => {
    if (!room || room.hostId !== socket.id || !room.users.has(toId)) return;
    room.hostId = toId;
    const newHost = io.sockets.sockets.get(toId);
    room.hostFid = (newHost && newHost.data.fid) || null;
    broadcast(room);
  });

  // ----- friends: invites for people who have the site open -----
  const FID = /^[A-Z2-9]{6}$/;
  const lastInvite = new Map(); // friend id -> time of the last invite this host sent

  function unregister() {
    const f = socket.data.fid;
    if (!f) return;
    const set = presence.get(f);
    if (set) {
      set.delete(socket.id);
      if (!set.size) presence.delete(f);
    }
    socket.data.fid = null;
  }

  // Every page says who it is (its Friend ID) when it connects
  function adoptFid(raw) {
    const f = String(raw || "").toUpperCase();
    if (!FID.test(f) || socket.data.fid === f) return;
    if (socket.data.fid) unregister();
    socket.data.fid = f;
    if (!presence.has(f)) presence.set(f, new Set());
    presence.get(f).add(socket.id);
  }
  socket.on("presence:hello", ({ fid } = {}) => adoptFid(fid));

  // Which of these friend ids are online right now?
  socket.on("friends:check", ({ ids } = {}, cb) => {
    if (typeof cb !== "function") return;
    const online = (Array.isArray(ids) ? ids : [])
      .slice(0, 50)
      .map((x) => String(x).toUpperCase())
      .filter((f) => presence.has(f));
    cb({ online });
  });

  // Host invites a friend: the friend's page shows a Join button
  socket.on("friend:invite", ({ fid } = {}, cb) => {
    const reply = (r) => typeof cb === "function" && cb(r);
    if (!room) return reply({ ok: false, error: "Join a room first." });
    if (room.hostId !== socket.id) return reply({ ok: false, error: "Only the host can send invites." });
    fid = String(fid || "").toUpperCase();
    if (!FID.test(fid)) return reply({ ok: false, error: "That Friend ID is not valid." });
    if (fid === socket.data.fid) return reply({ ok: false, error: "That is your own Friend ID." });
    if (room.banned.has(fid)) return reply({ ok: false, error: "You removed this person from the room." });
    const sockets = presence.get(fid);
    if (!sockets || !sockets.size)
      return reply({ ok: false, error: "Your friend is offline. Send them the invite link instead." });
    const targets = [...sockets].filter((id) => !room.users.has(id));
    if (!targets.length) return reply({ ok: false, error: "Your friend is already in this room." });
    if (Date.now() - (lastInvite.get(fid) || 0) < 3000)
      return reply({ ok: false, error: "Invite already sent. Wait a few seconds." });
    lastInvite.set(fid, Date.now());
    const from = room.users.get(socket.id);
    targets.forEach((id) => io.to(id).emit("invite:received", { code: room.code, from }));
    reply({ ok: true });
  });

  // ----- host removes someone -----
  socket.on("host:kick", ({ toId } = {}) => {
    if (!room || room.hostId !== socket.id || toId === socket.id || !room.users.has(toId)) return;
    const target = io.sockets.sockets.get(toId);
    const name = room.users.get(toId);
    if (target && target.data.fid) room.banned.add(target.data.fid);
    if (target) target.data.kicked = true;
    systemMessage(room, `${name} was removed by the host`);
    if (target) {
      target.emit("room:kicked", { by: room.users.get(socket.id) });
      target.disconnect(true); // their disconnect handler removes them from the room
    }
  });

  // how: "button" = they chose to leave, "disconnect" = connection dropped or tab closed
  function leave(how) {
    if (!room) return;
    const r = room;
    room = null;
    const name = r.users.get(socket.id) || "Someone";
    const wasHost = r.hostId === socket.id;
    r.users.delete(socket.id);
    if (r.poll) r.poll.votes.delete(socket.id); // their vote leaves with them
    socket.leave(r.code);
    if (r.users.size === 0) {
      clearTimeout(r.closeTimer);
      rooms.delete(r.code);
      return;
    }
    if (wasHost) {
      if (how === "disconnect") {
        // might only be a dropped connection: wait a moment for the host to come back
        clearTimeout(r.closeTimer);
        r.closeTimer = setTimeout(() => closeRoom(r, "The host left, so the room was closed."), HOST_GRACE_MS);
        systemMessage(r, `${name} lost connection. The room closes in ${Math.round(HOST_GRACE_MS / 1000)} seconds unless the host comes back.`);
        return broadcast(r);
      }
      return closeRoom(r, `${name} ended the room.`); // the host chose to leave: the room closes now
    }
    if (!socket.data.kicked) systemMessage(r, `${name} left`);
    broadcast(r);
  }

  // used when the room closes: drop this person from it without any more messages
  socket.data.leaveQuietly = () => {
    if (!room) return;
    const r = room;
    room = null;
    r.users.delete(socket.id);
    socket.leave(r.code);
  };

  socket.on("room:leave", (cb) => {
    const wasHost = !!room && room.hostId === socket.id;
    leave("button");
    if (typeof cb === "function") cb({ ok: true, closed: wasHost });
  });

  socket.on("disconnect", () => {
    unregister();
    leave("disconnect");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Watch Party running on http://localhost:${PORT}`));
