import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config";
import type { Post } from "./reddit";

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, "feed.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,  -- fetch run (ms) that last returned this post
    rank INTEGER NOT NULL        -- position in that run's feed
  );
  CREATE TABLE IF NOT EXISTS verdicts (
    id TEXT PRIMARY KEY,
    keep INTEGER,                -- NULL until the model has answered
    category TEXT,
    reason TEXT,
    model TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    decided_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

export const getMeta = (k: string) => (db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null)?.v ?? "";

export function setMeta(k: string, v: string) {
  db.run("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v]);
}

const upsertQ = db.prepare(`
  INSERT INTO posts (id, data, first_seen, last_seen, rank) VALUES (?1, ?2, ?3, ?3, ?4)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, last_seen = excluded.last_seen, rank = excluded.rank`);

export const upsertPosts = db.transaction((posts: Post[], run: number) => {
  posts.forEach((p, i) => upsertQ.run(p.id, JSON.stringify(p), run, i));
  setMeta("lastFetchRun", String(run));
});

// The latest fetch run. Everything the UI shows is scoped to it.
const maxSeen = () => (db.query("SELECT COALESCE(MAX(last_seen), 0) AS t FROM posts").get() as { t: number }).t;
export const currentRun = () => Number(getMeta("lastFetchRun")) || maxSeen();

// Unjudged posts from the current run, feed order first. A row with keep NULL is a failed attempt.
const pendingQ = db.prepare(`
  SELECT p.data FROM posts p LEFT JOIN verdicts v ON v.id = p.id
  WHERE v.keep IS NULL AND COALESCE(v.attempts, 0) < ?1 AND p.last_seen = ?2
  ORDER BY p.rank`);

export const pending = (maxAttempts: number): Post[] =>
  pendingQ.all(maxAttempts, currentRun()).map((r: any) => JSON.parse(r.data));

const verdictQ = db.prepare(`
  INSERT INTO verdicts (id, keep, category, reason, model, attempts, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
  ON CONFLICT(id) DO UPDATE SET keep = excluded.keep, category = excluded.category, reason = excluded.reason,
    model = excluded.model, attempts = attempts + 1, decided_at = excluded.decided_at`);

export function saveVerdict(id: string, keep: boolean, category: string, reason: string, model: string) {
  verdictQ.run(id, keep ? 1 : 0, category, reason, model, Date.now());
}

const failQ = db.prepare(`INSERT INTO verdicts (id, attempts) VALUES (?1, 1) ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1`);

export function failAttempt(id: string) {
  failQ.run(id);
}

const feedQ = db.prepare(`
  SELECT p.data, v.category, v.reason FROM posts p JOIN verdicts v ON v.id = p.id
  WHERE v.keep = ?1 AND p.last_seen = ?2 ORDER BY p.rank LIMIT 500`);

export const feed = (keep: boolean) =>
  feedQ.all(keep ? 1 : 0, currentRun()).map((r: any) => ({ ...JSON.parse(r.data), category: r.category, reason: r.reason }));

const countsQ = db.prepare(`
  SELECT COUNT(*) AS total,
    COALESCE(SUM(v.keep = 1), 0) AS kept,
    COALESCE(SUM(v.keep = 0), 0) AS hidden,
    COALESCE(SUM(v.keep IS NULL AND COALESCE(v.attempts, 0) < ?1), 0) AS pending,
    COALESCE(SUM(v.keep IS NULL AND v.attempts >= ?1), 0) AS failed
  FROM posts p LEFT JOIN verdicts v ON v.id = p.id
  WHERE p.last_seen = ?2`);

export const counts = (maxAttempts: number) => countsQ.get(maxAttempts, currentRun()) as Record<string, number>;

const byCategoryQ = db.prepare(`
  SELECT v.category, COUNT(*) AS n FROM verdicts v JOIN posts p ON p.id = v.id
  WHERE v.keep = 0 AND p.last_seen = ?1 GROUP BY v.category ORDER BY n DESC`);

export const hiddenByCategory = () => byCategoryQ.all(currentRun()) as { category: string; n: number }[];

export const lastFetch = () => Number(getMeta("lastFetchRun")) || maxSeen();

export function prune(keepDays: number) {
  db.run("DELETE FROM posts WHERE last_seen < ?", [Date.now() - keepDays * 86_400_000]);
  db.run("DELETE FROM verdicts WHERE id NOT IN (SELECT id FROM posts)");
}

export function resetVerdicts() {
  db.run("DELETE FROM verdicts");
}
