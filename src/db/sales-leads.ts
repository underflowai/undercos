import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database setup
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'sales-leads.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initializeSchema(db);
  }
  return db;
}

function initializeSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sales_leads (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      company TEXT,
      linkedin_id TEXT,
      linkedin_connected INTEGER DEFAULT 0,
      meeting_id TEXT,
      meeting_date TEXT,
      meeting_title TEXT,
      meeting_notes_id TEXT,
      meeting_notes_summary TEXT,
      email_thread_id TEXT,
      last_email_date TEXT,
      email_followup_count INTEGER DEFAULT 0,
      first_opened_at TEXT,
      last_opened_at TEXT,
      open_count INTEGER DEFAULT 0,
      linkedin_request_sent INTEGER DEFAULT 0,
      linkedin_message_count INTEGER DEFAULT 0,
      last_linkedin_date TEXT,
      status TEXT DEFAULT 'active',
      responded_via TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );
    
    CREATE INDEX IF NOT EXISTS idx_sales_leads_email ON sales_leads(email);
    CREATE INDEX IF NOT EXISTS idx_sales_leads_status ON sales_leads(status);
    CREATE INDEX IF NOT EXISTS idx_sales_leads_last_email ON sales_leads(last_email_date);
    CREATE INDEX IF NOT EXISTS idx_sales_leads_meeting ON sales_leads(meeting_id);
    
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

export type LeadStatus = 'active' | 'responded' | 'cold';

export interface SalesLead {
  id: string;
  email: string;
  name?: string;
  company?: string;
  linkedin_id?: string;
  linkedin_connected: boolean;
  
  // Meeting context
  meeting_id?: string;
  meeting_date?: string;
  meeting_title?: string;
  meeting_notes_id?: string;
  meeting_notes_summary?: string;
  
  // Email tracking
  email_thread_id?: string;
  last_email_date?: string;
  email_followup_count: number;
  
  // Open tracking
  first_opened_at?: string;
  last_opened_at?: string;
  open_count: number;
  
  // LinkedIn tracking
  linkedin_request_sent: boolean;
  linkedin_message_count: number;
  last_linkedin_date?: string;
  
  // Status
  status: LeadStatus;
  responded_via?: 'email' | 'linkedin';
  created_at?: string;
  updated_at?: string;
}

export interface CreateLeadParams {
  email: string;
  name?: string;
  company?: string;
  linkedin_id?: string;
  linkedin_connected?: boolean;
  meeting_id?: string;
  meeting_date?: string;
  meeting_title?: string;
  meeting_notes_id?: string;
  meeting_notes_summary?: string;
}

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

export class SalesLeadRepository {
  private db: Database.Database;

  constructor() {
    this.db = getDb();
  }

  /**
   * Generate a unique ID for a lead (based on email + meeting)
   */
  private generateLeadId(email: string, meetingId?: string): string {
    const base = meetingId ? `${email}-${meetingId}` : email;
    return base.toLowerCase().replace(/[^a-z0-9]/g, '-');
  }

  createLead(params: CreateLeadParams): SalesLead {
    const id = this.generateLeadId(params.email, params.meeting_id);
    
    // Check if lead already exists
    const existing = this.getLeadById(id);
    if (existing) {
      console.log(`[SalesLeads] Lead already exists: ${params.email}`);
      return existing;
    }
    
    this.db.prepare(`
      INSERT INTO sales_leads (
        id, email, name, company, linkedin_id, linkedin_connected,
        meeting_id, meeting_date, meeting_title, meeting_notes_id, meeting_notes_summary,
        status, created_at, updated_at
      ) VALUES (
        @id, @email, @name, @company, @linkedin_id, @linkedin_connected,
        @meeting_id, @meeting_date, @meeting_title, @meeting_notes_id, @meeting_notes_summary,
        'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run({
      id,
      email: params.email,
      name: params.name || null,
      company: params.company || null,
      linkedin_id: params.linkedin_id || null,
      linkedin_connected: params.linkedin_connected ? 1 : 0,
      meeting_id: params.meeting_id || null,
      meeting_date: params.meeting_date || null,
      meeting_title: params.meeting_title || null,
      meeting_notes_id: params.meeting_notes_id || null,
      meeting_notes_summary: params.meeting_notes_summary || null,
    });
    
    console.log(`[SalesLeads] Created lead: ${params.name || params.email} (${id})`);
    
    return this.getLeadById(id) as SalesLead;
  }

  getLeadById(id: string): SalesLead | undefined {
    const row = this.db.prepare(`SELECT * FROM sales_leads WHERE id = ?`).get(id);
    return row ? this.mapDbRowToLead(row) : undefined;
  }

  getLeadByEmail(email: string): SalesLead | undefined {
    const row = this.db.prepare(`SELECT * FROM sales_leads WHERE email = ?`).get(email);
    return row ? this.mapDbRowToLead(row) : undefined;
  }

  getLeadByMeetingId(meetingId: string): SalesLead | undefined {
    const row = this.db.prepare(`SELECT * FROM sales_leads WHERE meeting_id = ?`).get(meetingId);
    return row ? this.mapDbRowToLead(row) : undefined;
  }

  getLeadByThreadId(threadId: string): SalesLead | undefined {
    const row = this.db.prepare(`SELECT * FROM sales_leads WHERE email_thread_id = ?`).get(threadId);
    return row ? this.mapDbRowToLead(row) : undefined;
  }

  getActiveLeads(): SalesLead[] {
    const rows = this.db.prepare(`
      SELECT * FROM sales_leads WHERE status = 'active' ORDER BY last_email_date ASC
    `).all() as Record<string, unknown>[];
    return rows.map(row => this.mapDbRowToLead(row));
  }

  getLeadsDueForFollowup(daysSinceLastEmail: number): SalesLead[] {
    const rows = this.db.prepare(`
      SELECT * FROM sales_leads 
      WHERE status = 'active' 
        AND last_email_date IS NOT NULL
        AND julianday('now') - julianday(last_email_date) >= ?
      ORDER BY last_email_date ASC
    `).all(daysSinceLastEmail) as Record<string, unknown>[];
    return rows.map(row => this.mapDbRowToLead(row));
  }

  updateLeadEmail(id: string, threadId: string, date: Date): void {
    this.db.prepare(`
      UPDATE sales_leads 
      SET email_thread_id = @thread_id,
          last_email_date = @last_email_date,
          email_followup_count = email_followup_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id,
      thread_id: threadId,
      last_email_date: date.toISOString(),
    });
  }

  updateLeadLinkedIn(id: string, requestSent: boolean, messageIncrement: number, date: Date): void {
    this.db.prepare(`
      UPDATE sales_leads 
      SET linkedin_request_sent = @request_sent,
          linkedin_message_count = linkedin_message_count + @message_increment,
          last_linkedin_date = @last_linkedin_date,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id,
      request_sent: requestSent ? 1 : 0,
      message_increment: messageIncrement,
      last_linkedin_date: date.toISOString(),
    });
  }

  updateLeadLinkedInConnected(id: string, linkedinId: string): void {
    this.db.prepare(`
      UPDATE sales_leads 
      SET linkedin_connected = 1,
          linkedin_id = @linkedin_id,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id,
      linkedin_id: linkedinId,
    });
  }

  updateLeadStatus(id: string, status: LeadStatus, respondedVia?: 'email' | 'linkedin'): void {
    this.db.prepare(`
      UPDATE sales_leads 
      SET status = @status,
          responded_via = @responded_via,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id,
      status,
      responded_via: respondedVia || null,
    });
  }

  recordEmailOpen(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE sales_leads 
      SET last_opened_at = @last_opened_at,
          first_opened_at = COALESCE(first_opened_at, @last_opened_at),
          open_count = open_count + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id,
      last_opened_at: now,
    });
  }

  getWarmLeads(): SalesLead[] {
    const rows = this.db.prepare(`
      SELECT * FROM sales_leads 
      WHERE status = 'active' 
        AND open_count > 0
        AND responded_via IS NULL
      ORDER BY last_opened_at DESC
    `).all() as Record<string, unknown>[];
    return rows.map(row => this.mapDbRowToLead(row));
  }

  getLeadsByThreadIds(threadIds: string[]): SalesLead[] {
    if (threadIds.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM sales_leads WHERE email_thread_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify(threadIds)) as Record<string, unknown>[];
    return rows.map(row => this.mapDbRowToLead(row));
  }

  getStatistics() {
    return this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) as responded,
        SUM(CASE WHEN status = 'cold' THEN 1 ELSE 0 END) as cold
      FROM sales_leads
    `).get() as { total: number; active: number; responded: number; cold: number };
  }

  // Surfaced Meetings Logic

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

  private mapDbRowToLead(row: any): SalesLead {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      company: row.company,
      linkedin_id: row.linkedin_id,
      linkedin_connected: Boolean(row.linkedin_connected),
      meeting_id: row.meeting_id,
      meeting_date: row.meeting_date,
      meeting_title: row.meeting_title,
      meeting_notes_id: row.meeting_notes_id,
      meeting_notes_summary: row.meeting_notes_summary,
      email_thread_id: row.email_thread_id,
      last_email_date: row.last_email_date,
      email_followup_count: row.email_followup_count || 0,
      first_opened_at: row.first_opened_at,
      last_opened_at: row.last_opened_at,
      open_count: row.open_count || 0,
      linkedin_request_sent: Boolean(row.linkedin_request_sent),
      linkedin_message_count: row.linkedin_message_count || 0,
      last_linkedin_date: row.last_linkedin_date,
      status: row.status as LeadStatus,
      responded_via: row.responded_via as 'email' | 'linkedin' | undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

// =============================================================================
// EXPORTS (Singleton Adapter)
// =============================================================================

const repo = new SalesLeadRepository();

// Lead Management
export const createLead = (params: CreateLeadParams) => repo.createLead(params);
export const getLead = (id: string) => repo.getLeadById(id);
export const getLeadByEmailAddress = (email: string) => repo.getLeadByEmail(email);
export const getLeadByMeeting = (meetingId: string) => repo.getLeadByMeetingId(meetingId);
export const getLeadByThread = (threadId: string) => repo.getLeadByThreadId(threadId);
export const getAllActiveLeads = () => repo.getActiveLeads();
export const getLeadsDueForFollowUp = (days: number) => repo.getLeadsDueForFollowup(days);
export const getLeadsByThreads = (threadIds: string[]) => repo.getLeadsByThreadIds(threadIds);
export const getWarmLeadsForFollowUp = () => repo.getWarmLeads();
export const getLeadStatistics = () => repo.getStatistics();

// Actions
export const recordEmailSent = (id: string, threadId: string) => repo.updateLeadEmail(id, threadId, new Date());
export const recordEmailOpen = (id: string) => repo.recordEmailOpen(id);
export const recordLinkedInActivity = (id: string, type: 'request' | 'message') => {
  if (type === 'request') {
    repo.updateLeadLinkedIn(id, true, 0, new Date());
  } else {
    repo.updateLeadLinkedIn(id, false, 1, new Date()); // Increments message count
  }
};
export const markLeadLinkedInConnected = (id: string, linkedinId: string) => repo.updateLeadLinkedInConnected(id, linkedinId);
export const markLeadResponded = (id: string, via: 'email' | 'linkedin') => repo.updateLeadStatus(id, 'responded', via);
export const markLeadCold = (id: string) => repo.updateLeadStatus(id, 'cold');

// Meeting Surfacing
export const isMeetingSurfaced = (meetingId: string) => repo.isMeetingSurfaced(meetingId);
export const markMeetingSurfaced = (params: { meetingId: string; recipientEmail: string; recipientName?: string; meetingTitle?: string; draftSubject?: string; draftBody?: string }) => repo.markMeetingSurfaced(params);
export const markMeetingSkipped = (meetingId: string) => repo.updateMeetingStatus(meetingId, 'skipped');
export const markMeetingSent = (meetingId: string) => repo.updateMeetingStatus(meetingId, 'sent');
export const getSurfacedMeeting = (meetingId: string) => repo.getSurfacedMeeting(meetingId);
export const getSurfacedMeetingStats = () => repo.getSurfacedMeetingStats();
export const getPendingSurfacedMeetings = () => repo.getPendingSurfacedMeetings();

// Helpers for complex queries
export const hasMeetingBeenProcessed = (meetingId: string): boolean => {
  // Check both leads and surfaced meetings
  return !!(repo.getLeadByMeetingId(meetingId) || repo.isMeetingSurfaced(meetingId));
};

export const getLeadsByFollowUpStage = () => {
  const allActive = repo.getActiveLeads();
  
  return {
    firstFollowup: allActive.filter(l => l.email_followup_count === 0),
    secondFollowup: allActive.filter(l => l.email_followup_count === 1),
    thirdFollowup: allActive.filter(l => l.email_followup_count === 2),
    finalFollowup: allActive.filter(l => l.email_followup_count === 3),
  };
};
