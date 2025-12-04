/**
 * Sales Leads Database
 * 
 * Tracks leads from meetings through the follow-up cadence:
 * - Meeting context (title, notes, attendees)
 * - Email tracking (thread ID, follow-up count, last contact)
 * - LinkedIn tracking (connection status, message count)
 * - Status (active, responded, cold)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database file location
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'sales-leads.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_leads (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    company TEXT,
    linkedin_id TEXT,
    linkedin_connected INTEGER DEFAULT 0,
    
    -- Meeting context
    meeting_id TEXT,
    meeting_date TEXT,
    meeting_title TEXT,
    meeting_notes_id TEXT,
    meeting_notes_summary TEXT,
    
    -- Email tracking
    email_thread_id TEXT,
    last_email_date TEXT,
    email_followup_count INTEGER DEFAULT 0,
    
    -- Open tracking
    first_opened_at TEXT,
    last_opened_at TEXT,
    open_count INTEGER DEFAULT 0,
    
    -- LinkedIn tracking
    linkedin_request_sent INTEGER DEFAULT 0,
    linkedin_message_count INTEGER DEFAULT 0,
    last_linkedin_date TEXT,
    
    -- Status
    status TEXT DEFAULT 'active',
    responded_via TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );
  
  CREATE INDEX IF NOT EXISTS idx_sales_leads_email ON sales_leads(email);
  CREATE INDEX IF NOT EXISTS idx_sales_leads_status ON sales_leads(status);
  CREATE INDEX IF NOT EXISTS idx_sales_leads_last_email ON sales_leads(last_email_date);
  CREATE INDEX IF NOT EXISTS idx_sales_leads_meeting ON sales_leads(meeting_id);
  
  -- Track surfaced meeting follow-ups (persists across restarts)
  CREATE TABLE IF NOT EXISTS surfaced_meetings (
    meeting_id TEXT PRIMARY KEY,
    recipient_email TEXT NOT NULL,
    recipient_name TEXT,
    meeting_title TEXT,
    surfaced_at TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'surfaced',  -- surfaced, skipped, sent
    draft_subject TEXT,
    draft_body TEXT,
    updated_at TEXT
  );
  
  CREATE INDEX IF NOT EXISTS idx_surfaced_meetings_status ON surfaced_meetings(status);
`);

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

// =============================================================================
// PREPARED STATEMENTS
// =============================================================================

const insertLead = db.prepare(`
  INSERT INTO sales_leads (
    id, email, name, company, linkedin_id, linkedin_connected,
    meeting_id, meeting_date, meeting_title, meeting_notes_id, meeting_notes_summary,
    status, created_at, updated_at
  ) VALUES (
    @id, @email, @name, @company, @linkedin_id, @linkedin_connected,
    @meeting_id, @meeting_date, @meeting_title, @meeting_notes_id, @meeting_notes_summary,
    'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )
`);

const getLeadByEmail = db.prepare(`
  SELECT * FROM sales_leads WHERE email = ?
`);

const getLeadById = db.prepare(`
  SELECT * FROM sales_leads WHERE id = ?
`);

const getLeadByMeetingId = db.prepare(`
  SELECT * FROM sales_leads WHERE meeting_id = ?
`);

const getActiveLeads = db.prepare(`
  SELECT * FROM sales_leads WHERE status = 'active' ORDER BY last_email_date ASC
`);

const getLeadsDueForFollowup = db.prepare(`
  SELECT * FROM sales_leads 
  WHERE status = 'active' 
    AND last_email_date IS NOT NULL
    AND julianday('now') - julianday(last_email_date) >= ?
  ORDER BY last_email_date ASC
`);

const updateLeadEmail = db.prepare(`
  UPDATE sales_leads 
  SET email_thread_id = @thread_id,
      last_email_date = @last_email_date,
      email_followup_count = email_followup_count + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const updateLeadLinkedIn = db.prepare(`
  UPDATE sales_leads 
  SET linkedin_request_sent = @request_sent,
      linkedin_message_count = linkedin_message_count + @message_increment,
      last_linkedin_date = @last_linkedin_date,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const updateLeadLinkedInConnected = db.prepare(`
  UPDATE sales_leads 
  SET linkedin_connected = 1,
      linkedin_id = @linkedin_id,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const updateLeadStatus = db.prepare(`
  UPDATE sales_leads 
  SET status = @status,
      responded_via = @responded_via,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const getLeadStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
    SUM(CASE WHEN status = 'responded' THEN 1 ELSE 0 END) as responded,
    SUM(CASE WHEN status = 'cold' THEN 1 ELSE 0 END) as cold
  FROM sales_leads
`);

const getLeadsByThreadIds = db.prepare(`
  SELECT * FROM sales_leads WHERE email_thread_id IN (SELECT value FROM json_each(?))
`);

const getLeadByThreadId = db.prepare(`
  SELECT * FROM sales_leads WHERE email_thread_id = ?
`);

const updateLeadOpen = db.prepare(`
  UPDATE sales_leads 
  SET last_opened_at = @last_opened_at,
      first_opened_at = COALESCE(first_opened_at, @last_opened_at),
      open_count = open_count + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const getWarmLeads = db.prepare(`
  SELECT * FROM sales_leads 
  WHERE status = 'active' 
    AND open_count > 0
    AND responded_via IS NULL
  ORDER BY last_opened_at DESC
`);

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Generate a unique ID for a lead (based on email + meeting)
 */
function generateLeadId(email: string, meetingId?: string): string {
  const base = meetingId ? `${email}-${meetingId}` : email;
  return base.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

/**
 * Create a new sales lead
 */
export function createLead(params: CreateLeadParams): SalesLead {
  const id = generateLeadId(params.email, params.meeting_id);
  
  // Check if lead already exists
  const existing = getLeadById.get(id) as SalesLead | undefined;
  if (existing) {
    console.log(`[SalesLeads] Lead already exists: ${params.email}`);
    return mapDbRowToLead(existing);
  }
  
  insertLead.run({
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
  
  return mapDbRowToLead(getLeadById.get(id) as SalesLead);
}

/**
 * Get a lead by email
 */
export function getLeadByEmailAddress(email: string): SalesLead | undefined {
  const row = getLeadByEmail.get(email);
  return row ? mapDbRowToLead(row as SalesLead) : undefined;
}

/**
 * Get a lead by ID
 */
export function getLead(id: string): SalesLead | undefined {
  const row = getLeadById.get(id);
  return row ? mapDbRowToLead(row as SalesLead) : undefined;
}

/**
 * Get a lead by meeting ID
 */
export function getLeadByMeeting(meetingId: string): SalesLead | undefined {
  const row = getLeadByMeetingId.get(meetingId);
  return row ? mapDbRowToLead(row as SalesLead) : undefined;
}

/**
 * Get all active leads
 */
export function getAllActiveLeads(): SalesLead[] {
  const rows = getActiveLeads.all();
  return rows.map(row => mapDbRowToLead(row as SalesLead));
}

/**
 * Get leads that are due for a follow-up
 * @param daysSinceLastEmail - Minimum days since last email
 */
export function getLeadsDueForFollowUp(daysSinceLastEmail: number): SalesLead[] {
  const rows = getLeadsDueForFollowup.all(daysSinceLastEmail);
  return rows.map(row => mapDbRowToLead(row as SalesLead));
}

/**
 * Get leads due based on the cadence
 * Returns leads grouped by which follow-up they're due for
 */
export function getLeadsByFollowUpStage(): {
  firstFollowup: SalesLead[];   // Day 2-3
  secondFollowup: SalesLead[];  // Day 7
  thirdFollowup: SalesLead[];   // Day 14
  finalFollowup: SalesLead[];   // Day 21
} {
  const allActive = getAllActiveLeads();
  const now = new Date();
  
  const result = {
    firstFollowup: [] as SalesLead[],
    secondFollowup: [] as SalesLead[],
    thirdFollowup: [] as SalesLead[],
    finalFollowup: [] as SalesLead[],
  };
  
  for (const lead of allActive) {
    if (!lead.last_email_date) continue;
    
    const lastEmail = new Date(lead.last_email_date);
    const daysSince = Math.floor((now.getTime() - lastEmail.getTime()) / (1000 * 60 * 60 * 24));
    
    // Determine which follow-up stage based on count and days
    if (lead.email_followup_count === 0 && daysSince >= 2) {
      result.firstFollowup.push(lead);
    } else if (lead.email_followup_count === 1 && daysSince >= 4) {
      // Day 7 total = 3 after initial + 4 after first followup
      result.secondFollowup.push(lead);
    } else if (lead.email_followup_count === 2 && daysSince >= 7) {
      // Day 14 total
      result.thirdFollowup.push(lead);
    } else if (lead.email_followup_count === 3 && daysSince >= 7) {
      // Day 21 total
      result.finalFollowup.push(lead);
    }
  }
  
  return result;
}

/**
 * Record that an email was sent to a lead
 */
export function recordEmailSent(
  leadId: string,
  threadId: string,
  isInitial: boolean = false
): void {
  const now = new Date().toISOString();
  
  if (isInitial) {
    // For initial email, set thread_id and reset count
    db.prepare(`
      UPDATE sales_leads 
      SET email_thread_id = ?,
          last_email_date = ?,
          email_followup_count = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(threadId, now, leadId);
  } else {
    updateLeadEmail.run({
      id: leadId,
      thread_id: threadId,
      last_email_date: now,
    });
  }
  
  console.log(`[SalesLeads] Recorded email sent for ${leadId}`);
}

/**
 * Record LinkedIn activity for a lead
 */
export function recordLinkedInActivity(
  leadId: string,
  type: 'request' | 'message'
): void {
  const now = new Date().toISOString();
  
  updateLeadLinkedIn.run({
    id: leadId,
    request_sent: type === 'request' ? 1 : 0,
    message_increment: type === 'message' ? 1 : 0,
    last_linkedin_date: now,
  });
  
  console.log(`[SalesLeads] Recorded LinkedIn ${type} for ${leadId}`);
}

/**
 * Mark a lead as LinkedIn connected
 */
export function markLeadLinkedInConnected(leadId: string, linkedinId?: string): void {
  updateLeadLinkedInConnected.run({
    id: leadId,
    linkedin_id: linkedinId || null,
  });
  
  console.log(`[SalesLeads] Marked ${leadId} as LinkedIn connected`);
}

/**
 * Mark a lead as responded
 */
export function markLeadResponded(leadId: string, via: 'email' | 'linkedin'): void {
  updateLeadStatus.run({
    id: leadId,
    status: 'responded',
    responded_via: via,
  });
  
  console.log(`[SalesLeads] Lead ${leadId} responded via ${via}`);
}

/**
 * Mark a lead as cold (stop following up)
 */
export function markLeadCold(leadId: string): void {
  updateLeadStatus.run({
    id: leadId,
    status: 'cold',
    responded_via: null,
  });
  
  console.log(`[SalesLeads] Marked ${leadId} as cold`);
}

/**
 * Get lead statistics
 */
export function getLeadStatistics(): {
  total: number;
  active: number;
  responded: number;
  cold: number;
} {
  return getLeadStats.get() as {
    total: number;
    active: number;
    responded: number;
    cold: number;
  };
}

/**
 * Get leads by their email thread IDs (for response detection)
 */
export function getLeadsByThreads(threadIds: string[]): SalesLead[] {
  if (threadIds.length === 0) return [];
  const rows = getLeadsByThreadIds.all(JSON.stringify(threadIds));
  return rows.map(row => mapDbRowToLead(row as SalesLead));
}

/**
 * Get a lead by email thread ID
 */
export function getLeadByThread(threadId: string): SalesLead | undefined {
  const row = getLeadByThreadId.get(threadId);
  return row ? mapDbRowToLead(row as SalesLead) : undefined;
}

/**
 * Record that an email was opened
 */
export function recordEmailOpen(leadId: string): void {
  const now = new Date().toISOString();
  
  updateLeadOpen.run({
    id: leadId,
    last_opened_at: now,
  });
  
  console.log(`[SalesLeads] Recorded email open for ${leadId}`);
}

/**
 * Get "warm" leads - opened email but haven't responded
 * These are high priority for follow-up
 */
export function getWarmLeadsForFollowUp(): SalesLead[] {
  const rows = getWarmLeads.all();
  return rows.map(row => mapDbRowToLead(row as SalesLead));
}

/**
 * Check if we've already processed a meeting
 */
export function hasMeetingBeenProcessed(meetingId: string): boolean {
  const row = getLeadByMeetingId.get(meetingId);
  return !!row;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Map database row to SalesLead type (convert SQLite integers to booleans)
 */
function mapDbRowToLead(row: unknown): SalesLead {
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    email: r.email as string,
    name: r.name as string | undefined,
    company: r.company as string | undefined,
    linkedin_id: r.linkedin_id as string | undefined,
    linkedin_connected: Boolean(r.linkedin_connected),
    meeting_id: r.meeting_id as string | undefined,
    meeting_date: r.meeting_date as string | undefined,
    meeting_title: r.meeting_title as string | undefined,
    meeting_notes_id: r.meeting_notes_id as string | undefined,
    meeting_notes_summary: r.meeting_notes_summary as string | undefined,
    email_thread_id: r.email_thread_id as string | undefined,
    last_email_date: r.last_email_date as string | undefined,
    email_followup_count: (r.email_followup_count as number) || 0,
    first_opened_at: r.first_opened_at as string | undefined,
    last_opened_at: r.last_opened_at as string | undefined,
    open_count: (r.open_count as number) || 0,
    linkedin_request_sent: Boolean(r.linkedin_request_sent),
    linkedin_message_count: (r.linkedin_message_count as number) || 0,
    last_linkedin_date: r.last_linkedin_date as string | undefined,
    status: (r.status as LeadStatus) || 'active',
    responded_via: r.responded_via as 'email' | 'linkedin' | undefined,
    created_at: r.created_at as string | undefined,
    updated_at: r.updated_at as string | undefined,
  };
}

// =============================================================================
// SURFACED MEETINGS TRACKING
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

// Prepared statements for surfaced meetings
const insertSurfacedMeeting = db.prepare(`
  INSERT OR REPLACE INTO surfaced_meetings 
  (meeting_id, recipient_email, recipient_name, meeting_title, surfaced_at, status, draft_subject, draft_body, updated_at)
  VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'surfaced', ?, ?, CURRENT_TIMESTAMP)
`);

const getSurfacedMeetingById = db.prepare(`
  SELECT * FROM surfaced_meetings WHERE meeting_id = ?
`);

const updateSurfacedMeetingStatus = db.prepare(`
  UPDATE surfaced_meetings 
  SET status = ?, updated_at = CURRENT_TIMESTAMP 
  WHERE meeting_id = ?
`);

const countSurfacedMeetings = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN status = 'surfaced' THEN 1 ELSE 0 END) as surfaced,
    SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped,
    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent
  FROM surfaced_meetings
`);

/**
 * Record that a meeting follow-up was surfaced to the user
 */
export function markMeetingSurfaced(params: {
  meetingId: string;
  recipientEmail: string;
  recipientName?: string;
  meetingTitle?: string;
  draftSubject?: string;
  draftBody?: string;
}): void {
  insertSurfacedMeeting.run(
    params.meetingId,
    params.recipientEmail,
    params.recipientName || null,
    params.meetingTitle || null,
    params.draftSubject || null,
    params.draftBody || null
  );
  console.log(`[SalesLeads] Marked meeting surfaced: ${params.meetingTitle || params.meetingId}`);
}

/**
 * Check if a meeting has already been surfaced (regardless of status)
 */
export function isMeetingSurfaced(meetingId: string): boolean {
  const row = getSurfacedMeetingById.get(meetingId);
  return !!row;
}

/**
 * Get the surfaced meeting record
 */
export function getSurfacedMeeting(meetingId: string): SurfacedMeeting | undefined {
  const row = getSurfacedMeetingById.get(meetingId) as SurfacedMeeting | undefined;
  return row;
}

/**
 * Mark a surfaced meeting as skipped
 */
export function markMeetingSkipped(meetingId: string): void {
  updateSurfacedMeetingStatus.run('skipped', meetingId);
  console.log(`[SalesLeads] Marked meeting skipped: ${meetingId}`);
}

/**
 * Mark a surfaced meeting as sent (email was actually sent)
 */
export function markMeetingSent(meetingId: string): void {
  updateSurfacedMeetingStatus.run('sent', meetingId);
  console.log(`[SalesLeads] Marked meeting sent: ${meetingId}`);
}

/**
 * Get statistics on surfaced meetings
 */
export function getSurfacedMeetingStats(): { total: number; surfaced: number; skipped: number; sent: number } {
  const row = countSurfacedMeetings.get() as { total: number; surfaced: number; skipped: number; sent: number };
  return row;
}

// Log initialization
const stats = getLeadStatistics();
const surfacedStats = getSurfacedMeetingStats();
console.log(`[SalesLeads] Database initialized: ${stats.total} leads (${stats.active} active, ${stats.responded} responded, ${stats.cold} cold)`);
console.log(`[SalesLeads] Surfaced meetings: ${surfacedStats.total} total (${surfacedStats.surfaced} pending, ${surfacedStats.skipped} skipped, ${surfacedStats.sent} sent)`);

