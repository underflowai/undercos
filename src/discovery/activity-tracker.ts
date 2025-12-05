import { getDailyCount as getDbDailyCount, getWeeklyCount as getDbWeeklyCount, incrementActivityCount, pruneOldActivity } from '../db/activity-metrics.js';

/**
 * Activity Tracker - Monitors LinkedIn actions to stay within best practice limits
 * 
 * Based on Unipile/LinkedIn best practices:
 * - Invitations: 80-100/day, max 200/week (recommended: 30-50/day spread across week) ⚠️ MAIN LIMIT
 * - Profile views: 80-100/day (Premium), 150/day (Sales Navigator)
 * - Comments: Be conservative, ~20-30/day recommended
 * - Likes: More lenient, ~50-100/day
 * - Messages: ~50-100/day
 * - Searches: NOT really limited - track for observability only
 * 
 * SMART PACING: Don't blow through weekly invitation budget early.
 * Spread invitations across working days (Mon-Fri) at random intervals.
 * 
 * THROTTLING: Only throttle based on outbound engagement (invitations, comments, messages)
 * NOT on searches or profile views.
 */

export type ActivityType = 
  | 'invitation'
  | 'profile_view'
  | 'comment'
  | 'like'
  | 'message'
  | 'search';

interface ActivityLimits {
  daily: number;
  weekly?: number;
  recommended?: number; // Safer daily limit
}

// LinkedIn best practice limits
// Weekly limits are spread across 5 working days to avoid running out mid-week
const ACTIVITY_LIMITS: Record<ActivityType, ActivityLimits> = {
  invitation: {
    daily: 80,
    weekly: 200,
    recommended: 35, // 200/week ÷ 5 days = 40, but stay conservative at 35
  },
  profile_view: {
    daily: 100,
    recommended: 40, // Stay well under to be safe
  },
  comment: {
    daily: 30,
    recommended: 10, // Very conservative for comments
  },
  like: {
    daily: 100,
    recommended: 30, // Don't like too many posts
  },
  message: {
    daily: 100,
    recommended: 20, // Messages should be thoughtful, not mass
  },
  search: {
    daily: 500, // Searches are not really limited by LinkedIn
    recommended: 200, // Track for observability, but don't throttle
  },
};

/**
 * Get today's date as YYYY-MM-DD
 */
function getTodayKey(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get activity count for today
 */
export function getTodayCount(type: ActivityType): number {
  return getDbDailyCount(type);
}

/**
 * Get activity count for the week (last 7 days)
 */
export function getWeeklyCount(type: ActivityType): number {
  return getDbWeeklyCount(type);
}

/**
 * Get the number of working days remaining this week (Mon-Fri)
 */
function getWorkingDaysRemainingThisWeek(): number {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
  
  // If weekend, return 5 (full week ahead)
  if (dayOfWeek === 0) return 5;
  if (dayOfWeek === 6) return 5;
  
  // Mon(1) -> 5 days, Tue(2) -> 4, Wed(3) -> 3, Thu(4) -> 2, Fri(5) -> 1
  return 6 - dayOfWeek;
}

/**
 * Calculate smart daily budget based on weekly remaining
 * Spreads remaining weekly budget across remaining working days
 */
function getSmartDailyBudget(type: ActivityType): number {
  const limits = ACTIVITY_LIMITS[type];
  
  if (!limits.weekly) {
    return limits.recommended || limits.daily;
  }
  
  const weeklyCount = getWeeklyCount(type);
  const weeklyRemaining = limits.weekly - weeklyCount;
  const daysRemaining = getWorkingDaysRemainingThisWeek();
  
  if (daysRemaining <= 0) return 0;
  
  // Spread remaining budget across remaining days, but cap at recommended
  const smartDaily = Math.floor(weeklyRemaining / daysRemaining);
  const recommended = limits.recommended || limits.daily;
  
  // Don't exceed recommended daily, but also don't go below 5 (minimum activity)
  return Math.max(5, Math.min(smartDaily, recommended));
}

/**
 * Check if we can perform an action
 * Uses smart pacing to spread weekly budget across working days
 */
export function canPerformAction(type: ActivityType, useRecommended = true): {
  allowed: boolean;
  reason?: string;
  dailyCount: number;
  dailyLimit: number;
  weeklyCount?: number;
  weeklyLimit?: number;
  smartBudget?: number;
} {
  const limits = ACTIVITY_LIMITS[type];
  const dailyCount = getTodayCount(type);
  
  // Use smart budget for weekly-limited activities
  const smartBudget = limits.weekly ? getSmartDailyBudget(type) : undefined;
  const dailyLimit = smartBudget || (useRecommended && limits.recommended ? limits.recommended : limits.daily);
  
  // Check daily limit (smart or standard)
  if (dailyCount >= dailyLimit) {
    const reason = smartBudget 
      ? `Smart daily ${type} budget reached (${dailyCount}/${dailyLimit} - pacing for week)`
      : `Daily ${type} limit reached (${dailyCount}/${dailyLimit})`;
    return {
      allowed: false,
      reason,
      dailyCount,
      dailyLimit,
      smartBudget,
    };
  }
  
  // Check weekly limit if applicable
  if (limits.weekly) {
    const weeklyCount = getWeeklyCount(type);
    if (weeklyCount >= limits.weekly) {
      return {
        allowed: false,
        reason: `Weekly ${type} limit reached (${weeklyCount}/${limits.weekly})`,
        dailyCount,
        dailyLimit,
        weeklyCount,
        weeklyLimit: limits.weekly,
        smartBudget,
      };
    }
    
    return {
      allowed: true,
      dailyCount,
      dailyLimit,
      weeklyCount,
      weeklyLimit: limits.weekly,
      smartBudget,
    };
  }
  
  return {
    allowed: true,
    dailyCount,
    dailyLimit,
    smartBudget,
  };
}

/**
 * Record an activity
 */
export function recordActivity(type: ActivityType): void {
  pruneOldActivity(14);
  incrementActivityCount(type);
  console.log(`[Activity] Recorded ${type}: ${getTodayCount(type)} today`);
}

/**
 * Get a summary of today's activity
 */
export function getActivitySummary(): {
  date: string;
  activities: Array<{
    type: ActivityType;
    count: number;
    dailyLimit: number;
    weeklyCount?: number;
    weeklyLimit?: number;
    percentUsed: number;
    status: 'ok' | 'warning' | 'limit_reached';
  }>;
} {
  const today = getTodayKey();
  const activities: ReturnType<typeof getActivitySummary>['activities'] = [];
  
  for (const type of Object.keys(ACTIVITY_LIMITS) as ActivityType[]) {
    const limits = ACTIVITY_LIMITS[type];
    const dailyCount = getTodayCount(type);
    const dailyLimit = limits.recommended || limits.daily;
    const weeklyCount = limits.weekly ? getWeeklyCount(type) : undefined;
    const percentUsed = Math.round((dailyCount / dailyLimit) * 100);
    
    let status: 'ok' | 'warning' | 'limit_reached' = 'ok';
    if (dailyCount >= dailyLimit || (weeklyCount && limits.weekly && weeklyCount >= limits.weekly)) {
      status = 'limit_reached';
    } else if (percentUsed >= 80) {
      status = 'warning';
    }
    
    activities.push({
      type,
      count: dailyCount,
      dailyLimit,
      weeklyCount,
      weeklyLimit: limits.weekly,
      percentUsed,
      status,
    });
  }
  
  return { date: today, activities };
}

/**
 * Format activity summary for Slack
 */
export function formatActivitySummaryForSlack(): string {
  const summary = getActivitySummary();
  
  const lines = [
    `*📊 LinkedIn Activity Summary (${summary.date})*`,
    '',
  ];
  
  for (const activity of summary.activities) {
    const emoji = activity.status === 'limit_reached' ? 'High' 
                : activity.status === 'warning' ? 'Normal' 
                : '🟢';
    
    let line = `${emoji} *${activity.type}*: ${activity.count}/${activity.dailyLimit} daily`;
    if (activity.weeklyLimit) {
      line += ` (${activity.weeklyCount}/${activity.weeklyLimit} weekly)`;
    }
    line += ` - ${activity.percentUsed}%`;
    
    lines.push(line);
  }
  
  return lines.join('\n');
}

/**
 * Check if we should slow down based on activity levels
 * Only considers OUTBOUND actions (invitations, comments, messages) - not searches
 */
export function shouldThrottle(): { throttle: boolean; reason?: string } {
  // Only throttle based on outbound engagement actions, NOT searches
  // Searches are relatively unlimited; invitations/comments are what get you flagged
  const throttleableTypes: ActivityType[] = ['invitation', 'comment', 'like', 'message'];
  
  const summary = getActivitySummary();
  const relevantActivities = summary.activities.filter(a => throttleableTypes.includes(a.type));
  
  // Check if any outbound activity is at limit
  const limitReached = relevantActivities.filter(a => a.status === 'limit_reached');
  if (limitReached.length > 0) {
    return {
      throttle: true,
      reason: `Limit reached for: ${limitReached.map(a => a.type).join(', ')}`,
    };
  }
  
  // Only throttle if MULTIPLE outbound actions are at warning level
  const warnings = relevantActivities.filter(a => a.status === 'warning');
  if (warnings.length >= 2) {
    return {
      throttle: true,
      reason: `Approaching limits for: ${warnings.map(a => a.type).join(', ')}`,
    };
  }
  
  return { throttle: false };
}

/**
 * Get recommended wait time between actions (in ms)
 * Randomized to avoid detection patterns
 */
export function getRecommendedDelay(type: ActivityType): number {
  // Base delays in seconds
  const baseDelays: Record<ActivityType, { min: number; max: number }> = {
    invitation: { min: 30, max: 120 },    // 30s - 2min between invitations
    profile_view: { min: 5, max: 30 },    // 5-30s between profile views
    comment: { min: 60, max: 300 },       // 1-5min between comments
    like: { min: 5, max: 30 },            // 5-30s between likes
    message: { min: 30, max: 120 },       // 30s - 2min between messages
    search: { min: 10, max: 60 },         // 10s - 1min between searches
  };
  
  const delay = baseDelays[type];
  const randomDelay = Math.floor(Math.random() * (delay.max - delay.min + 1)) + delay.min;
  
  return randomDelay * 1000; // Convert to ms
}

