/**
 * Meeting Follow-up Discovery
 * 
 * Monitors calendar for ended meetings, matches them with Day.ai meeting notes,
 * and generates follow-up email drafts for approval.
 * 
 * Flow:
 * 1. Poll calendar every 15 minutes
 * 2. Find meetings that ended in last 15-30 min with external attendees
 * 3. Look for matching meeting notes from assistant@day.ai
 * 4. Parse notes and draft follow-up email
 * 5. Surface in Slack for approval
 * 6. On send: create sales lead, apply "Sales Leads" label
 */

// Re-export types
export * from './types.js';

// Re-export email history functions
export { hasRecentlyEmailedRecipient, getEmailHistoryContext } from './email-history.js';

// Re-export calendar polling functions
export { getRecentlyEndedMeetings, getHistoricalMeetings } from './calendar-polling.js';

// Re-export notes matching functions
export { findMatchingMeetingNotes, parseMeetingNotesContent } from './notes-matching.js';

// Re-export classification, draft generation, and surfacing from the main file
// These have complex LLM/Slack dependencies that are better kept together
export {
  classifyMeeting,
  queueLinkedInConnectionForAttendee,
  generateFollowUpDraft,
  generateFollowUpWithAgent,
  surfaceMeetingFollowUp,
  discoverMeetingFollowUps,
  runHistoricalBackfill,
  createLeadFromMeeting,
} from './orchestration.js';

