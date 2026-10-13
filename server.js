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
    state: {
      videoUrl: DEFAULT_VIDEO,
      isPlaying: false,
      position: 0, // seconds, at the moment of updatedAt
      updatedAt: Date.now(), // server time of last change
      version: 0, // goes up on every change
    },
  };
  rooms.set(room.code, room);
  return room;
}

// What we send to clients. serverNow lets them calculate the current position.
function snapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    users: [...room.users].map(([id, name]) => ({ id, name })),
    ...room.state,
    serverNow: Date.now(),
  };
}

function currentPosition(room) {
  const s = room.state;
  return s.isPlaying ? s.position + (Date.now() - s.updatedAt) / 1000 : s.position;
}

function changeState(room, changes) {
  Object.assign(room.state, changes, {
    updatedAt: Date.now(),
    version: room.state.version + 1,
  });
  io.to(room.code).emit("state:update", snapshot(room));
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
    io.to(room.code).emit("state:update", snapshot(room));
    io.to(room.code).emit("chat:system", `${name || "Guest"} joined`);
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

  socket.on("video:change", ({ videoUrl } = {}) => {
    if (!canControl() || !videoUrl) return;
    changeState(room, { videoUrl, isPlaying: false, position: 0 });
  });

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
    io.to(room.code).emit("state:update", snapshot(room));
  });

  function leave() {
    if (!room) return;
    const r = room;
    room = null;
    r.users.delete(socket.id);
    socket.leave(r.code);
    if (r.users.size === 0) {
      rooms.delete(r.code);
      return;
    }
    if (r.hostId === socket.id) r.hostId = [...r.users.keys()][0]; // next user becomes host
    io.to(r.code).emit("state:update", snapshot(r));
  }

  socket.on("disconnect", leave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Watch Party running on http://localhost:${PORT}`));
