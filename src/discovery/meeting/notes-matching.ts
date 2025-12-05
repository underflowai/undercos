/**
 * Meeting Notes Matching Module
 * 
 * Functions for finding and parsing Day.ai meeting notes.
 */

import { isUnipileConfigured, getEmails } from '../../tools/unipile-sdk.js';
import type { EndedMeeting, MeetingNotes, UnipileEmail } from './types.js';
import { DAY_AI_SENDER } from './types.js';

/**
 * Find meeting notes that match a specific meeting
 * @param meeting - The meeting to find notes for
 * @param historical - If true, search more broadly (for backfill)
 */
export async function findMatchingMeetingNotes(
  meeting: EndedMeeting,
  historical?: boolean
): Promise<MeetingNotes | null> {
  if (!isUnipileConfigured()) {
    return null;
  }

  try {
    // For historical backfill, search a window around the meeting date
    // For real-time, search only after the meeting ended
    let since: string;
    if (historical) {
      // Search from 1 day before meeting to catch any notes
      const searchStart = new Date(meeting.endTime);
      searchStart.setDate(searchStart.getDate() - 1);
      since = searchStart.toISOString();
    } else {
      since = meeting.endTime.toISOString();
    }

    const emails = await getEmails({
      from: DAY_AI_SENDER,
      after: since,
      limit: historical ? 30 : 10,
    }) as UnipileEmail[];

    if (emails.length === 0) {
      console.log(`[NotesMatching] No notes found for "${meeting.title}" (${meeting.endTime.toDateString()})`);
      return null;
    }

    // Try to match by content (attendee names, meeting title)
    const matchedEmail = findBestMatch(meeting, emails);
    
    if (!matchedEmail) {
      console.log(`[NotesMatching] No matching notes for "${meeting.title}"`);
      return null;
    }

    // Parse the meeting notes
    const parsed = parseMeetingNotesContent(matchedEmail.body || '');

    return {
      id: matchedEmail.id,
      subject: matchedEmail.subject || 'Meeting Notes',
      body: matchedEmail.body || '',
      receivedAt: new Date(matchedEmail.date || Date.now()),
      keyPoints: parsed.keyPoints,
      actionItems: parsed.actionItems,
      nextSteps: parsed.nextSteps,
    };
  } catch (error) {
    console.error('[NotesMatching] Failed to search meeting notes:', error);
    return null;
  }
}

/**
 * Find the best matching email for a meeting
 */
function findBestMatch(
  meeting: EndedMeeting,
  emails: UnipileEmail[]
): UnipileEmail | null {
  const meetingTitleLower = meeting.title.toLowerCase();
  const attendeeNames = meeting.attendees
    .filter(a => a.isExternal && a.name)
    .map(a => a.name!.toLowerCase());
  const attendeeEmails = meeting.attendees
    .filter(a => a.isExternal)
    .map(a => a.email.toLowerCase());

  let bestMatch: UnipileEmail | null = null;
  let bestScore = 0;

  for (const email of emails) {
    let score = 0;
    const subjectLower = (email.subject || '').toLowerCase();
    const bodyLower = (email.body || '').toLowerCase();

    // Check if meeting title appears in subject or body
    if (subjectLower.includes(meetingTitleLower) || bodyLower.includes(meetingTitleLower)) {
      score += 10;
    }

    // Check for attendee names
    for (const name of attendeeNames) {
      if (subjectLower.includes(name) || bodyLower.includes(name)) {
        score += 5;
      }
    }

    // Check for attendee emails
    for (const emailAddr of attendeeEmails) {
      if (bodyLower.includes(emailAddr)) {
        score += 3;
      }
    }

    // Time proximity bonus (closer to meeting end = higher score)
    const emailTime = new Date(email.date || 0);
    const timeDiff = emailTime.getTime() - meeting.endTime.getTime();
    if (timeDiff >= 0 && timeDiff < 30 * 60 * 1000) {
      // Within 30 minutes of meeting end
      score += 5 - Math.floor(timeDiff / (6 * 60 * 1000));
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = email;
    }
  }

  // Only return if we have a reasonable match
  if (bestScore >= 3) {
    console.log(`[NotesMatching] Matched notes with score ${bestScore}: "${bestMatch?.subject}"`);
    return bestMatch;
  }

  return null;
}

/**
 * Parse meeting notes content to extract key points, action items, etc.
 */
export function parseMeetingNotesContent(body: string): {
  keyPoints: string[];
  actionItems: string[];
  nextSteps: string[];
} {
  const keyPoints: string[] = [];
  const actionItems: string[] = [];
  const nextSteps: string[] = [];

  const lines = body.split('\n');
  let currentSection: 'none' | 'key' | 'action' | 'next' = 'none';

  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    
    // Detect section headers
    if (trimmed.includes('key point') || trimmed.includes('summary') || trimmed.includes('discussion')) {
      currentSection = 'key';
      continue;
    }
    if (trimmed.includes('action item') || trimmed.includes('task') || trimmed.includes('to do') || trimmed.includes('to-do')) {
      currentSection = 'action';
      continue;
    }
    if (trimmed.includes('next step') || trimmed.includes('follow-up') || trimmed.includes('follow up')) {
      currentSection = 'next';
      continue;
    }

    // Extract bullet points
    const bulletMatch = line.match(/^[\s]*[-•*]\s*(.+)$/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      if (content) {
        switch (currentSection) {
          case 'key':
            keyPoints.push(content);
            break;
          case 'action':
            actionItems.push(content);
            break;
          case 'next':
            nextSteps.push(content);
            break;
        }
      }
    }
  }

  return { keyPoints, actionItems, nextSteps };
}

