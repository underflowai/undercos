import Database from 'better-sqlite3';
import { getDbPath } from './data-dir.js';

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath('sales-leads.db'));
    db.pragma('journal_mode = WAL');
    initializeSchema(db);
  }
  return db;
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS surfaced_meetings (
      meeting_id TEXT PRIMARY KEY,
      recipient_email TEXT NOT NULL,
      recipient_name TEXT,
      meeting_title TEXT,
      surfaced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'surfaced',
      draft_subject TEXT,
      draft_body TEXT,
      updated_at TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_surfaced_meetings_status ON surfaced_meetings(status);
  `);
}

// =============================================================================
// TYPES
// =============================================================================

export type SurfacedMeetingStatus = 'surfaced' | 'skipped' | 'sent';

export interface SurfacedMeeting {
  meeting_id: string;
  recipient_email: string;
  recipient_name?: string;
  meeting_title?: string;
  surfaced_at: string;
  status: SurfacedMeetingStatus;
  draft_subject?: string;
  draft_body?: string;
  updated_at?: string;
}

// =============================================================================
// REPOSITORY
// =============================================================================

class SurfacedMeetingRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDb();
  }

  isMeetingSurfaced(meetingId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM surfaced_meetings WHERE meeting_id = ?').get(meetingId);
    return !!row;
  }

  markMeetingSurfaced(params: {
    meetingId: string;
    recipientEmail: string;
    recipientName?: string;
    meetingTitle?: string;
    draftSubject?: string;
    draftBody?: string;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO surfaced_meetings (
        meeting_id, recipient_email, recipient_name, meeting_title,
        status, draft_subject, draft_body, updated_at
      ) VALUES (
        @meetingId, @recipientEmail, @recipientName, @meetingTitle,
        'surfaced', @draftSubject, @draftBody, CURRENT_TIMESTAMP
      )
    `).run({
      meetingId: params.meetingId,
      recipientEmail: params.recipientEmail,
      recipientName: params.recipientName || null,
      meetingTitle: params.meetingTitle || null,
      draftSubject: params.draftSubject || null,
      draftBody: params.draftBody || null,
    });
  }

  updateMeetingStatus(meetingId: string, status: SurfacedMeetingStatus): void {
    this.db.prepare(`
      UPDATE surfaced_meetings
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE meeting_id = ?
    `).run(status, meetingId);
  }

  getSurfacedMeeting(meetingId: string): SurfacedMeeting | undefined {
    const row = this.db.prepare('SELECT * FROM surfaced_meetings WHERE meeting_id = ?').get(meetingId);
    return row as SurfacedMeeting | undefined;
  }

  getPendingSurfacedMeetings(): SurfacedMeeting[] {
    return this.db.prepare(
      `SELECT * FROM surfaced_meetings 
        WHERE status = 'surfaced'
        ORDER BY surfaced_at DESC
        LIMIT 50`
    ).all() as SurfacedMeeting[];
  }

  getSurfacedMeetingStats() {
    return this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'surfaced' THEN 1 ELSE 0 END) as surfaced,
        SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent
      FROM surfaced_meetings
    `).get() as { total: number; surfaced: number; skipped: number; sent: number };
  }
}

// =============================================================================
// EXPORTS (Singleton Adapter)
// =============================================================================

const repo = new SurfacedMeetingRepository();

export const isMeetingSurfaced = (meetingId: string) => repo.isMeetingSurfaced(meetingId);
export const markMeetingSurfaced = (params: { meetingId: string; recipientEmail: string; recipientName?: string; meetingTitle?: string; draftSubject?: string; draftBody?: string }) => repo.markMeetingSurfaced(params);
export const markMeetingSkipped = (meetingId: string) => repo.updateMeetingStatus(meetingId, 'skipped');
export const markMeetingSent = (meetingId: string) => repo.updateMeetingStatus(meetingId, 'sent');
export const getSurfacedMeeting = (meetingId: string) => repo.getSurfacedMeeting(meetingId);
export const getSurfacedMeetingStats = () => repo.getSurfacedMeetingStats();
export const getPendingSurfacedMeetings = () => repo.getPendingSurfacedMeetings();

export const hasMeetingBeenProcessed = (meetingId: string): boolean => {
  return repo.isMeetingSurfaced(meetingId);
};

