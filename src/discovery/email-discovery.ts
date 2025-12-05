/**
 * Email Discovery - Check for meeting notes and generate follow-ups
 */

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/bolt';
import type { ResponsesAPIClient } from '../llm/responses.js';
import { 
  isUnipileConfigured,
  getActiveEmailAccountId,
  getEmails,
} from '../tools/unipile-sdk.js';
import type { DiscoveryConfig } from './config.js';
import { FOLLOW_UP_EMAIL_PROMPT } from '../prompts/index.js';

// Track seen meeting notes to avoid duplicates
const seenMeetingNotes = new Set<string>();

export interface MeetingNoteEmail {
  id: string;
  subject: string;
  from: { name?: string; email: string };
  date: string;
  body: string;
}

export interface ParsedMeetingNotes {
  keyPoints: string[];
  actionItems: string[];
  followUps: string[];
}

/**
 * Parse meeting notes from email body
 */
export function parseMeetingNotes(emailBody: string): ParsedMeetingNotes {
  const keyPoints: string[] = [];
  const actionItems: string[] = [];
  const followUps: string[] = [];

  const lines = emailBody.split('\n');
  let currentSection: 'none' | 'keyPoints' | 'actionItems' | 'followUps' = 'none';

  for (const line of lines) {
    const trimmedLine = line.trim().toLowerCase();
    
    if (trimmedLine.includes('key point') || trimmedLine.includes('summary') || trimmedLine.includes('discussion')) {
      currentSection = 'keyPoints';
      continue;
    }
    if (trimmedLine.includes('action item') || trimmedLine.includes('task') || trimmedLine.includes('to do')) {
      currentSection = 'actionItems';
      continue;
    }
    if (trimmedLine.includes('follow-up') || trimmedLine.includes('follow up') || trimmedLine.includes('next step')) {
      currentSection = 'followUps';
      continue;
    }

    const item = line.trim();
    if (item.startsWith('- ') || item.startsWith('* ') || item.startsWith('• ')) {
      const content = item.substring(2).trim();
      if (content) {
        if (currentSection === 'keyPoints') keyPoints.push(content);
        if (currentSection === 'actionItems') actionItems.push(content);
        if (currentSection === 'followUps') followUps.push(content);
      }
    } else if (currentSection !== 'none' && item && !item.endsWith(':')) {
      if (currentSection === 'keyPoints') keyPoints.push(item);
      if (currentSection === 'actionItems') actionItems.push(item);
      if (currentSection === 'followUps') followUps.push(item);
    }
  }

  return { keyPoints, actionItems, followUps };
}

/**
 * Generate a follow-up email using AI
 */
export async function generateFollowUpEmail(
  llm: ResponsesAPIClient,
  email: MeetingNoteEmail,
  parsedNotes: ParsedMeetingNotes
): Promise<string> {
  try {
    const input = [
      { type: 'message' as const, role: 'system' as const, content: FOLLOW_UP_EMAIL_PROMPT },
      {
        type: 'message' as const,
        role: 'user' as const,
        content: `Meeting with: ${email.from.name || email.from.email}
Subject: ${email.subject}
Date: ${email.date}

Key Points:
${parsedNotes.keyPoints.map(p => `- ${p}`).join('\n') || 'None identified'}

Action Items:
${parsedNotes.actionItems.map(a => `- ${a}`).join('\n') || 'None identified'}

Follow-ups:
${parsedNotes.followUps.map(f => `- ${f}`).join('\n') || 'None identified'}

Original notes excerpt:
${email.body.slice(0, 500)}`,
      },
    ];

    const response = await llm.createResponse(input, []);
    return response.outputText || '';
  } catch (error) {
    console.error('[EmailDiscovery] Failed to generate follow-up:', error);
    return '';
  }
}

/**
 * Check for new meeting notes
 */
export async function checkMeetingNotes(
  llm: ResponsesAPIClient,
  config: DiscoveryConfig
): Promise<MeetingNoteEmail[]> {
  if (!isUnipileConfigured()) {
    console.log('[EmailDiscovery] Email account not configured - skipping');
    return [];
  }

  console.log('[EmailDiscovery] Checking for new meeting notes...');

  try {
    // Look for emails in a "Meeting Notes" folder
    const emails = await getEmails({
      folder: 'Meeting Notes',
      limit: 10,
    }) as Array<{
      id: string;
      subject?: string;
      from: { name?: string; email: string };
      date?: string;
      body?: string;
    }>;

    // Filter out already processed
    const newEmails = emails.filter((e: any) => !seenMeetingNotes.has(e.id));

    console.log(`[EmailDiscovery] Found ${newEmails.length} new meeting notes`);

    return newEmails.map((e: any) => ({
      id: e.id,
      subject: e.subject || '',
      from: e.from,
      date: e.date || '',
      body: e.body || '',
    }));
  } catch (error) {
    console.error('[EmailDiscovery] Failed to fetch emails:', error);
    return [];
  }
}

/**
 * Surface a meeting note in Slack
 */
export async function surfaceMeetingNote(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  email: MeetingNoteEmail,
  config: DiscoveryConfig
): Promise<void> {
  // Mark as seen
  seenMeetingNotes.add(email.id);

  // Parse the meeting notes
  const parsedNotes = parseMeetingNotes(email.body);

  // Generate follow-up draft
  const draftFollowUp = await generateFollowUpEmail(llm, email, parsedNotes);

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ` *New Meeting Notes*`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${email.subject}*\nFrom: ${email.from.name || 'Unknown'} <${email.from.email}>\nDate: ${new Date(email.date).toLocaleDateString()}`,
      },
    },
  ];

  if (parsedNotes.keyPoints.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Key Points:*\n${parsedNotes.keyPoints.slice(0, 5).map(p => `• ${p}`).join('\n')}`,
      },
    });
  }

  if (parsedNotes.actionItems.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Action Items:*\n${parsedNotes.actionItems.slice(0, 5).map(a => `• ${a}`).join('\n')}`,
      },
    });
  }

  if (draftFollowUp) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Draft Follow-up:*\n\`\`\`${draftFollowUp.slice(0, 500)}${draftFollowUp.length > 500 ? '...' : ''}\`\`\``,
      },
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✉️ Send Follow-up', emoji: true },
        style: 'primary',
        action_id: 'discovery_send_followup',
        value: JSON.stringify({
          emailId: email.id,
          recipient: email.from.email,
          recipientName: email.from.name || email.from.email,
          subject: `Re: ${email.subject}`,
          draft: draftFollowUp,
        }),
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: ' Skip', emoji: true },
        action_id: 'discovery_skip_email',
        value: email.id,
      },
    ],
  });

  await slackClient.chat.postMessage({
    channel: config.slack.channelId,
    text: `New meeting notes from ${email.from.name || email.from.email}`,
    blocks,
  });
}

/**
 * Get count of seen meeting notes
 */
export function getSeenMeetingNotesCount(): number {
  return seenMeetingNotes.size;
}

