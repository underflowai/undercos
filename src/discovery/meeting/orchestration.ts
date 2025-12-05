/**
 * Meeting Follow-up Orchestration
 * 
 * Contains AI-driven functions that coordinate between modules:
 * - Meeting classification
 * - LinkedIn connection queueing
 * - Draft generation (two approaches)
 * - Slack surfacing
 * - Main discovery loop
 */

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/bolt';
import type { ResponsesAPIClient } from '../../llm/responses.js';
import { ResponsesRouter } from '../../agent/responses-router.js';
import {
  createLead,
  markMeetingSurfaced,
  type CreateLeadParams,
} from '../../db/sales-leads.js';
import {
  MEETING_FOLLOWUP_PROMPT,
  MEETING_CLASSIFICATION_PROMPT,
  AGENT_FOLLOWUP_PROMPT,
} from '../../prompts/index.js';
import { getContentGenerationConfig } from '../../config/models.js';
import { generateContent } from '../../llm/content-generator.js';
import type { DiscoveryConfig } from '../config.js';

import type {
  EndedMeeting,
  MeetingAttendee,
  MeetingNotes,
  MeetingClassification,
  EmailHistoryContext,
} from './types.js';
import { hasRecentlyEmailedRecipient, getEmailHistoryContext } from './email-history.js';
import { getRecentlyEndedMeetings, getHistoricalMeetings } from './calendar-polling.js';
import { findMatchingMeetingNotes } from './notes-matching.js';

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
      console.log(`[Classification] "${meeting.title}" -> ${parsed.classification}: ${parsed.reason}`);
      return {
        classification: parsed.classification || 'skip',
        reason: parsed.reason || 'Unknown',
        priority: parsed.priority === 'high' ? 'high' : parsed.priority === 'medium' ? 'medium' : 'low',
      };
    }
    
    console.log(`[Classification] Could not classify "${meeting.title}", defaulting to skip`);
    return { classification: 'skip', reason: 'Could not classify', priority: 'low' };
  } catch (error) {
    console.error('[Classification] Failed:', error);
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
  const { isUnipileConfigured, searchLinkedIn, getActiveLinkedinAccountId } = await import('../../tools/unipile-sdk.js');
  const accountId = await getActiveLinkedinAccountId();

  if (!isUnipileConfigured() || !accountId) {
    return { found: false, alreadyConnected: false, queued: false };
  }

  try {
    const searchName = attendee.name || attendee.email.split('@')[0];
    const searchResults = await searchLinkedIn({
      category: 'people',
      keywords: searchName,
      limit: 5,
    });

    if (searchResults.items.length === 0) {
      console.log(`[LinkedIn] No profile found for ${searchName}`);
      return { found: false, alreadyConnected: false, queued: false };
    }

    const emailDomain = attendee.email.split('@')[1]?.replace('www.', '');
    const match = searchResults.items.find((p: any) => {
      const nameMatch = p.name?.toLowerCase().includes(searchName.toLowerCase());
      const companyMatch = emailDomain && p.company?.toLowerCase().includes(emailDomain.split('.')[0]);
      return nameMatch || companyMatch;
    }) || searchResults.items[0];

    if ((match as any).is_connection) {
      console.log(`[LinkedIn] Already connected with ${(match as any).name}`);
      return { found: true, alreadyConnected: true, queued: false };
    }

    const { LINKEDIN_MEETING_NOTE_PROMPT } = await import('../../prompts/index.js');
    const { ResponsesAPIClient } = await import('../../llm/responses.js');
    const { env } = await import('../../config/env.js');
    
    const notePrompt = `Meeting: ${meetingContext.title}
Date: ${meetingContext.date.toLocaleDateString()}
Person: ${(match as any).name}
Their headline: ${(match as any).headline || 'N/A'}

Generate a brief, personalized LinkedIn connection note (max 200 chars).`;

    const llm = new ResponsesAPIClient(env.OPENAI_API_KEY, { enableWebSearch: false });
    const noteResult = await generateContent({
      systemPrompt: LINKEDIN_MEETING_NOTE_PROMPT,
      userPrompt: notePrompt,
      maxTokens: 100,
      effort: 'low',
    }, llm);
    
    const connectionNote = noteResult.text?.slice(0, 200) || `Great connecting at ${meetingContext.title}!`;
    
    const { executeLinkedInAction } = await import('../../tools/linkedin.js');
    const result = await executeLinkedInAction('send_connection_request', {
      profileId: (match as any).provider_id,
      profileUrl: (match as any).profile_url,
      profileName: (match as any).name,
      note: connectionNote,
    }, connectionNote);
    
    if (result.success) {
      console.log(`[LinkedIn] Sent connection request to ${(match as any).name}`);
      return { found: true, alreadyConnected: false, queued: true };
    } else {
      console.log(`[LinkedIn] Connection request failed: ${result.error}`);
      return { found: true, alreadyConnected: false, queued: false };
    }
  } catch (error) {
    console.error('[LinkedIn] Lookup failed:', error);
    return { found: false, alreadyConnected: false, queued: false };
  }
}

// =============================================================================
// FOLLOW-UP DRAFT GENERATION
// =============================================================================

/**
 * Generate a follow-up email draft using Claude Opus 4.5 with HIGH effort
 */
export async function generateFollowUpDraft(
  llm: ResponsesAPIClient,
  meeting: EndedMeeting,
  notes: MeetingNotes,
  emailHistory?: EmailHistoryContext
): Promise<{ to: string[]; subject: string; body: string }> {
  const primaryRecipient = meeting.attendees.find(a => a.isExternal);
  if (!primaryRecipient) {
    throw new Error('No external attendees found');
  }

  const toAddresses = meeting.attendees
    .filter(a => a.isExternal)
    .map(a => a.email);

  let historyContext = '';
  if (emailHistory && emailHistory.recentEmails.length > 0) {
    historyContext = `\n\n=== PRIOR EMAIL HISTORY ===
${emailHistory.recentEmails.slice(0, 8).map(e => 
`--- ${e.date} | ${e.fromMe ? 'YOU SENT' : 'THEY SENT'} ---
Subject: ${e.subject}
${e.body}
`).join('\n')}`;
  }

  const emailDomain = primaryRecipient.email.split('@')[1];
  const companyName = emailDomain?.replace('.com', '').replace('.co', '').replace('.io', '') || '';

  try {
    // Stage 1: Web search for context
    let webContext = '';
    try {
      console.log(`[DraftGen] Stage 1: Gathering web context for ${companyName || 'prospect'}...`);
      
      const researchPrompt = `Search for recent news about "${companyName}" or "${primaryRecipient.name || ''}" and return a brief summary.`;
      const researchResponse = await llm.createResponse(researchPrompt, [], {
        reasoningEffort: 'low',
        useWebSearch: true,
      });
      
      webContext = researchResponse.outputText || '';
      if (webContext && !webContext.includes('No recent news found')) {
        webContext = `\n\n=== RECENT NEWS ===\n${webContext}`;
      } else {
        webContext = '';
      }
    } catch {
      webContext = '';
    }

    // Stage 2: Generate email with Claude
    console.log(`[DraftGen] Stage 2: Generating email...`);
    
    const userPrompt = `Meeting: ${meeting.title}
Date: ${meeting.endTime.toLocaleDateString()}
Attendees: ${meeting.attendees.map(a => `${a.name || 'Unknown'} (${a.email})`).join(', ')}
Primary recipient: ${primaryRecipient.name || primaryRecipient.email}
${webContext}

=== MEETING NOTES ===
Key Points: ${notes.keyPoints.map(p => `- ${p}`).join('\n') || 'None'}
Action Items: ${notes.actionItems.map(a => `- ${a}`).join('\n') || 'None'}
Next Steps: ${notes.nextSteps.map(n => `- ${n}`).join('\n') || 'None'}

=== FULL NOTES ===
${notes.body}
${historyContext}

Return JSON with "subject" and "body" fields.`;

    const result = await generateContent({
      systemPrompt: MEETING_FOLLOWUP_PROMPT,
      userPrompt,
      maxTokens: 2048,
      effort: 'high',
    }, llm);
    
    const text = result.text || '';
    
    // Parse JSON response
    let cleanText = text;
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      cleanText = codeBlockMatch[1].trim();
    }
    
    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.subject && parsed.body) {
          return { to: toAddresses, subject: parsed.subject, body: parsed.body };
        }
      } catch {
        // Fall through
      }
    }
    
    return {
      to: toAddresses,
      subject: `Following up: ${meeting.title}`,
      body: text,
    };
  } catch (error) {
    console.error('[DraftGen] Failed:', error);
    return {
      to: toAddresses,
      subject: `Following up: ${meeting.title}`,
      body: `Hi ${primaryRecipient.name?.split(' ')[0] || 'there'},

Great speaking with you today. Here are the key points:

${notes.keyPoints.map(p => `• ${p}`).join('\n')}

Let me know if you have any questions.

Best,
Ola`,
    };
  }
}

/**
 * Generate a follow-up email using an agent that reasons and searches for context
 */
export async function generateFollowUpWithAgent(
  llm: ResponsesAPIClient,
  meeting: EndedMeeting,
  notes: MeetingNotes
): Promise<{ to: string[]; subject: string; body: string; contextGathered?: string }> {
  const primaryRecipient = meeting.attendees.find(a => a.isExternal);
  if (!primaryRecipient) {
    throw new Error('No external attendees found');
  }

  const toAddresses = meeting.attendees
    .filter(a => a.isExternal)
    .map(a => a.email);

  console.log(`[AgentGen] Using agent for "${meeting.title}"`);

  const router = new ResponsesRouter(llm);

  const agentMessage = `I just had a meeting that I need to follow up on.

MEETING DETAILS:
- Title: ${meeting.title}
- Date: ${meeting.endTime.toLocaleDateString()}
- Primary recipient: ${primaryRecipient.name || 'Unknown'} (${primaryRecipient.email})

MEETING NOTES:
${notes.body}

KEY POINTS: ${notes.keyPoints.join(', ') || 'None'}
ACTION ITEMS: ${notes.actionItems.join(', ') || 'None'}

Please search for context and draft a follow-up email.`;

  try {
    const result = await router.process(agentMessage, {
      threadTs: `meeting_${meeting.id}`,
      channelId: 'agent',
      userId: 'system',
    });

    const cleanText = (text: string) => text.replace(/—/g, '-').replace(/–/g, '-').trim();
    const response = result.response.trim();

    // Try to parse JSON response
    const tryParse = (text: string) => { try { return JSON.parse(text); } catch { return null; } };
    
    let parsed = tryParse(response);
    if (!parsed) {
      const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) parsed = tryParse(codeBlockMatch[1]);
    }

    if (parsed?.email?.subject && parsed?.email?.body) {
      return {
        to: parsed.email.to || toAddresses,
        subject: cleanText(parsed.email.subject),
        body: cleanText(parsed.email.body),
        contextGathered: parsed.context ? cleanText(parsed.context) : undefined,
      };
    }

    return {
      to: toAddresses,
      subject: `Underflow - ${meeting.title}`,
      body: cleanText(response),
    };
  } catch (error) {
    console.error('[AgentGen] Failed, falling back:', error);
    return generateFollowUpDraft(llm, meeting, notes);
  }
}

// =============================================================================
// SLACK SURFACING
// =============================================================================

/**
 * Surface a meeting follow-up in Slack for approval
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
    console.log(`[Surfacing] No external attendees for "${meeting.title}"`);
    return;
  }

  // Classify the meeting
  const classification = await classifyMeeting(llm, meeting);
  
  if (classification.classification !== 'sales') {
    console.log(`[Surfacing] Skipping "${meeting.title}": ${classification.reason}`);
    markMeetingSurfaced({
      meetingId: meeting.id,
      recipientEmail: primaryRecipient.email,
      recipientName: primaryRecipient.name,
      meetingTitle: meeting.title,
    });
    const { markMeetingSkipped } = await import('../../db/sales-leads.js');
    markMeetingSkipped(meeting.id);
    console.log(`[Surfacing] Skipped reason: ${classification.reason}`);
    return;
  }

  // Check for prior emails
  const { hasEmailed, lastEmailDate } = await hasRecentlyEmailedRecipient(
    primaryRecipient.email,
    meeting.endTime
  );

  if (hasEmailed) {
    console.log(`[Surfacing] Skipping "${meeting.title}" - already followed up on ${lastEmailDate}`);
    return;
  }

  // Get email history for context
  const emailHistory = await getEmailHistoryContext(primaryRecipient.email);

  // Generate draft (use agent approach by default for richer context gathering)
  console.log(`[Surfacing] Generating draft for "${meeting.title}"...`);
  const draft = await generateFollowUpDraft(llm, meeting, notes, emailHistory);

  // Mark as surfaced
  markMeetingSurfaced({
    meetingId: meeting.id,
    recipientEmail: primaryRecipient.email,
    recipientName: primaryRecipient.name,
    meetingTitle: meeting.title,
    draftSubject: draft.subject,
    draftBody: draft.body,
  });

  // Build Slack blocks
  const blocks: KnownBlock[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `Meeting Follow-up: ${meeting.title}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*To:* ${primaryRecipient.email}\n*Priority:* ${classification.priority}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Subject:* ${draft.subject}\n\n${draft.body.slice(0, 2000)}`,
      },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Create Draft', emoji: true },
          style: 'primary',
          action_id: 'meeting_followup_send',
          value: JSON.stringify({
            meetingId: meeting.id,
            to: draft.to,
            subject: draft.subject,
            body: draft.body,
            recipientName: primaryRecipient.name,
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Edit', emoji: true },
          action_id: 'meeting_followup_edit',
          value: JSON.stringify({
            meetingId: meeting.id,
            to: draft.to,
            subject: draft.subject,
            body: draft.body,
          }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Skip', emoji: true },
          action_id: 'meeting_followup_skip',
          value: meeting.id,
        },
      ],
    },
  ];

  await slackClient.chat.postMessage({
    channel: config.slack.channelId,
    text: `Meeting follow-up ready: ${meeting.title}`,
    blocks,
  });

  console.log(`[Surfacing] Posted follow-up for "${meeting.title}" to Slack`);
}

// =============================================================================
// MAIN DISCOVERY FUNCTION
// =============================================================================

/**
 * Run meeting follow-up discovery (called every 15 min)
 */
export async function discoverMeetingFollowUps(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  config: DiscoveryConfig
): Promise<void> {
  console.log('[Discovery] Checking for meetings to follow up...');

  const meetings = await getRecentlyEndedMeetings(30);

  for (const meeting of meetings) {
    const notes = await findMatchingMeetingNotes(meeting);

    if (notes) {
      await surfaceMeetingFollowUp(slackClient, llm, meeting, notes, config);
    } else {
      console.log(`[Discovery] No notes yet for "${meeting.title}", will retry later`);
    }
  }
}

/**
 * Run historical backfill for last N days
 */
export async function runHistoricalBackfill(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  config: DiscoveryConfig,
  daysBack: number = 30
): Promise<{ processed: number; surfaced: number; skipped: number }> {
  console.log(`[Backfill] Processing last ${daysBack} days...`);

  const meetings = await getHistoricalMeetings(daysBack);
  
  let processed = 0;
  let surfaced = 0;
  let skipped = 0;

  for (const meeting of meetings) {
    processed++;
    
    const notes = await findMatchingMeetingNotes(meeting, true);

    if (notes) {
      const primaryRecipient = meeting.attendees.find(a => a.isExternal);
      
      if (primaryRecipient) {
        const { hasEmailed, lastSubject } = await hasRecentlyEmailedRecipient(
          primaryRecipient.email,
          meeting.endTime
        );
        
        if (hasEmailed) {
          console.log(`[Backfill] Skipping "${meeting.title}" - already followed up ("${lastSubject}")`);
          skipped++;
          markMeetingSurfaced({
            meetingId: meeting.id,
            recipientEmail: primaryRecipient.email,
            recipientName: primaryRecipient.name,
            meetingTitle: meeting.title,
          });
          const { markMeetingSent } = await import('../../db/sales-leads.js');
          markMeetingSent(meeting.id);
          continue;
        }
      }

      await surfaceMeetingFollowUp(slackClient, llm, meeting, notes, config);
      surfaced++;
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else {
      console.log(`[Backfill] No notes for "${meeting.title}"`);
      skipped++;
    }
  }

  console.log(`[Backfill] Complete: ${processed} processed, ${surfaced} surfaced, ${skipped} skipped`);
  return { processed, surfaced, skipped };
}

// =============================================================================
// LEAD CREATION
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
  const emailParts = recipientEmail.split('@');
  const domain = emailParts[1] || '';
  const company = domain.split('.')[0];

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

