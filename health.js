// Sync health: every user's page reports how far its video is from the room (drift),
// the server shows a green / yellow / red dot per user and keeps statistics.
//
//   GET  /api/stats         -> numbers for your documentation (drift + network delay)
//   POST /api/stats/reset   -> start counting from zero
//   page: /stats.html       -> the same numbers as a live table
//
// Added to server.js with one line:  require("./health")(app, io, rooms);

const MAX_SAMPLES = 20000; // keep the last 20000 samples per player type

module.exports = function registerHealth(app, io, rooms) {
  const healthByRoom = new Map(); // room code -> Map(socket id -> { drift, at, player })
  const timers = new Map();       // room code -> timer (so we send at most 1 update per second)
  let stats = freshStats();

  function freshStats() {
    const one = () => ({ n: 0, under500: 0, drift: [], rtt: [] });
    return { since: Date.now(), players: { html5: one(), yt: one() } };
  }

  function push(arr, v) {
    arr.push(v);
    if (arr.length > MAX_SAMPLES) arr.splice(0, 5000);
  }

  function summarize(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const pct = (p) => s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))];
    const r = (x) => Math.round(x * 100) / 100;
    return {
      count: s.length,
      mean: r(s.reduce((a, b) => a + b, 0) / s.length),
      p50: r(pct(50)),
      p95: r(pct(95)),
      p99: r(pct(99)),
      max: r(s[s.length - 1]),
    };
  }

  // What the pages show: one status per user + a room score
  function healthView(code) {
    const room = rooms.get(code);
    const h = healthByRoom.get(code) || new Map();
    const now = Date.now();
    const users = {};
    let active = 0, inSync = 0;
    if (room) {
      room.users.forEach((name, id) => {
        const rep = h.get(id);
        let status = "idle", drift = null; // idle = paused, buffering, or no report lately
        if (rep && now - rep.at < 4000) {
          drift = rep.drift;
          const a = Math.abs(drift);
          status = a < 200 ? "good" : a <= 500 ? "ok" : "bad";
          active++;
          if (a <= 500) inSync++;
        }
        users[id] = { status, drift };
      });
    }
    return { users, active, inSync, total: room ? room.users.size : 0 };
  }

  function scheduleUpdate(code) {
    if (timers.has(code)) return;
    timers.set(code, setTimeout(() => {
      timers.delete(code);
      if (!rooms.has(code)) { healthByRoom.delete(code); return; } // room is gone
      io.to(code).emit("health:update", healthView(code));
    }, 1000));
  }

  io.on("connection", (socket) => {
    socket.on("sync:report", ({ driftMs, player, rtt } = {}) => {
      if (!Number.isFinite(driftMs)) return;
      const code = [...socket.rooms].find((r) => r !== socket.id);
      if (!code || !rooms.has(code)) return;

      if (!healthByRoom.has(code)) healthByRoom.set(code, new Map());
      healthByRoom.get(code).set(socket.id, { drift: driftMs, at: Date.now(), player });

      const s = stats.players[player === "yt" ? "yt" : "html5"];
      s.n++;
      if (Math.abs(driftMs) <= 500) s.under500++;
      push(s.drift, Math.abs(driftMs));
      if (Number.isFinite(rtt) && rtt >= 0 && rtt < 10000) push(s.rtt, rtt);

      scheduleUpdate(code);
    });

    socket.on("disconnect", () => {
      healthByRoom.forEach((h, code) => {
        if (h.delete(socket.id)) scheduleUpdate(code);
      });
    });
  });

  app.get("/api/stats", (req, res) => {
    const players = {};
    for (const [name, s] of Object.entries(stats.players)) {
      players[name] = {
        samples: s.n,
        percentWithin500ms: s.n ? Math.round((s.under500 / s.n) * 1000) / 10 : null,
        driftAbsMs: summarize(s.drift),
        roundTripMs: summarize(s.rtt),
        oneWayMsEstimate: summarize(s.rtt.map((x) => x / 2)), // round trip / 2
      };
    }
    res.json({
      since: new Date(stats.since).toISOString(),
      minutes: Math.round((Date.now() - stats.since) / 600) / 100,
      activeRooms: rooms.size,
      players,
    });
  });

  app.post("/api/stats/reset", (req, res) => {
    stats = freshStats();
    res.json({ ok: true });
  });
};
