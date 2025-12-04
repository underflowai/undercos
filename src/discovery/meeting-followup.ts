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

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/bolt';
import type { ResponsesAPIClient } from '../llm/responses.js';
import {
  getUnipileClient,
  getActiveEmailAccountId,
  getEventTitle,
  getEventStartTime,
  getEventEndTime,
  type UnipileCalendarEvent,
  type UnipileEmail,
} from '../tools/unipile.js';
import {
  createLead,
  hasMeetingBeenProcessed,
  isMeetingSurfaced,
  markMeetingSurfaced,
  type CreateLeadParams,
} from '../db/sales-leads.js';
import { MEETING_FOLLOWUP_PROMPT, MEETING_CLASSIFICATION_PROMPT, AGENT_FOLLOWUP_PROMPT } from './prompts.js';
import { getContentGenerationConfig } from '../config/models.js';
import { generateContent } from '../llm/content-generator.js';
import type { DiscoveryConfig } from './config.js';

// Constants
const DAY_AI_SENDER = 'assistant@day.ai';
const COMPANY_DOMAIN = 'useunderflow.com';
const MEETING_NOTES_FOLDER = 'Meeting Notes';
const RECENT_EMAIL_DAYS = 7; // Consider as "already followed up" if emailed in last 7 days

// =============================================================================
// TYPES
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
    body: string; // Full email body for context
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
// PRIOR EMAIL DETECTION
// =============================================================================

/**
 * Check if we've emailed this person AFTER a specific date
 * Used to avoid duplicate follow-ups for meetings
 * @param sinceDate - Only count emails sent after this date (e.g., meeting end time)
 */
export async function hasRecentlyEmailedRecipient(
  recipientEmail: string,
  sinceDate?: Date
): Promise<{ hasEmailed: boolean; lastEmailDate?: string; lastSubject?: string }> {
  const client = getUnipileClient();
  const accountId = await getActiveEmailAccountId();

  if (!client || !accountId) {
    return { hasEmailed: false };
  }

  try {
    // Use provided date or default to RECENT_EMAIL_DAYS ago
    const cutoffDate = sinceDate || new Date(Date.now() - RECENT_EMAIL_DAYS * 24 * 60 * 60 * 1000);

    // Note: Unipile API's `since` filter doesn't work correctly with `to` filter
    // So we fetch more results and filter by date ourselves
    const sentEmails = await client.searchEmailsToRecipient({
      account_id: accountId,
      recipient: recipientEmail,
      folder: 'SENT',
      limit: 20, // Fetch more to ensure we have enough to filter
    });

    // Filter by date ourselves since the API doesn't do it correctly
    const emailsAfterCutoff = sentEmails.filter(email => {
      const emailDate = new Date(email.date);
      return emailDate > cutoffDate;
    });

    if (emailsAfterCutoff.length > 0) {
      const mostRecent = emailsAfterCutoff[0];
      console.log(`[MeetingFollowup] Found email to ${recipientEmail} on ${mostRecent.date}: "${mostRecent.subject}"`);
      return {
        hasEmailed: true,
        lastEmailDate: mostRecent.date,
        lastSubject: mostRecent.subject,
      };
    }

    console.log(`[MeetingFollowup] No emails to ${recipientEmail} after ${cutoffDate.toISOString()}`);
    return { hasEmailed: false };
  } catch (error) {
    console.error('[MeetingFollowup] Failed to check recent emails:', error);
    return { hasEmailed: false };
  }
}

/**
 * Get email history context with a person for better draft generation
 * Now includes FULL email bodies for richer context
 */
export async function getEmailHistoryContext(
  contactEmail: string
): Promise<EmailHistoryContext> {
  const client = getUnipileClient();
  const accountId = await getActiveEmailAccountId();

  if (!client || !accountId) {
    return { recentEmails: [], hasRecentContact: false };
  }

  try {
    const emails = await client.getEmailHistoryWithContact({
      account_id: accountId,
      contactEmail,
      limit: 15, // Get more for full context
    });
    
    const recentEmails = emails.map(email => ({
      subject: email.subject,
      date: email.date,
      fromMe: email.from?.email?.toLowerCase() !== contactEmail.toLowerCase(),
      snippet: (email.body || '').slice(0, 200),
      body: email.body || '', // Include full body
    }));

    const lastContactDate = emails[0]?.date;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RECENT_EMAIL_DAYS);
    const hasRecentContact = lastContactDate 
      ? new Date(lastContactDate) > cutoffDate 
      : false;

    console.log(`[MeetingFollowup] Found ${emails.length} emails with ${contactEmail} (full bodies included)`);

    return {
      recentEmails,
      lastContactDate,
      hasRecentContact,
    };
  } catch (error) {
    console.error('[MeetingFollowup] Failed to get email history:', error);
    return { recentEmails: [], hasRecentContact: false };
  }
}

// =============================================================================
// MEETING CLASSIFICATION
// =============================================================================

/**
 * Use AI to classify whether a meeting warrants a business follow-up
 */
export async function classifyMeeting(
  llm: ResponsesAPIClient,
  meeting: EndedMeeting
): Promise<MeetingClassification> {
  const contentConfig = getContentGenerationConfig();
  
  try {
    const input = [
      { type: 'message' as const, role: 'system' as const, content: MEETING_CLASSIFICATION_PROMPT },
      {
        type: 'message' as const,
        role: 'user' as const,
        content: `Meeting: "${meeting.title}"
Attendees: ${meeting.attendees.map(a => `${a.name || 'Unknown'} (${a.email})${a.isExternal ? '' : ' [internal]'}`).join(', ')}
Duration: ${Math.round((meeting.endTime.getTime() - meeting.startTime.getTime()) / 60000)} minutes`,
      },
    ];

    const response = await llm.createResponse(input, [], {
      reasoningEffort: contentConfig.reasoningEffort,
    });

    const text = response.outputText || '';
    
    // Try to parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[MeetingFollowup] Classified "${meeting.title}" as ${parsed.classification}: ${parsed.reason}`);
      return {
        classification: parsed.classification || 'skip',
        reason: parsed.reason || 'Unknown',
        priority: parsed.priority || 'low',
      };
    }
    
    // Default to skip if can't parse
    console.log(`[MeetingFollowup] Could not classify "${meeting.title}", defaulting to skip`);
    return { classification: 'skip', reason: 'Could not classify', priority: 'low' };
  } catch (error) {
    console.error('[MeetingFollowup] Classification failed:', error);
    return { classification: 'skip', reason: 'Classification error', priority: 'low' };
  }
}

// =============================================================================
// LINKEDIN CONNECTION
// =============================================================================

/**
 * Look up meeting attendee on LinkedIn and queue connection request if not connected
 */
export async function queueLinkedInConnectionForAttendee(
  attendee: MeetingAttendee,
  meetingContext: { title: string; date: Date }
): Promise<{ found: boolean; alreadyConnected: boolean; queued: boolean }> {
  const { getUnipileClient, getActiveAccountId } = await import('../tools/unipile.js');
  const client = getUnipileClient();
  const accountId = await getActiveAccountId();

  if (!client || !accountId) {
    return { found: false, alreadyConnected: false, queued: false };
  }

  try {
    // Search for the person on LinkedIn by name and company
    const searchName = attendee.name || attendee.email.split('@')[0];
    const searchResults = await client.searchUsers({
      account_id: accountId,
      query: searchName,
      limit: 5,
    });

    if (searchResults.items.length === 0) {
      console.log(`[MeetingFollowup] No LinkedIn profile found for ${searchName}`);
      return { found: false, alreadyConnected: false, queued: false };
    }

    // Try to match by name or company domain
    const emailDomain = attendee.email.split('@')[1]?.replace('www.', '');
    const match = searchResults.items.find(p => {
      const nameMatch = p.name?.toLowerCase().includes(searchName.toLowerCase());
      const companyMatch = emailDomain && p.company?.toLowerCase().includes(emailDomain.split('.')[0]);
      return nameMatch || companyMatch;
    }) || searchResults.items[0];

    if (match.is_connection) {
      console.log(`[MeetingFollowup] Already connected with ${match.name} on LinkedIn`);
      return { found: true, alreadyConnected: true, queued: false };
    }

    // Generate a personalized connection note referencing the meeting
    const { LINKEDIN_MEETING_NOTE_PROMPT } = await import('./prompts.js');
    const { generateContent } = await import('../llm/content-generator.js');
    const { ResponsesAPIClient } = await import('../llm/responses.js');
    const { env } = await import('../config/env.js');
    
    console.log(`[MeetingFollowup] Found ${match.name} on LinkedIn, generating connection note...`);
    
    // Generate connection note
    const notePrompt = `Meeting: ${meetingContext.title}
Date: ${meetingContext.date.toLocaleDateString()}
Person: ${match.name}
Their headline: ${match.headline || 'N/A'}

Generate a brief, personalized LinkedIn connection note (max 200 chars).`;

    const llm = new ResponsesAPIClient(env.OPENAI_API_KEY, { enableWebSearch: false });
    const noteResult = await generateContent({
      systemPrompt: LINKEDIN_MEETING_NOTE_PROMPT,
      userPrompt: notePrompt,
      maxTokens: 100,
      effort: 'low',
    }, llm);
    
    const connectionNote = noteResult.text?.slice(0, 200) || `Great connecting at ${meetingContext.title}!`;
    
    // Send the connection request
    const { executeLinkedInAction } = await import('../tools/linkedin.js');
    const result = await executeLinkedInAction('send_connection_request', {
      profileId: match.provider_id,
      profileUrl: match.profile_url,
      profileName: match.name,
      note: connectionNote,
    }, connectionNote);
    
    if (result.success) {
      console.log(`[MeetingFollowup] Sent LinkedIn connection request to ${match.name}`);
      return { found: true, alreadyConnected: false, queued: true };
    } else {
      console.log(`[MeetingFollowup] LinkedIn connection request failed: ${result.error}`);
      return { found: true, alreadyConnected: false, queued: false };
    }
  } catch (error) {
    console.error('[MeetingFollowup] LinkedIn lookup failed:', error);
    return { found: false, alreadyConnected: false, queued: false };
  }
}

// =============================================================================
// CALENDAR POLLING
// =============================================================================

/**
 * Get meetings that ended in the last N minutes
 */
export async function getRecentlyEndedMeetings(
  minutesAgo: number = 30
): Promise<EndedMeeting[]> {
  const client = getUnipileClient();
  const emailAccountId = await getActiveEmailAccountId();

  if (!client || !emailAccountId) {
    console.log('[MeetingFollowup] Email/calendar account not configured');
    return [];
  }

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  try {
    const events = await client.getCalendarEvents({
      account_id: emailAccountId,
      start_date: startOfDay.toISOString(),
      end_date: now.toISOString(),
      limit: 50,
    });

    const cutoffTime = new Date(now.getTime() - minutesAgo * 60 * 1000);
    const endedMeetings: EndedMeeting[] = [];

    for (const event of events) {
      const startTime = getEventStartTime(event);
      const endTime = getEventEndTime(event);
      const title = getEventTitle(event);
      
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

    console.log(`[MeetingFollowup] Found ${endedMeetings.length} recently ended meetings with external attendees`);
    return endedMeetings;
  } catch (error) {
    console.error('[MeetingFollowup] Failed to fetch calendar events:', error);
    return [];
  }
}

/**
 * Get ALL meetings from the last N days (for historical backfill)
 */
export async function getHistoricalMeetings(
  daysBack: number = 30
): Promise<EndedMeeting[]> {
  const client = getUnipileClient();
  const emailAccountId = await getActiveEmailAccountId();

  if (!client || !emailAccountId) {
    console.log('[MeetingFollowup] Email/calendar account not configured');
    return [];
  }

  const now = new Date();
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - daysBack);

  console.log(`[MeetingFollowup] Fetching meetings from ${startDate.toDateString()} to ${now.toDateString()}...`);

  try {
    const events = await client.getCalendarEvents({
      account_id: emailAccountId,
      start_date: startDate.toISOString(),
      end_date: now.toISOString(),
      limit: 200, // Get more for historical
    });

    console.log(`[MeetingFollowup] Found ${events.length} total calendar events`);

    const endedMeetings: EndedMeeting[] = [];

    for (const event of events) {
      const startTime = getEventStartTime(event);
      const endTime = getEventEndTime(event);
      const title = getEventTitle(event);
      
      // Skip if we couldn't parse times
      if (!startTime || !endTime) {
        console.log(`[MeetingFollowup] Skipping "${title}" - couldn't parse times`);
        continue;
      }
      
      // Skip if meeting hasn't ended yet
      if (endTime > now) continue;
      
      // Skip if already processed or surfaced
      if (isMeetingSurfaced(event.id) || hasMeetingBeenProcessed(event.id)) {
        console.log(`[MeetingFollowup] Skipping "${title}" - already surfaced or processed`);
        continue;
      }

      // Parse attendees
      const attendees = parseAttendees(event);

      // Skip if no external attendees
      const hasExternalAttendees = attendees.some(a => a.isExternal);
      if (!hasExternalAttendees) {
        console.log(`[MeetingFollowup] Skipping "${title}" - no external attendees`);
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

    console.log(`[MeetingFollowup] Found ${endedMeetings.length} historical meetings with external attendees`);
    return endedMeetings;
  } catch (error) {
    console.error('[MeetingFollowup] Failed to fetch historical events:', error);
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

  return event.attendees.map(attendee => ({
    email: attendee.email,
    name: attendee.name,
    isExternal: !attendee.email.toLowerCase().endsWith(`@${COMPANY_DOMAIN}`),
  }));
}

// =============================================================================
// MEETING NOTES MATCHING
// =============================================================================

/**
 * Find meeting notes that match a specific meeting
 * @param historical - If true, search more broadly (for backfill)
 */
export async function findMatchingMeetingNotes(
  meeting: EndedMeeting,
  historical: boolean = false
): Promise<MeetingNotes | null> {
  const client = getUnipileClient();
  const emailAccountId = await getActiveEmailAccountId();

  if (!client || !emailAccountId) {
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

    const emails = await client.searchEmailsBySender({
      account_id: emailAccountId,
      sender: DAY_AI_SENDER,
      since,
      limit: historical ? 30 : 10, // More results for historical matching
    });

    if (emails.length === 0) {
      console.log(`[MeetingFollowup] No notes found for "${meeting.title}" (${meeting.endTime.toDateString()})`);
      return null;
    }

    // Try to match by content (attendee names, meeting title)
    const matchedEmail = findBestMatch(meeting, emails);
    
    if (!matchedEmail) {
      console.log(`[MeetingFollowup] No matching notes for "${meeting.title}"`);
      return null;
    }

    // Parse the meeting notes
    const parsed = parseMeetingNotesContent(matchedEmail.body || '');

    return {
      id: matchedEmail.id,
      subject: matchedEmail.subject,
      body: matchedEmail.body || '',
      receivedAt: new Date(matchedEmail.date),
      keyPoints: parsed.keyPoints,
      actionItems: parsed.actionItems,
      nextSteps: parsed.nextSteps,
    };
  } catch (error) {
    console.error('[MeetingFollowup] Failed to search meeting notes:', error);
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
    const subjectLower = email.subject.toLowerCase();
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
    for (const email_addr of attendeeEmails) {
      if (bodyLower.includes(email_addr)) {
        score += 3;
      }
    }

    // Time proximity bonus (closer to meeting end = higher score)
    const emailTime = new Date(email.date);
    const timeDiff = emailTime.getTime() - meeting.endTime.getTime();
    if (timeDiff >= 0 && timeDiff < 30 * 60 * 1000) {
      // Within 30 minutes of meeting end
      score += 5 - Math.floor(timeDiff / (6 * 60 * 1000)); // Bonus decreases over time
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = email;
    }
  }

  // Only return if we have a reasonable match
  if (bestScore >= 3) {
    console.log(`[MeetingFollowup] Matched notes with score ${bestScore}: "${bestMatch?.subject}"`);
    return bestMatch;
  }

  return null;
}

/**
 * Parse meeting notes content to extract key points, action items, etc.
 */
function parseMeetingNotesContent(body: string): {
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

// =============================================================================
// FOLLOW-UP DRAFT GENERATION
// =============================================================================

/**
 * Generate a follow-up email draft using Claude Opus 4.5 with HIGH effort
 * 
 * Two-stage approach:
 * 1. OpenAI with web search for company context gathering
 * 2. Claude Opus 4.5 (effort: high) for natural, human writing
 * 
 * Based on Brian LaManna's principles:
 * - First 8 words are everything (preview text on mobile)
 * - Every follow-up must add insight
 * - Personality beats templates
 */
export async function generateFollowUpDraft(
  llm: ResponsesAPIClient,
  meeting: EndedMeeting,
  notes: MeetingNotes,
  emailHistory?: EmailHistoryContext
): Promise<{ to: string[]; subject: string; body: string }> {
  // Get primary recipient (first external attendee)
  const primaryRecipient = meeting.attendees.find(a => a.isExternal);
  if (!primaryRecipient) {
    throw new Error('No external attendees found');
  }

  // Get all external recipients
  const toAddresses = meeting.attendees
    .filter(a => a.isExternal)
    .map(a => a.email);

  // Format FULL email history for context (including bodies)
  let historyContext = '';
  if (emailHistory && emailHistory.recentEmails.length > 0) {
    historyContext = `\n\n=== PRIOR EMAIL HISTORY ===
Use this to understand your existing relationship and communication style with this person.

${emailHistory.recentEmails.slice(0, 8).map(e => 
`--- ${e.date} | ${e.fromMe ? 'YOU SENT' : 'THEY SENT'} ---
Subject: ${e.subject}
${e.body}
`).join('\n')}

Make the follow-up feel like a natural continuation, not a cold outreach.`;
  }

  // Extract company domain from email for web search
  const emailDomain = primaryRecipient.email.split('@')[1];
  const companyName = emailDomain?.replace('.com', '').replace('.co', '').replace('.io', '') || '';

  try {
    // ==========================================================================
    // STAGE 1: Use OpenAI with web search to gather company context
    // ==========================================================================
    let webContext = '';
    
    try {
      console.log(`[MeetingFollowup] Stage 1: Gathering web context for ${companyName || 'prospect'}...`);
      
      const researchPrompt = `Search for recent news about "${companyName}" or "${primaryRecipient.name || ''}" and return a brief summary (2-3 sentences) of anything relevant:
- Recent funding, acquisitions, or expansions
- New product launches or partnerships
- Industry news affecting their business
- Recent press mentions or LinkedIn activity

If no relevant news found, just say "No recent news found."`;

      const researchResponse = await llm.createResponse(researchPrompt, [], {
        reasoningEffort: 'low', // Just gathering facts
        useWebSearch: true,
      });
      
      webContext = researchResponse.outputText || '';
      if (webContext && !webContext.includes('No recent news found')) {
        console.log(`[MeetingFollowup] Found web context: ${webContext.slice(0, 100)}...`);
        webContext = `\n\n=== RECENT NEWS/CONTEXT (from web search) ===\n${webContext}`;
      } else {
        webContext = '';
        console.log(`[MeetingFollowup] No relevant web context found`);
      }
    } catch (error) {
      console.warn('[MeetingFollowup] Web search failed, continuing without:', error);
      webContext = '';
    }

    // ==========================================================================
    // STAGE 2: Use Claude Opus 4.5 (high effort) for writing
    // ==========================================================================
    console.log(`[MeetingFollowup] Stage 2: Generating email with Claude Opus 4.5 (effort: high)...`);
    
    const userPrompt = `Meeting: ${meeting.title}
Date: ${meeting.endTime.toLocaleDateString()}
Time: ${meeting.startTime.toLocaleTimeString()} - ${meeting.endTime.toLocaleTimeString()}
Attendees: ${meeting.attendees.map(a => `${a.name || 'Unknown'} (${a.email})`).join(', ')}
Primary recipient: ${primaryRecipient.name || primaryRecipient.email} (${primaryRecipient.email})
${webContext}

=== PARSED MEETING NOTES ===

Key Points Discussed:
${notes.keyPoints.map(p => `- ${p}`).join('\n') || 'None identified'}

Action Items:
${notes.actionItems.map(a => `- ${a}`).join('\n') || 'None identified'}

Next Steps:
${notes.nextSteps.map(n => `- ${n}`).join('\n') || 'None identified'}

=== FULL MEETING NOTES (from Day.ai) ===
${notes.body}
${historyContext}

=== YOUR TASK ===
1. Extract the ONE most specific callback from the meeting notes (a number, name, phrase, or specific pain point they mentioned).
2. Write the follow-up email with that callback as the opener.
3. If web context is relevant, weave it in naturally.

Remember Brian LaManna's rule: "The first 8 words are everything." The preview text must be specific to THIS conversation.

Return JSON with "subject" and "body" fields.`;

    const result = await generateContent({
      systemPrompt: MEETING_FOLLOWUP_PROMPT,
      userPrompt,
      maxTokens: 2048,
      effort: 'high', // Use high effort for important emails
    }, llm);
    
    console.log(`[MeetingFollowup] Email generated by ${result.provider} (${result.model})`);
    
    const text = result.text || '';
    
    // Try to parse JSON response for subject + body
    // First, strip markdown code fences if present
    let cleanText = text;
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      cleanText = codeBlockMatch[1].trim();
    }
    
    // Now try to extract JSON object
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.subject && parsed.body) {
          console.log(`[MeetingFollowup] Generated email with custom subject: "${parsed.subject}"`);
          return {
            to: toAddresses,
            subject: parsed.subject,
            body: parsed.body,
          };
        }
      } catch (e) {
        // JSON parse failed, fall through to use raw text
        console.warn('[MeetingFollowup] JSON parse failed:', e);
      }
    }
    
    // Fallback: use response as body, generate descriptive subject
    console.log('[MeetingFollowup] Using raw text as body (JSON parse failed)');
    return {
      to: toAddresses,
      subject: `Following up: ${meeting.title}`,
      body: text,
    };
  } catch (error) {
    console.error('[MeetingFollowup] Failed to generate draft:', error);
    // Return a basic template
    return {
      to: toAddresses,
      subject: `Following up: ${meeting.title}`,
      body: `Hi ${primaryRecipient.name?.split(' ')[0] || 'there'},

Great speaking with you today. Here are the key points from our discussion:

${notes.keyPoints.map(p => `• ${p}`).join('\n')}

${notes.actionItems.length > 0 ? `Action items:\n${notes.actionItems.map(a => `• ${a}`).join('\n')}\n` : ''}
Let me know if you have any questions.

Best,
Ola`,
    };
  }
}

// =============================================================================
// AGENT-DRIVEN FOLLOW-UP GENERATION
// =============================================================================

import { ResponsesRouter } from '../agent/responses-router.js';

/**
 * Generate a follow-up email using an agent that reasons and searches for context.
 * 
 * Instead of hardcoding what context to gather, the agent:
 * 1. Reads the meeting notes
 * 2. Decides what additional context it needs
 * 3. Uses tools to search inbox, check DocuSign, web search, etc.
 * 4. Generates the follow-up based on all gathered context
 */
export async function generateFollowUpWithAgent(
  llm: ResponsesAPIClient,
  meeting: EndedMeeting,
  notes: MeetingNotes
): Promise<{ to: string[]; subject: string; body: string; contextGathered?: string }> {
  // Get primary recipient
  const primaryRecipient = meeting.attendees.find(a => a.isExternal);
  if (!primaryRecipient) {
    throw new Error('No external attendees found');
  }

  // Get all external recipients
  const toAddresses = meeting.attendees
    .filter(a => a.isExternal)
    .map(a => a.email);

  console.log(`[MeetingFollowup] Using agent-driven approach for "${meeting.title}"`);
  console.log(`[MeetingFollowup] Primary recipient: ${primaryRecipient.name} (${primaryRecipient.email})`);

  // Create the router with tools
  const router = new ResponsesRouter(llm);

  // Build the message for the agent
  const agentMessage = `I just had a meeting that I need to follow up on. Please help me draft a follow-up email.

MEETING DETAILS:
- Title: ${meeting.title}
- Date: ${meeting.endTime.toLocaleDateString()}
- Time: ${meeting.startTime.toLocaleTimeString()} - ${meeting.endTime.toLocaleTimeString()}
- Primary recipient: ${primaryRecipient.name || 'Unknown'} (${primaryRecipient.email})
- All attendees: ${meeting.attendees.map(a => `${a.name || 'Unknown'} (${a.email})`).join(', ')}

MEETING NOTES FROM DAY.AI:
${notes.body}

KEY POINTS EXTRACTED:
${notes.keyPoints.map(p => `- ${p}`).join('\n') || 'None identified'}

ACTION ITEMS:
${notes.actionItems.map(a => `- ${a}`).join('\n') || 'None identified'}

NEXT STEPS:
${notes.nextSteps.map(n => `- ${n}`).join('\n') || 'None identified'}

---

Please:
1. Search for any DocuSign/NDA emails related to this contact (search inbox for "docusign" and their name/company)
2. Check our email history with ${primaryRecipient.email} to see what we've already sent
3. Do a web search for any recent news about their company
4. Based on ALL the context, draft a follow-up email

Remember: Use GIVE/GET framework. Be a confident founder. Keep it to 3-4 sentences.`;

  try {
    // Process with agent (this will use tools to gather context)
    const result = await router.process(agentMessage, {
      threadTs: `meeting_${meeting.id}`,
      channelId: 'agent',
      userId: 'system',
    });

    console.log(`[MeetingFollowup] Agent used tools: ${result.toolsCalled.join(', ') || 'none'}`);
    console.log(`[MeetingFollowup] Web search used: ${result.webSearchUsed}`);

    // Parse the agent's response to extract the email
    const response = result.response;
    
    // Try to extract JSON email from response
    const jsonMatch = response.match(/\{[\s\S]*?"subject"[\s\S]*?"body"[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.subject && parsed.body) {
          // Extract context gathered section if present
          const contextMatch = response.match(/CONTEXT GATHERED:[\s\S]*?(?=FOLLOW-UP EMAIL:|$)/i);
          
          return {
            to: parsed.to || toAddresses,
            subject: parsed.subject,
            body: parsed.body,
            contextGathered: contextMatch ? contextMatch[0].trim() : undefined,
          };
        }
      } catch (parseError) {
        console.warn('[MeetingFollowup] Failed to parse agent JSON response:', parseError);
      }
    }

    // If no valid JSON, try to extract subject and body from text
    const subjectMatch = response.match(/subject[:\s]*["']?([^"'\n]+)["']?/i);
    const bodyMatch = response.match(/body[:\s]*["']?([\s\S]+?)["']?\s*(?:$|\})/i);

    if (subjectMatch && bodyMatch) {
      return {
        to: toAddresses,
        subject: subjectMatch[1].trim(),
        body: bodyMatch[1].trim(),
        contextGathered: result.response.includes('CONTEXT GATHERED') 
          ? result.response.split('CONTEXT GATHERED')[1].split('FOLLOW-UP EMAIL')[0].trim()
          : undefined,
      };
    }

    // Fallback: use the whole response as the body
    console.log('[MeetingFollowup] Agent response did not contain structured email, using fallback');
    return {
      to: toAddresses,
      subject: `Underflow - ${meeting.title}`,
      body: response,
    };

  } catch (error) {
    console.error('[MeetingFollowup] Agent-driven generation failed:', error);
    // Fall back to the original method
    console.log('[MeetingFollowup] Falling back to direct generation');
    return generateFollowUpDraft(llm, meeting, notes);
  }
}

// =============================================================================
// SLACK SURFACING
// =============================================================================

/**
 * Surface a meeting follow-up in Slack for approval
 * Now includes AI classification to filter non-business meetings
 */
export async function surfaceMeetingFollowUp(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  meeting: EndedMeeting,
  notes: MeetingNotes,
  config: DiscoveryConfig
): Promise<void> {
  const primaryRecipient = meeting.attendees.find(a => a.isExternal);
  if (!primaryRecipient) {
    console.log(`[MeetingFollowup] No external attendees for "${meeting.title}"`);
    return;
  }

  // STEP 1: Classify the meeting to determine if it's worth following up
  const classification = await classifyMeeting(llm, meeting);
  
  if (classification.classification === 'skip') {
    console.log(`[MeetingFollowup] Skipping "${meeting.title}" - ${classification.reason}`);
    return; // Silent skip for non-business meetings
  }
  
  console.log(`[MeetingFollowup] "${meeting.title}" classified as ${classification.classification} (${classification.priority} priority)`);

  // STEP 2: Check if we've already emailed this person recently (after the meeting)
  const priorEmail = await hasRecentlyEmailedRecipient(primaryRecipient.email, meeting.endTime);
  if (priorEmail.hasEmailed) {
    console.log(`[MeetingFollowup] Skipping "${meeting.title}" - already emailed ${primaryRecipient.email} on ${priorEmail.lastEmailDate}`);
    // Notify Slack that we skipped due to existing recent email
    await slackClient.chat.postMessage({
      channel: config.slack.channelId,
      text: `Skipped follow-up for ${meeting.title}`,
      blocks: [{
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_Skipped follow-up for "${meeting.title}" - already emailed ${primaryRecipient.name || primaryRecipient.email} on ${new Date(priorEmail.lastEmailDate!).toLocaleDateString()}: "${priorEmail.lastSubject}"_`,
        }],
      }],
    });
    return;
  }

  // Generate the follow-up draft using agent-driven approach
  // The agent will search for context (DocuSign, email history, web) on its own
  console.log(`[MeetingFollowup] Generating draft with agent-driven approach...`);
  const draft = await generateFollowUpWithAgent(llm, meeting, notes);
  
  if (draft.contextGathered) {
    console.log(`[MeetingFollowup] Agent gathered context:\n${draft.contextGathered.slice(0, 200)}...`);
  }

  // Queue LinkedIn connections for external attendees
  for (const attendee of meeting.attendees.filter(a => a.isExternal)) {
    const linkedInResult = await queueLinkedInConnectionForAttendee(attendee, {
      title: meeting.title,
      date: meeting.endTime,
    });
    if (linkedInResult.found && !linkedInResult.alreadyConnected) {
      console.log(`[MeetingFollowup] Queued LinkedIn connection for ${attendee.name || attendee.email}`);
    }
  }

  // Build the Slack message
  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Meeting Follow-up: ${meeting.title}*\n${primaryRecipient?.name || primaryRecipient?.email || 'Unknown'} ${primaryRecipient?.email ? `(${primaryRecipient.email})` : ''}`,
      },
    },
  ];

  // Key points summary
  if (notes.keyPoints.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Key Points:*\n${notes.keyPoints.slice(0, 3).map(p => `• ${p}`).join('\n')}`,
      },
    });
  }

  // Action items
  if (notes.actionItems.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Action Items:*\n${notes.actionItems.slice(0, 3).map(a => `• ${a}`).join('\n')}`,
      },
    });
  }

  // Draft email preview
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Draft Email:*\n>${draft.body.split('\n').slice(0, 5).join('\n>')}${draft.body.split('\n').length > 5 ? '\n>...' : ''}`,
    },
  });

  // Action buttons
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Create Draft' },
        style: 'primary',
        action_id: 'meeting_followup_send',
        value: JSON.stringify({
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          notesId: notes.id,
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          recipientName: primaryRecipient?.name,
          recipientEmail: primaryRecipient?.email,
        }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Edit' },
        action_id: 'meeting_followup_edit',
        value: JSON.stringify({
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          notesId: notes.id,
          to: draft.to,
          subject: draft.subject,
          body: draft.body,
          recipientName: primaryRecipient?.name,
          recipientEmail: primaryRecipient?.email,
        }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Skip' },
        action_id: 'meeting_followup_skip',
        value: meeting.id,
      },
    ],
  });

  await slackClient.chat.postMessage({
    channel: config.slack.channelId,
    text: `Meeting follow-up ready: ${meeting.title}`,
    blocks,
  });

  // Mark as surfaced in database (persists across restarts)
  markMeetingSurfaced({
    meetingId: meeting.id,
    recipientEmail: primaryRecipient.email,
    recipientName: primaryRecipient.name,
    meetingTitle: meeting.title,
    draftSubject: draft.subject,
    draftBody: draft.body,
  });

  console.log(`[MeetingFollowup] Surfaced follow-up for "${meeting.title}"`);
}

// =============================================================================
// MAIN DISCOVERY FUNCTION
// =============================================================================

/**
 * Run meeting follow-up discovery
 * Called periodically (every 15 min) by the scheduler
 */
export async function discoverMeetingFollowUps(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  config: DiscoveryConfig
): Promise<void> {
  console.log('[MeetingFollowup] Checking for meetings to follow up...');

  // Get recently ended meetings
  const meetings = await getRecentlyEndedMeetings(30);

  for (const meeting of meetings) {
    // Try to find matching meeting notes
    const notes = await findMatchingMeetingNotes(meeting);

    if (notes) {
      // Surface in Slack for approval
      await surfaceMeetingFollowUp(slackClient, llm, meeting, notes, config);
    } else {
      console.log(`[MeetingFollowup] No notes found yet for "${meeting.title}", will retry later`);
    }
  }
}

/**
 * Run historical backfill - checks ALL meetings from the last N days
 * Use this for initial setup or to catch up on missed meetings
 */
export async function runHistoricalBackfill(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  config: DiscoveryConfig,
  daysBack: number = 30
): Promise<{ processed: number; surfaced: number; skipped: number }> {
  console.log(`[MeetingFollowup] Running historical backfill for last ${daysBack} days...`);

  const meetings = await getHistoricalMeetings(daysBack);
  
  let processed = 0;
  let surfaced = 0;
  let skipped = 0;

  for (const meeting of meetings) {
    processed++;
    
    // Try to find matching meeting notes (historical mode = broader search)
    const notes = await findMatchingMeetingNotes(meeting, true);

    if (notes) {
      // Check if we've already followed up with this person AFTER the meeting ended
      const externalAttendees = meeting.attendees.filter(a => a.isExternal);
      const primaryRecipient = externalAttendees[0];
      
      if (primaryRecipient) {
        // Only count emails sent AFTER this meeting ended as follow-ups
        const { hasEmailed, lastSubject } = await hasRecentlyEmailedRecipient(
          primaryRecipient.email,
          meeting.endTime // Only look for emails after this meeting
        );
        
        if (hasEmailed) {
          console.log(`[MeetingFollowup] Skipping "${meeting.title}" - already followed up with ${primaryRecipient.email} ("${lastSubject}")`);
          skipped++;
          // Mark as sent so we don't check again (already followed up manually)
          markMeetingSurfaced({
            meetingId: meeting.id,
            recipientEmail: primaryRecipient.email,
            recipientName: primaryRecipient.name,
            meetingTitle: meeting.title,
          });
          // Then mark as sent since follow-up already happened
          const { markMeetingSent } = await import('../db/sales-leads.js');
          markMeetingSent(meeting.id);
          continue;
        }
      }

      // Surface in Slack for approval
      await surfaceMeetingFollowUp(slackClient, llm, meeting, notes, config);
      surfaced++;
      
      // Add a small delay between surfacing to avoid Slack rate limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      console.log(`[MeetingFollowup] No notes found for "${meeting.title}" (${meeting.endTime.toDateString()})`);
      skipped++;
    }
  }

  console.log(`[MeetingFollowup] Backfill complete: ${processed} processed, ${surfaced} surfaced, ${skipped} skipped`);
  return { processed, surfaced, skipped };
}

// =============================================================================
// LEAD CREATION (called when user sends follow-up)
// =============================================================================

/**
 * Create a sales lead from a meeting follow-up
 */
export function createLeadFromMeeting(
  meeting: EndedMeeting,
  notes: MeetingNotes,
  recipientEmail: string,
  recipientName?: string
): CreateLeadParams {
  // Try to extract company from email domain
  const emailParts = recipientEmail.split('@');
  const domain = emailParts[1] || '';
  const company = domain.split('.')[0]; // Basic company extraction

  return {
    email: recipientEmail,
    name: recipientName,
    company: company !== 'gmail' && company !== 'yahoo' && company !== 'hotmail' 
      ? company.charAt(0).toUpperCase() + company.slice(1) 
      : undefined,
    meeting_id: meeting.id,
    meeting_date: meeting.endTime.toISOString(),
    meeting_title: meeting.title,
    meeting_notes_id: notes.id,
    meeting_notes_summary: [
      ...notes.keyPoints.slice(0, 2),
      ...notes.actionItems.slice(0, 2),
    ].join('; '),
  };
}

