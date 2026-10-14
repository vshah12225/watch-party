// Movie discovery for Watch Party (TMDB + fuzzy search + saved copy on disk)
// Needs a free TMDB key in a .env file:  TMDB_API_KEY=your_key_here
//
// Every successful load from TMDB is saved to data/movies-cache.json (movies, genres and
// trailer links). If TMDB can't be reached later (blocked network, no internet, no key),
// the saved copy is used, so search and trailers still work.
//
// Routes:
//   GET /api/movies/genres
//   GET /api/movies?q=&category=&genre=&year=&minRating=&limit=
//   GET /api/movies/:id/trailer   -> YouTube trailer link for a movie

const fs = require("fs");
const path = require("path");
const Fuse = require("fuse.js");

const TMDB = "https://api.themoviedb.org/3";
const CACHE_MS = 60 * 60 * 1000; // try to refresh the pool every hour
const RETRY_MS = 5 * 60 * 1000;  // but if TMDB is unreachable, wait 5 minutes between tries
const CACHE_FILE = process.env.MOVIES_CACHE_FILE || path.join(__dirname, "data", "movies-cache.json");

// ---------- saved copy on disk ----------
let pool = { at: 0, items: [] };
let genreCache = null;
let trailers = {}; // movie id -> { url, name }
let building = null;
let lastTry = 0;

function loadDisk() {
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (Array.isArray(d.items) && d.items.length) pool = { at: d.at || 0, items: d.items };
    if (Array.isArray(d.genres)) genreCache = d.genres;
    if (d.trailers && typeof d.trailers === "object") trailers = d.trailers;
    console.log(`[movies] loaded ${pool.items.length} saved movies and ${Object.keys(trailers).length} trailers`);
  } catch (e) {
    /* no saved copy yet, that's fine */
  }
}

function saveDisk() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: pool.at, items: pool.items, genres: genreCache, trailers }));
  } catch (e) {
    console.warn("[movies] could not save the cache:", e.message);
  }
}

// ---------- one call to TMDB (works with both the v3 "API Key" and the long "Read Access Token") ----------
async function tmdb(p, params = {}) {
  const key = (process.env.TMDB_API_KEY || "").trim();
  if (!key) throw new Error("NO_KEY");
  const url = new URL(TMDB + p);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = { accept: "application/json" };
  if (key.length > 40) headers.Authorization = "Bearer " + key;
  else url.searchParams.set("api_key", key);
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  } catch (e) {
    // "fetch failed" hides the real reason in e.cause (ENOTFOUND, ECONNRESET, ...)
    const code = e.name === "TimeoutError" ? "timeout" : (e.cause && (e.cause.code || e.cause.message)) || e.message;
    throw new Error("NETWORK " + code);
  }
  if (!res.ok) throw new Error("TMDB error " + res.status);
  return res.json();
}

// ---------- the pool: ~300 movies from several TMDB lists ----------
// We search this pool ourselves with Fuse.js so typos like "avengrs" still work.
const LISTS = [
  ["popular", 5],
  ["top_rated", 5],
  ["now_playing", 3],
  ["upcoming", 2],
];

async function buildPool() {
  const byId = new Map();
  const jobs = [];
  for (const [category, pages] of LISTS) {
    for (let page = 1; page <= pages; page++) {
      jobs.push(tmdb("/movie/" + category, { page, language: "en-US" }).then((data) => ({ category, data })));
    }
  }
  const results = await Promise.allSettled(jobs);
  let anyOk = false;
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    anyOk = true;
    for (const m of r.value.data.results || []) {
      const existing = byId.get(m.id);
      if (existing) {
        if (!existing.categories.includes(r.value.category)) existing.categories.push(r.value.category);
      } else {
        byId.set(m.id, {
          id: m.id,
          title: m.title,
          original_title: m.original_title,
          overview: m.overview,
          poster_path: m.poster_path,
          release_date: m.release_date || "",
          vote_average: m.vote_average || 0,
          popularity: m.popularity || 0,
          genre_ids: m.genre_ids || [],
          categories: [r.value.category],
        });
      }
    }
  }
  if (!anyOk) {
    const firstError = results.find((r) => r.status === "rejected");
    throw firstError ? firstError.reason : new Error("TMDB unavailable");
  }
  pool = { at: Date.now(), items: [...byId.values()] };
  await getGenres().catch(() => {});
  saveDisk();
  prefetchTrailers(pool.items).catch(() => {}); // in the background
  return pool;
}

function startBuild() {
  if (!building) {
    lastTry = Date.now();
    building = buildPool().finally(() => (building = null));
  }
  return building;
}

async function getPool() {
  if (pool.items.length) {
    // we have movies (fresh, or saved from earlier): use them right away,
    // and quietly try to refresh in the background when they are old
    if (Date.now() - pool.at > CACHE_MS && !building && Date.now() - lastTry > RETRY_MS) {
      startBuild().catch((e) => console.warn("[movies] refresh failed, using the saved copy:", e.message));
    }
    return pool;
  }
  return startBuild(); // nothing saved yet: we have to wait for TMDB
}

async function getGenres() {
  if (genreCache) return genreCache;
  genreCache = (await tmdb("/genre/movie/list", { language: "en-US" })).genres;
  saveDisk();
  return genreCache;
}

// ---------- trailers ----------
async function findTrailer(id, save = true) {
  if (trailers[id]) return trailers[id];
  const data = await tmdb(`/movie/${id}/videos`, { language: "en-US" });
  const yt = (data.results || []).filter((v) => v.site === "YouTube");
  const pick =
    yt.find((v) => v.type === "Trailer" && v.official) ||
    yt.find((v) => v.type === "Trailer") ||
    yt.find((v) => v.type === "Teaser") ||
    yt[0];
  if (!pick) return null;
  trailers[id] = { url: "https://www.youtube.com/watch?v=" + pick.key, name: pick.name };
  if (save) saveDisk();
  return trailers[id];
}

// Look up trailers for the most popular movies ahead of time, so they still work
// later when TMDB can't be reached.
async function prefetchTrailers(items) {
  const ids = new Set();
  for (const cat of ["popular", "top_rated", "now_playing"]) {
    items
      .filter((m) => m.categories.includes(cat))
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 15)
      .forEach((m) => ids.add(m.id));
  }
  const todo = [...ids].filter((id) => !trailers[id]);
  for (let i = 0; i < todo.length; i += 10) {
    await Promise.allSettled(todo.slice(i, i + 10).map((id) => findTrailer(id, false)));
  }
  saveDisk();
  console.log(`[movies] saved ${Object.keys(trailers).length} trailers to ${path.basename(CACHE_FILE)}`);
}

function sendError(res, e) {
  if (e.message === "NO_KEY") {
    return res.status(503).json({
      error: "TMDB key missing. Add TMDB_API_KEY=your_key to a .env file and restart the server.",
    });
  }
  console.error("[movies]", e.message);
  if (e.message.startsWith("NETWORK")) {
    return res.status(502).json({
      error: "Can't connect to TMDB (" + e.message.slice(8) + ") and there is no saved copy yet. Try another network or a VPN once, so it can be saved.",
    });
  }
  res.status(502).json({ error: "Could not reach TMDB (" + e.message + ")" });
}

module.exports = function registerMovieRoutes(app) {
  loadDisk();

  app.get("/api/movies/genres", async (req, res) => {
    try {
      res.json({ genres: await getGenres() });
    } catch (e) {
      sendError(res, e);
    }
  });

  app.get("/api/movies", async (req, res) => {
    try {
      const { q = "", category = "popular", genre = "", year = "", minRating = "" } = req.query;
      const limit = Math.min(parseInt(req.query.limit, 10) || 24, 60);
      let list = (await getPool()).items;

      // filters
      if (category && category !== "all") list = list.filter((m) => m.categories.includes(category));
      if (genre) list = list.filter((m) => m.genre_ids.includes(Number(genre)));
      if (/^\d{4}$/.test(year)) list = list.filter((m) => m.release_date.startsWith(year));
      if (minRating) list = list.filter((m) => m.vote_average >= Number(minRating));

      if (String(q).trim()) {
        // fuzzy search: tolerates typos and partial words
        const fuse = new Fuse(list, {
          keys: [
            { name: "title", weight: 0.7 },
            { name: "original_title", weight: 0.2 },
            { name: "overview", weight: 0.1 },
          ],
          threshold: 0.35,
          ignoreLocation: true,
        });
        list = fuse.search(String(q).trim()).map((r) => r.item);
      } else {
        // no search text: top rated list sorts by rating, everything else by popularity
        list = [...list].sort((a, b) =>
          category === "top_rated" ? b.vote_average - a.vote_average : b.popularity - a.popularity
        );
      }

      res.json({ total: list.length, movies: list.slice(0, limit) });
    } catch (e) {
      sendError(res, e);
    }
  });

  // TMDB has no playable movies, but it does know each movie's YouTube trailer.
  // That is what we add to the playlist, and the YouTube player handles it.
  app.get("/api/movies/:id/trailer", async (req, res) => {
    try {
      if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "Bad movie id" });
      const t = await findTrailer(req.params.id);
      if (!t) return res.status(404).json({ error: "No trailer found for this movie" });
      res.json(t);
    } catch (e) {
      sendError(res, e);
    }
  });
};
