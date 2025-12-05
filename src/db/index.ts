/**
 * Database Module
 * 
 * Provides persistent storage for:
 * - Surfaced profiles (to avoid duplicates)
 * - Action tracking (approved, skipped)
 * - Surfaced meetings (meeting follow-up state)
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

// Surfaced meetings tracking
export {
  hasMeetingBeenProcessed,
  isMeetingSurfaced,
  markMeetingSurfaced,
  markMeetingSkipped,
  markMeetingSent,
  getSurfacedMeeting,
  getSurfacedMeetingStats,
  getPendingSurfacedMeetings,
  type SurfacedMeeting,
  type SurfacedMeetingStatus,
} from './sales-leads.js';

