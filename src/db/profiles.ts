/**
 * Profile Tracking Database
 * 
 * Persists surfaced profiles to SQLite to:
 * - Avoid re-surfacing the same person
 * - Track what action was taken (approved, skipped, pending)
 * - Provide queryable history of outreach
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database file location
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'profiles.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS surfaced_profiles (
    id TEXT PRIMARY KEY,              -- public_identifier (for deduplication)
    provider_id TEXT,                 -- ACoAAA... (for API calls)
    name TEXT NOT NULL,
    headline TEXT,
    company TEXT,
    profile_url TEXT,
    surfaced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    action TEXT DEFAULT 'pending',    -- 'pending', 'approved', 'skipped'
    action_at DATETIME,
    connection_note TEXT,
    source TEXT DEFAULT 'discovery',  -- 'discovery', 'manual'
    search_query TEXT                 -- Which query found this person (for learning)
  );
  
  CREATE INDEX IF NOT EXISTS idx_surfaced_at ON surfaced_profiles(surfaced_at);
  CREATE INDEX IF NOT EXISTS idx_action ON surfaced_profiles(action);
  CREATE INDEX IF NOT EXISTS idx_search_query ON surfaced_profiles(search_query);
`);

// Migration: Add search_query column if it doesn't exist (for existing databases)
try {
  db.exec(`ALTER TABLE surfaced_profiles ADD COLUMN search_query TEXT`);
  console.log('[DB] Added search_query column');
} catch {
  // Column already exists, ignore
}

// =============================================================================
// TYPES
// =============================================================================

export interface SurfacedProfile {
  id: string;
  provider_id?: string;
  name: string;
  headline?: string;
  company?: string;
  profile_url?: string;
  surfaced_at?: string;
  action?: 'pending' | 'approved' | 'skipped';
  action_at?: string;
  connection_note?: string;
  source?: string;
  search_query?: string;
}

export type ProfileAction = 'pending' | 'approved' | 'skipped';

// =============================================================================
// QUERIES
// =============================================================================

const insertProfile = db.prepare(`
  INSERT OR IGNORE INTO surfaced_profiles 
    (id, provider_id, name, headline, company, profile_url, connection_note, source, search_query)
  VALUES 
    (@id, @provider_id, @name, @headline, @company, @profile_url, @connection_note, @source, @search_query)
`);

const updateAction = db.prepare(`
  UPDATE surfaced_profiles 
  SET action = @action, action_at = CURRENT_TIMESTAMP, connection_note = COALESCE(@connection_note, connection_note)
  WHERE id = @id
`);

const getProfile = db.prepare(`
  SELECT * FROM surfaced_profiles WHERE id = ?
`);

const hasProfile = db.prepare(`
  SELECT 1 FROM surfaced_profiles WHERE id = ?
`);

const getRecentProfiles = db.prepare(`
  SELECT * FROM surfaced_profiles 
  ORDER BY surfaced_at DESC 
  LIMIT ?
`);

const getProfilesByAction = db.prepare(`
  SELECT * FROM surfaced_profiles 
  WHERE action = ? 
  ORDER BY action_at DESC 
  LIMIT ?
`);

const getStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN action = 'pending' THEN 1 ELSE 0 END) as pending,
    SUM(CASE WHEN action = 'approved' THEN 1 ELSE 0 END) as approved,
    SUM(CASE WHEN action = 'skipped' THEN 1 ELSE 0 END) as skipped
  FROM surfaced_profiles
`);

const getTodayStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN action = 'approved' THEN 1 ELSE 0 END) as approved
  FROM surfaced_profiles
  WHERE date(surfaced_at) = date('now')
`);

const getQueryPerformance = db.prepare(`
  SELECT 
    search_query,
    COUNT(*) as total,
    SUM(CASE WHEN action = 'approved' THEN 1 ELSE 0 END) as approved,
    SUM(CASE WHEN action = 'skipped' THEN 1 ELSE 0 END) as skipped,
    ROUND(100.0 * SUM(CASE WHEN action = 'approved' THEN 1 ELSE 0 END) / COUNT(*), 1) as approval_rate
  FROM surfaced_profiles
  WHERE search_query IS NOT NULL 
    AND action != 'pending'
    AND surfaced_at >= datetime('now', '-30 days')
  GROUP BY search_query
  HAVING COUNT(*) >= 2
  ORDER BY approval_rate DESC
`);

// =============================================================================
// FUNCTIONS
// =============================================================================

/**
 * Check if a profile has already been surfaced
 */
export function isProfileSeen(profileId: string): boolean {
  return hasProfile.get(profileId) !== undefined;
}

/**
 * Add a profile to the database (when surfaced in Slack)
 */
export function addSurfacedProfile(profile: {
  id: string;
  provider_id?: string;
  name: string;
  headline?: string;
  company?: string;
  profile_url?: string;
  connection_note?: string;
  source?: string;
  search_query?: string;
}): void {
  insertProfile.run({
    id: profile.id,
    provider_id: profile.provider_id || null,
    name: profile.name,
    headline: profile.headline || null,
    company: profile.company || null,
    profile_url: profile.profile_url || null,
    connection_note: profile.connection_note || null,
    source: profile.source || 'discovery',
    search_query: profile.search_query || null,
  });
  
  console.log(`[DB] Added profile: ${profile.name} (${profile.id})${profile.search_query ? ` [query: "${profile.search_query}"]` : ''}`);
}

/**
 * Update the action taken on a profile
 */
export function recordProfileAction(
  profileId: string, 
  action: ProfileAction,
  connectionNote?: string
): void {
  updateAction.run({
    id: profileId,
    action,
    connection_note: connectionNote || null,
  });
  
  console.log(`[DB] Recorded action: ${action} for ${profileId}`);
}

/**
 * Get a specific profile
 */
export function getProfileById(profileId: string): SurfacedProfile | undefined {
  return getProfile.get(profileId) as SurfacedProfile | undefined;
}

/**
 * Get recent profiles
 */
export function getRecentSurfacedProfiles(limit: number = 20): SurfacedProfile[] {
  return getRecentProfiles.all(limit) as SurfacedProfile[];
}

/**
 * Get profiles by action
 */
export function getProfilesByActionType(action: ProfileAction, limit: number = 20): SurfacedProfile[] {
  return getProfilesByAction.all(action, limit) as SurfacedProfile[];
}

/**
 * Get statistics
 */
export function getProfileStats(): { total: number; pending: number; approved: number; skipped: number } {
  return getStats.get() as { total: number; pending: number; approved: number; skipped: number };
}

/**
 * Get today's statistics
 */
export function getTodayProfileStats(): { total: number; approved: number } {
  return getTodayStats.get() as { total: number; approved: number };
}

/**
 * Query performance data for learning
 */
export interface QueryPerformance {
  search_query: string;
  total: number;
  approved: number;
  skipped: number;
  approval_rate: number;
}

/**
 * Get performance metrics for search queries (last 30 days)
 * Only includes queries with at least 2 results and a decision made
 */
export function getQueryPerformanceStats(): QueryPerformance[] {
  return getQueryPerformance.all() as QueryPerformance[];
}

/**
 * Format query performance for AI feedback
 * Returns a string the AI can use to learn what's working
 */
export function formatQueryFeedbackForAI(): string {
  const stats = getQueryPerformanceStats();
  
  if (stats.length === 0) {
    return 'No query performance data yet. Keep experimenting with different search terms.';
  }
  
  const highPerforming = stats.filter(q => q.approval_rate >= 50);
  const lowPerforming = stats.filter(q => q.approval_rate < 30 && q.total >= 3);
  
  const lines: string[] = [];
  
  if (highPerforming.length > 0) {
    lines.push('QUERIES THAT WORK WELL (50%+ approval):');
    for (const q of highPerforming.slice(0, 5)) {
      lines.push(`- "${q.search_query}" (${q.approved}/${q.total} approved, ${q.approval_rate}%)`);
    }
  }
  
  if (lowPerforming.length > 0) {
    lines.push('');
    lines.push('QUERIES THAT DONT WORK (<30% approval):');
    for (const q of lowPerforming.slice(0, 3)) {
      lines.push(`- "${q.search_query}" (${q.approved}/${q.total} approved, ${q.approval_rate}%)`);
    }
  }
  
  if (lines.length === 0) {
    lines.push('Not enough data yet to identify patterns. Need more approved/skipped profiles.');
  }
  
  return lines.join('\n');
}

/**
 * Get count of seen profiles
 */
export function getSeenProfilesCount(): number {
  const stats = getProfileStats();
  return stats.total;
}

/**
 * Close database connection (for graceful shutdown)
 */
export function closeDatabase(): void {
  db.close();
  console.log('[DB] Database connection closed');
}

// Log database initialization
const stats = getProfileStats();
console.log(`[DB] Profile database initialized: ${stats.total} profiles (${stats.approved} approved, ${stats.skipped} skipped, ${stats.pending} pending)`);

