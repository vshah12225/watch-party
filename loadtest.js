// Load test for Watch Party
// Usage:  node loadtest.js [clients] [rounds]
// Example: node loadtest.js 10 200
//
// Needs the server running (npm start) and HOST_ONLY = false in server.js.
// Everything runs on one machine, so all clients share one clock and the
// latency numbers are accurate (no clock offset problem).

const { io } = require("socket.io-client");

const URL = process.env.URL || "http://localhost:3000";
const N = parseInt(process.argv[2] || "10", 10);
const ROUNDS = parseInt(process.argv[3] || "200", 10);
const BURSTS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6; // milliseconds
const rand = (n) => Math.floor(Math.random() * n);

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, i))];
}

async function main() {
  console.log(`Connecting ${N} clients to ${URL} ...`);
  const clients = [];
  for (let i = 0; i < N; i++) {
    const socket = io(URL, { transports: ["websocket"] });
    const c = { id: i, socket, state: null, onUpdate: null };
    socket.on("state:update", (s) => {
      c.state = s;
      if (c.onUpdate) c.onUpdate(s);
    });
    clients.push(c);
  }
  await Promise.all(
    clients.map((c) => new Promise((res) => c.socket.on("connect", res)))
  );

  // Client 0 creates the room, everyone else joins it
  const code = await new Promise((res) =>
    clients[0].socket.emit("room:create", { name: "load0" }, (r) => res(r.code))
  );
  await Promise.all(
    clients.slice(1).map(
      (c, i) =>
        new Promise((res) =>
          c.socket.emit("room:join", { code, name: "load" + (i + 1) }, res)
        )
    )
  );
  await sleep(500);
  console.log(`Room ${code} ready with ${clients[0].state.users.length} users.\n`);

  // ---------- Test 1: one action at a time, measure how long until EVERY client has it ----------
  console.log(`Test 1: ${ROUNDS} sequential actions (play / pause / seek) ...`);
  const latencies = [];
  let missed = 0;
  const actions = ["play", "pause", "seek"];

  for (let r = 0; r < ROUNDS; r++) {
    const sender = clients[rand(N)];
    const action = actions[rand(actions.length)];
    const position = Math.random() * 100;
    const expectedVersion = clients[0].state.version + 1;
    const t0 = now();
    let got = 0;

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        missed += N - got; // clients that never got the update within 2 s
        clients.forEach((c) => (c.onUpdate = null));
        resolve();
      }, 2000);

      clients.forEach((c) => {
        c.onUpdate = (s) => {
          if (s.version === expectedVersion) {
            latencies.push(now() - t0);
            c.onUpdate = null;
            if (++got === N) {
              clearTimeout(timer);
              resolve();
            }
          }
        };
      });
      sender.socket.emit("playback:" + action, { position });
    });
    await sleep(20);
  }

  // ---------- Test 2: several clients act at the same moment, do all clients end up the same? ----------
  console.log(`Test 2: ${BURSTS} bursts of simultaneous actions ...`);
  let inconsistent = 0;
  for (let b = 0; b < BURSTS; b++) {
    const howMany = Math.min(N, 3 + rand(3)); // 3 to 5 clients act together
    const senders = [...clients].sort(() => Math.random() - 0.5).slice(0, howMany);
    senders.forEach((c) => {
      const action = actions[rand(actions.length)];
      c.socket.emit("playback:" + action, { position: Math.random() * 100 });
    });
    await sleep(400);
    const ref = clients[0].state;
    const same = clients.every(
      (c) =>
        c.state.version === ref.version &&
        c.state.isPlaying === ref.isPlaying &&
        c.state.position === ref.position
    );
    if (!same) inconsistent++;
  }

  // ---------- Results ----------
  latencies.sort((a, b) => a - b);
  const mean = latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1);
  const p95 = percentile(latencies, 95);
  const results = {
    clients: N,
    rounds: ROUNDS,
    deliveries: latencies.length,
    missed,
    latency_ms: {
      mean: +mean.toFixed(2),
      p50: +percentile(latencies, 50).toFixed(2),
      p95: +p95.toFixed(2),
      p99: +percentile(latencies, 99).toFixed(2),
      max: +(latencies[latencies.length - 1] || NaN).toFixed(2),
    },
    concurrent_bursts: BURSTS,
    inconsistent_bursts: inconsistent,
    target_p95_under_250ms: p95 <= 250,
    when: new Date().toISOString(),
  };

  console.log("\n===== RESULTS =====");
  console.log(`Clients in room:        ${N}`);
  console.log(`Deliveries measured:    ${latencies.length} (missed: ${missed})`);
  console.log(`Latency  mean/p50/p95:  ${results.latency_ms.mean} / ${results.latency_ms.p50} / ${results.latency_ms.p95} ms`);
  console.log(`Latency  p99/max:       ${results.latency_ms.p99} / ${results.latency_ms.max} ms`);
  console.log(`p95 <= 250 ms target:   ${results.target_p95_under_250ms ? "PASS" : "FAIL"}`);
  console.log(`Concurrent bursts:      ${BURSTS - inconsistent}/${BURSTS} ended with all clients identical`);

  require("fs").writeFileSync("loadtest-results.json", JSON.stringify(results, null, 2));
  console.log("\nSaved to loadtest-results.json (copy these into your documentation).");

  clients.forEach((c) => c.socket.disconnect());
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
