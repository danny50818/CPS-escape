const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;
const rootDir = __dirname;
const localStorePath = path.join(rootDir, "leaderboard.local.json");
const hasDatabase = Boolean(process.env.DATABASE_URL);

app.use(express.json({ limit: "32kb" }));

let pool = null;

if (hasDatabase) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
  });
}

function sanitizeScore(input) {
  const name = String(input.name || "匿名社工").trim().slice(0, 16) || "匿名社工";
  const score = Number.parseInt(input.score, 10);
  if (!Number.isFinite(score) || score < 0 || score > 9999) {
    const error = new Error("Invalid score");
    error.status = 400;
    throw error;
  }

  const cleanText = (value, fallback, max = 80) => String(value || fallback).trim().slice(0, max);

  return {
    name,
    score,
    rating: cleanText(input.rating, "未評等", 40),
    ending: cleanText(input.ending, "未記錄結局", 80),
    safety: clampMetric(input.safety),
    trust: clampMetric(input.trust),
    network: clampMetric(input.network),
    action: clampMetric(input.action, 0, 20),
    procedure: clampMetric(input.procedure),
    time_used: clampMetric(input.time_used ?? input.time, 0, 999)
  };
}

function clampMetric(value, min = 0, max = 100) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, number));
}

async function initDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      score INTEGER NOT NULL,
      rating TEXT NOT NULL,
      ending TEXT NOT NULL,
      safety INTEGER NOT NULL DEFAULT 0,
      trust INTEGER NOT NULL DEFAULT 0,
      network INTEGER NOT NULL DEFAULT 0,
      action INTEGER NOT NULL DEFAULT 0,
      procedure INTEGER NOT NULL DEFAULT 0,
      time_used INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function readLocalBoard() {
  try {
    const raw = await fs.readFile(localStorePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeLocalBoard(board) {
  await fs.writeFile(localStorePath, JSON.stringify(board, null, 2), "utf8");
}

async function listScores(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  if (pool) {
    const result = await pool.query(
      `SELECT name, score, rating, ending, safety, trust, network, action, procedure, time_used, created_at
       FROM scores
       ORDER BY score DESC, created_at ASC
       LIMIT $1`,
      [safeLimit]
    );
    return result.rows;
  }

  return (await readLocalBoard())
    .sort((a, b) => b.score - a.score || new Date(a.created_at || a.at) - new Date(b.created_at || b.at))
    .slice(0, safeLimit);
}

async function addScore(score) {
  if (pool) {
    const result = await pool.query(
      `INSERT INTO scores
        (name, score, rating, ending, safety, trust, network, action, procedure, time_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING name, score, rating, ending, safety, trust, network, action, procedure, time_used, created_at`,
      [
        score.name,
        score.score,
        score.rating,
        score.ending,
        score.safety,
        score.trust,
        score.network,
        score.action,
        score.procedure,
        score.time_used
      ]
    );
    return result.rows[0];
  }

  const board = await readLocalBoard();
  const row = { ...score, created_at: new Date().toISOString() };
  board.push(row);
  board.sort((a, b) => b.score - a.score || new Date(a.created_at) - new Date(b.created_at));
  await writeLocalBoard(board.slice(0, 100));
  return row;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, storage: hasDatabase ? "postgres" : "local-file" });
});

app.get("/api/leaderboard", async (req, res, next) => {
  try {
    res.json(await listScores(req.query.limit));
  } catch (error) {
    next(error);
  }
});

app.post("/api/scores", async (req, res, next) => {
  try {
    const score = sanitizeScore(req.body || {});
    const saved = await addScore(score);
    res.status(201).json(saved);
  } catch (error) {
    next(error);
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(rootDir, "child_protection_escape_game.html"));
});

app.use(express.static(rootDir));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  console.error(error);
  res.status(status).json({ error: status === 500 ? "Server error" : error.message });
});

initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Starlight game server listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize leaderboard storage", error);
    process.exit(1);
  });
