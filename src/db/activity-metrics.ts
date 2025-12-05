import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'activity-metrics.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS activity_counts (
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (date, type)
  );
`);

function dateKey(date: Date = new Date()): string {
  return date.toISOString().split('T')[0];
}

export function incrementActivityCount(type: string, date: Date = new Date()): void {
  const key = dateKey(date);
  db.prepare(
    `INSERT INTO activity_counts (date, type, count)
     VALUES (@date, @type, 1)
     ON CONFLICT(date, type) DO UPDATE SET count = count + 1`
  ).run({ date: key, type });
}

export function getDailyCount(type: string, date: Date = new Date()): number {
  const key = dateKey(date);
  const row = db.prepare(
    `SELECT count FROM activity_counts WHERE date = @date AND type = @type`
  ).get({ date: key, type }) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getWeeklyCount(type: string, today: Date = new Date()): number {
  const start = new Date(today);
  start.setDate(start.getDate() - 6);
  const startKey = dateKey(start);
  const todayKey = dateKey(today);

  const row = db.prepare(
    `SELECT SUM(count) as total
     FROM activity_counts
     WHERE type = @type AND date BETWEEN @start AND @end`
  ).get({ type, start: startKey, end: todayKey }) as { total: number | null } | undefined;

  return row?.total ?? 0;
}

export function pruneOldActivity(days: number = 14): void {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = dateKey(cutoff);
  db.prepare(`DELETE FROM activity_counts WHERE date < @cutoff`).run({ cutoff: cutoffKey });
}
