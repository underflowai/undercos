import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'posts.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_posts (
    id TEXT PRIMARY KEY,
    provider_id TEXT,
    seen_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

export function isPostSeen(id: string): boolean {
  const row = db.prepare('SELECT 1 FROM seen_posts WHERE id = ?').get(id);
  return !!row;
}

export function addSeenPost(id: string, providerId?: string): void {
  if (!id) return;
  db.prepare(
    `INSERT OR IGNORE INTO seen_posts (id, provider_id) VALUES (@id, @provider_id)`
  ).run({ id, provider_id: providerId || null });
}

export function getSeenPostsCount(): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM seen_posts').get() as { count: number } | undefined;
  return row?.count ?? 0;
}
