// Configuration
export * from './config.js';

// Scheduler
export * from './scheduler.js';

// Activity tracking
export * from './activity-tracker.js';

// Main engine (orchestrator)
export * from './engine.js';

// Slack handlers for discovery actions
export * from './handlers.js';

// Individual discovery modules
export * from './post-discovery.js';
export * from './people-discovery.js';
export * from './email-discovery.js';

// Meeting follow-ups (calendar-driven)
export {
  getRecentlyEndedMeetings,
  findMatchingMeetingNotes,
  generateFollowUpDraft as generateMeetingFollowUpDraft,
  surfaceMeetingFollowUp,
  discoverMeetingFollowUps,
  createLeadFromMeeting,
  type EndedMeeting,
  type MeetingAttendee,
  type MeetingNotes,
  type MeetingFollowUp,
} from './meeting-followup.js';

// Lead follow-up cadence
export {
  detectResponses,
  processResponses,
  getFollowUpsDue,
  generateFollowUpDraft as generateLeadFollowUpDraft,
  surfaceFollowUp,
  runFollowUpCadence,
  runResponseDetection,
  type FollowUpDue,
  type ResponseDetected,
} from './lead-followup.js';

// Prompts (centralized)
export * from './prompts.js';
