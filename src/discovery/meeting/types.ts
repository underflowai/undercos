/**
 * Meeting Follow-up Types
 * 
 * Shared type definitions for the meeting follow-up system.
 */

// =============================================================================
// CALENDAR / EMAIL TYPES
// =============================================================================

export interface UnipileCalendarEvent {
  id: string;
  title?: string;
  summary?: string;
  start_time?: unknown;
  start?: unknown;
  end_time?: unknown;
  end?: unknown;
  attendees?: Array<{ email?: string; name?: string }>;
  description?: string;
  meeting_url?: string;
}

export interface UnipileEmail {
  id: string;
  subject?: string;
  from: { name?: string; email: string };
  to: Array<{ name?: string; email: string }>;
  cc?: Array<{ name?: string; email: string }>;
  date?: string;
  body?: string;
  body_plain?: string;
  has_attachments?: boolean;
  is_read?: boolean;
}

// =============================================================================
// MEETING TYPES
// =============================================================================

export interface EndedMeeting {
  id: string;
  title: string;
  startTime: Date;
  endTime: Date;
  attendees: MeetingAttendee[];
  description?: string;
  meetingUrl?: string;
}

export interface MeetingAttendee {
  email: string;
  name?: string;
  isExternal: boolean;
}

export interface MeetingNotes {
  id: string;
  subject: string;
  body: string;
  receivedAt: Date;
  keyPoints: string[];
  actionItems: string[];
  nextSteps: string[];
}

export interface MeetingFollowUp {
  meeting: EndedMeeting;
  notes: MeetingNotes;
  primaryRecipient: MeetingAttendee;
  draftEmail: {
    to: string[];
    subject: string;
    body: string;
  };
}

export interface EmailHistoryContext {
  recentEmails: Array<{
    subject: string;
    date: string;
    fromMe: boolean;
    snippet: string;
    body: string;
  }>;
  lastContactDate?: string;
  hasRecentContact: boolean;
}

export interface MeetingClassification {
  classification: 'sales' | 'skip';
  reason: string;
  priority: 'high' | 'low';
}

// =============================================================================
// CONSTANTS
// =============================================================================

export const DAY_AI_SENDER = 'assistant@day.ai';
export const COMPANY_DOMAIN = 'useunderflow.com';
export const MEETING_NOTES_FOLDER = 'Meeting Notes';
export const RECENT_EMAIL_DAYS = 7;

