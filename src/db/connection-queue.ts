import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'connection-queue.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS connection_surface_counts (
    date TEXT NOT NULL,
    source TEXT NOT NULL, -- 'meeting' | 'ad_hoc'
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(date, source)
  );

  CREATE TABLE IF NOT EXISTS connection_threads (
    date TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS connection_suggestions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    priority INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_suggestions_schedule ON connection_suggestions(scheduled_for, priority);
`);

type SourceType = 'meeting' | 'ad_hoc';

function dateKey(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function incrementSurfaceCount(source: SourceType, date: Date = new Date()): number {
  const key = dateKey(date);
  db.prepare(
    `INSERT INTO connection_surface_counts (date, source, count)
     VALUES (@date, @source, 1)
     ON CONFLICT(date, source) DO UPDATE SET count = count + 1`
  ).run({ date: key, source });

  const row = db.prepare(
    `SELECT count FROM connection_surface_counts WHERE date = @date AND source = @source`
  ).get({ date: key, source }) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getSurfaceCount(source: SourceType, date: Date = new Date()): number {
  const key = dateKey(date);
  const row = db.prepare(
    `SELECT count FROM connection_surface_counts WHERE date = @date AND source = @source`
  ).get({ date: key, source }) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function saveConnectionThread(date: string, channelId: string, threadTs: string): void {
  db.prepare(
    `INSERT INTO connection_threads (date, channel_id, thread_ts)
     VALUES (@date, @channel_id, @thread_ts)
     ON CONFLICT(date) DO UPDATE SET channel_id = excluded.channel_id, thread_ts = excluded.thread_ts`
  ).run({ date, channel_id: channelId, thread_ts: threadTs });
}

export function getConnectionThread(date: string): { channel_id: string; thread_ts: string } | null {
  const row = db.prepare(
    `SELECT channel_id, thread_ts FROM connection_threads WHERE date = @date`
  ).get({ date }) as { channel_id: string; thread_ts: string } | undefined;
  return row || null;
}

export interface QueuedSuggestionPayload {
  profileName: string;
  profileUrl?: string;
  providerId?: string;
  draftNote?: string;
  brief?: string;
  researchSummary?: string;
  blocks?: unknown;
  text?: string;
}

export interface QueuedSuggestion extends QueuedSuggestionPayload {
  id: string;
  source: SourceType;
  scheduledFor: string;
  priority: number;
}

export function enqueueSuggestion(input: {
  source: SourceType;
  scheduledFor: string;
  payload: QueuedSuggestionPayload;
  priority?: number;
}): string {
  const id = generateId();
  db.prepare(
    `INSERT INTO connection_suggestions (id, source, scheduled_for, payload_json, priority)
     VALUES (@id, @source, @scheduled_for, @payload_json, @priority)`
  ).run({
    id,
    source: input.source,
    scheduled_for: input.scheduledFor,
    payload_json: JSON.stringify(input.payload),
    priority: input.priority ?? 0,
  });
  return id;
}

export function dequeueSuggestionsForDate(date: string, limit: number): QueuedSuggestion[] {
  const rows = db.prepare(
    `SELECT id, source, scheduled_for, payload_json, priority
     FROM connection_suggestions
     WHERE scheduled_for <= @date
     ORDER BY priority DESC, created_at ASC
     LIMIT @limit`
  ).all({ date, limit }) as Array<{ id: string; source: SourceType; scheduled_for: string; payload_json: string; priority: number }>;

  const ids = rows.map(r => r.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM connection_suggestions WHERE id IN (${placeholders})`).run(ids);
  }

  return rows.map(r => ({
    id: r.id,
    source: r.source,
    scheduledFor: r.scheduled_for,
    priority: r.priority,
    ...(JSON.parse(r.payload_json) as QueuedSuggestionPayload),
  }));
}
