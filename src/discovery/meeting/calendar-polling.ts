/**
 * Calendar Polling Module
 * 
 * Functions for polling calendar for ended meetings.
 */

import {
  isUnipileConfigured,
  getCalendarEvents,
  getEventTitle,
  getEventStartTime,
  getEventEndTime,
} from '../../tools/unipile-sdk.js';
import {
  hasMeetingBeenProcessed,
  isMeetingSurfaced,
} from '../../db/sales-leads.js';
import type { EndedMeeting, MeetingAttendee, UnipileCalendarEvent } from './types.js';
import { COMPANY_DOMAIN } from './types.js';

/**
 * Get meetings that ended in the last N minutes
 */
export async function getRecentlyEndedMeetings(
  minutesAgo: number = 30
): Promise<EndedMeeting[]> {
  if (!isUnipileConfigured()) {
    console.log('[CalendarPolling] Email/calendar account not configured');
    return [];
  }

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  try {
    const events = await getCalendarEvents({
      startDate: startOfDay.toISOString(),
      endDate: now.toISOString(),
      limit: 50,
    }) as UnipileCalendarEvent[];

    const cutoffTime = new Date(now.getTime() - minutesAgo * 60 * 1000);
    const endedMeetings: EndedMeeting[] = [];

    for (const event of events) {
      const startTime = getEventStartTime(event as any);
      const endTime = getEventEndTime(event as any);
      const title = getEventTitle(event as any);
      
      // Skip if we couldn't parse times
      if (!startTime || !endTime) continue;
      
      // Skip if meeting hasn't ended yet or ended too long ago
      if (endTime > now || endTime < cutoffTime) continue;
      
      // Skip if already processed or surfaced
      if (isMeetingSurfaced(event.id) || hasMeetingBeenProcessed(event.id)) {
        continue;
      }

      // Parse attendees
      const attendees = parseAttendees(event);

      // Skip if no external attendees
      const hasExternalAttendees = attendees.some(a => a.isExternal);
      if (!hasExternalAttendees) {
        continue;
      }

      endedMeetings.push({
        id: event.id,
        title,
        startTime,
        endTime,
        attendees,
        description: event.description,
        meetingUrl: event.meeting_url,
      });
    }

    console.log(`[CalendarPolling] Found ${endedMeetings.length} recently ended meetings with external attendees`);
    return endedMeetings;
  } catch (error) {
    console.error('[CalendarPolling] Failed to fetch calendar events:', error);
    return [];
  }
}

/**
 * Get ALL meetings from the last N days (for historical backfill)
 */
export async function getHistoricalMeetings(
  daysBack: number = 30
): Promise<EndedMeeting[]> {
  if (!isUnipileConfigured()) {
    console.log('[CalendarPolling] Email/calendar account not configured');
    return [];
  }

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);

  console.log(`[CalendarPolling] Fetching meetings from ${startDate.toDateString()} to ${now.toDateString()}...`);

  try {
    const events = await getCalendarEvents({
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      limit: 200,
    }) as UnipileCalendarEvent[];

    console.log(`[CalendarPolling] Found ${events.length} total calendar events`);

    const endedMeetings: EndedMeeting[] = [];

    for (const event of events) {
      const startTime = getEventStartTime(event as any);
      const endTime = getEventEndTime(event as any);
      const title = getEventTitle(event as any);
      
      // Skip if we couldn't parse times
      if (!startTime || !endTime) {
        console.log(`[CalendarPolling] Skipping "${title}" - couldn't parse times`);
        continue;
      }
      
      // Skip if meeting hasn't ended yet
      if (endTime > now) continue;
      
      // Skip if already processed or surfaced
      if (isMeetingSurfaced(event.id) || hasMeetingBeenProcessed(event.id)) {
        console.log(`[CalendarPolling] Skipping "${title}" - already surfaced or processed`);
        continue;
      }

      // Parse attendees
      const attendees = parseAttendees(event);

      // Skip if no external attendees
      const hasExternalAttendees = attendees.some(a => a.isExternal);
      if (!hasExternalAttendees) {
        console.log(`[CalendarPolling] Skipping "${title}" - no external attendees`);
        continue;
      }

      endedMeetings.push({
        id: event.id,
        title,
        startTime,
        endTime,
        attendees,
        description: event.description,
        meetingUrl: event.meeting_url,
      });
    }

    console.log(`[CalendarPolling] Found ${endedMeetings.length} historical meetings with external attendees`);
    return endedMeetings;
  } catch (error) {
    console.error('[CalendarPolling] Failed to fetch historical events:', error);
    return [];
  }
}

/**
 * Parse attendees from calendar event
 */
function parseAttendees(event: UnipileCalendarEvent): MeetingAttendee[] {
  if (!event.attendees || event.attendees.length === 0) {
    return [];
  }

  return event.attendees
    .filter(attendee => attendee.email)
    .map(attendee => ({
      email: attendee.email!,
      name: attendee.name,
      isExternal: !attendee.email!.toLowerCase().endsWith(`@${COMPANY_DOMAIN}`),
    }));
}

