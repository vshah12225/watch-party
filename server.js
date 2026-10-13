const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// true  = only the host can play/pause/seek
// false = everyone can (good for testing concurrent actions)
const HOST_ONLY = false;

const DEFAULT_VIDEO =
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

app.use(express.static(path.join(__dirname, "public")));
// Invite link: /room/ABC123 -> same page, the frontend reads the code from the URL
app.get("/room/:code", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ---------- Room storage (in memory) ----------
const rooms = new Map(); // code -> room

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

function createRoom(hostId) {
  const room = {
    code: makeCode(),
    hostId,
    users: new Map(), // socket.id -> name
    nextId: 1, // used to give ids to playlist items and polls
    playlist: [], // { id, title, url, addedBy, addedById }
    poll: null, // see poll:create
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

  socket.on("room:create", ({ name } = {}, cb) => {
    const r = createRoom(socket.id);
    enter(r, name);
    cb && cb({ ok: true, code: r.code });
  });

  // Also used for late joins AND reconnects (client calls it again on reconnect)
  socket.on("room:join", ({ code, name } = {}, cb) => {
    const r = rooms.get(String(code || "").toUpperCase());
    if (!r) return cb && cb({ ok: false, error: "Room not found" });
    if (room) leave(); // in case of a double join
    enter(r, name);
    cb && cb({ ok: true, code: r.code });
  });

  // Anyone can ask for the latest state (used for drift checks)
  socket.on("state:get", (cb) => room && cb && cb(snapshot(room)));

  function canControl() {
    return room && (!HOST_ONLY || room.hostId === socket.id);
  }

  // ----- playback -----
  socket.on("playback:play", ({ position } = {}) => {
    if (!canControl()) return;
    changeState(room, {
      isPlaying: true,
      position: Number.isFinite(position) ? position : currentPosition(room),
    });
  });

  socket.on("playback:pause", ({ position } = {}) => {
    if (!canControl()) return;
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
    if (!/^https?:\/\//i.test(url)) return; // only http(s) links
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
    broadcast(room);
  });

  function leave() {
    if (!room) return;
    const r = room;
    room = null;
    r.users.delete(socket.id);
    if (r.poll) r.poll.votes.delete(socket.id); // their vote leaves with them
    socket.leave(r.code);
    if (r.users.size === 0) {
      rooms.delete(r.code);
      return;
    }
    if (r.hostId === socket.id) r.hostId = [...r.users.keys()][0]; // next user becomes host
    broadcast(r);
  }

  socket.on("disconnect", leave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Watch Party running on http://localhost:${PORT}`));
