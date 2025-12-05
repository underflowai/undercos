import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

type ActionStatus = 'pending' | 'succeeded' | 'failed';

export interface LoggedAction {
  id: string;
  action_type: string;
  entity_type: string;
  entity_id: string;
  status: ActionStatus;
  error_message?: string;
  data?: unknown;
  created_at: string;
  updated_at: string;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'actions-log.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS actions_log (
    id TEXT PRIMARY KEY,
    action_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    data_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_actions_log_entity ON actions_log(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_actions_log_action ON actions_log(action_type, entity_type, entity_id);
`);

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function logAction(params: {
  actionType: string;
  entityType: string;
  entityId: string;
  status?: ActionStatus;
  data?: unknown;
  errorMessage?: string;
}): string {
  const id = generateId();
  db.prepare(
    `INSERT INTO actions_log (id, action_type, entity_type, entity_id, status, error_message, data_json)
     VALUES (@id, @action_type, @entity_type, @entity_id, @status, @error_message, @data_json)`
  ).run({
    id,
    action_type: params.actionType,
    entity_type: params.entityType,
    entity_id: params.entityId,
    status: params.status || 'pending',
    error_message: params.errorMessage,
    data_json: params.data ? JSON.stringify(params.data) : null,
  });
  return id;
}

export function updateActionStatus(id: string, status: ActionStatus, opts?: { errorMessage?: string; data?: unknown }): void {
  db.prepare(
    `UPDATE actions_log
       SET status = @status,
           error_message = @error_message,
           data_json = @data_json,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = @id`
  ).run({
    id,
    status,
    error_message: opts?.errorMessage,
    data_json: opts?.data ? JSON.stringify(opts.data) : null,
  });
}

export function getLatestAction(actionType: string, entityType: string, entityId: string): LoggedAction | null {
  const row = db.prepare(
    `SELECT * FROM actions_log
       WHERE action_type = @action_type AND entity_type = @entity_type AND entity_id = @entity_id
       ORDER BY created_at DESC
       LIMIT 1`
  ).get({
    action_type: actionType,
    entity_type: entityType,
    entity_id: entityId,
  });

  if (!row) return null;
  const parsed = row as Record<string, unknown>;
  return {
    ...(parsed as any),
    data: parsed.data_json ? JSON.parse(parsed.data_json as string) : undefined,
  } as LoggedAction;
}
