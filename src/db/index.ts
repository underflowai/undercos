/**
 * Database Module
 * 
 * Provides persistent storage for:
 * - Surfaced profiles (to avoid duplicates)
 * - Action tracking (approved, skipped)
 * - Sales leads (meeting follow-ups and cadence)
 */

export {
  isProfileSeen,
  addSurfacedProfile,
  recordProfileAction,
  getProfileById,
  getRecentSurfacedProfiles,
  getProfilesByActionType,
  getProfileStats,
  getTodayProfileStats,
  getSeenProfilesCount,
  getQueryPerformanceStats,
  formatQueryFeedbackForAI,
  closeDatabase,
  type SurfacedProfile,
  type ProfileAction,
  type QueryPerformance,
} from './profiles.js';

// Sales leads
export {
  createLead,
  getLead,
  getLeadByEmailAddress,
  getLeadByMeeting,
  getLeadByThread,
  getAllActiveLeads,
  getLeadsDueForFollowUp,
  getLeadsByFollowUpStage,
  getLeadsByThreads,
  getWarmLeadsForFollowUp,
  recordEmailSent,
  recordEmailOpen,
  recordLinkedInActivity,
  markLeadLinkedInConnected,
  markLeadResponded,
  markLeadCold,
  getLeadStatistics,
  hasMeetingBeenProcessed,
  // Surfaced meetings tracking
  isMeetingSurfaced,
  markMeetingSurfaced,
  markMeetingSkipped,
  markMeetingSent,
  getSurfacedMeeting,
  getSurfacedMeetingStats,
  type SalesLead,
  type LeadStatus,
  type CreateLeadParams,
  type SurfacedMeeting,
  type SurfacedMeetingStatus,
} from './sales-leads.js';

