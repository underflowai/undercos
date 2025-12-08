import Database from 'better-sqlite3';
import { getDbPath } from './data-dir.js';

const db = new Database(getDbPath('posts.db'));
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
