// Movie discovery for Watch Party (TMDB + fuzzy search)
// Needs a free TMDB key in a .env file:  TMDB_API_KEY=your_key_here
//
// Routes:
//   GET /api/movies/genres
//   GET /api/movies?q=&category=&genre=&year=&minRating=&limit=
//   GET /api/movies/:id/trailer   -> YouTube trailer link for a movie

const Fuse = require("fuse.js");

const TMDB = "https://api.themoviedb.org/3";
const CACHE_MS = 60 * 60 * 1000; // refresh the movie pool every hour

// one call to TMDB (works with both the v3 "API Key" and the long "Read Access Token")
async function tmdb(path, params = {}) {
  const key = (process.env.TMDB_API_KEY || "").trim();
  if (!key) throw new Error("NO_KEY");
  const url = new URL(TMDB + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = { accept: "application/json" };
  if (key.length > 40) headers.Authorization = "Bearer " + key;
  else url.searchParams.set("api_key", key);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("TMDB error " + res.status);
  return res.json();
}

// ---------- the pool: ~300 movies from several TMDB lists, kept in memory ----------
// We search this pool ourselves with Fuse.js so typos like "avengrs" still work.
const LISTS = [
  ["popular", 5],
  ["top_rated", 5],
  ["now_playing", 3],
  ["upcoming", 2],
];

let pool = { at: 0, items: [] };
let building = null;

async function buildPool() {
  const byId = new Map();
  const jobs = [];
  for (const [category, pages] of LISTS) {
    for (let page = 1; page <= pages; page++) {
      jobs.push(
        tmdb("/movie/" + category, { page, language: "en-US" }).then((data) => ({ category, data }))
      );
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
    // surface the real reason (for example a wrong key)
    const firstError = results.find((r) => r.status === "rejected");
    throw firstError ? firstError.reason : new Error("TMDB unavailable");
  }
  pool = { at: Date.now(), items: [...byId.values()] };
  return pool;
}

async function getPool() {
  if (pool.items.length && Date.now() - pool.at < CACHE_MS) return pool;
  if (!building) building = buildPool().finally(() => (building = null));
  return building;
}

let genreCache = null;
async function getGenres() {
  if (!genreCache) genreCache = (await tmdb("/genre/movie/list", { language: "en-US" })).genres;
  return genreCache;
}

function sendError(res, e) {
  if (e.message === "NO_KEY") {
    return res.status(503).json({
      error: "TMDB key missing. Add TMDB_API_KEY=your_key to a .env file and restart the server.",
    });
  }
  console.error("[movies]", e.message);
  res.status(502).json({ error: "Could not reach TMDB (" + e.message + ")" });
}

module.exports = function registerMovieRoutes(app) {
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
      const data = await tmdb(`/movie/${req.params.id}/videos`, { language: "en-US" });
      const yt = (data.results || []).filter((v) => v.site === "YouTube");
      const pick =
        yt.find((v) => v.type === "Trailer" && v.official) ||
        yt.find((v) => v.type === "Trailer") ||
        yt.find((v) => v.type === "Teaser") ||
        yt[0];
      if (!pick) return res.status(404).json({ error: "No trailer found for this movie" });
      res.json({ url: "https://www.youtube.com/watch?v=" + pick.key, name: pick.name });
    } catch (e) {
      sendError(res, e);
    }
  });
};
