/**
 * Lead Follow-up Cadence Engine
 * 
 * Manages the follow-up cadence for sales leads:
 * - Tracks when follow-ups are due
 * - Detects responses (email replies)
 * - Generates follow-up drafts based on cadence stage
 * - Surfaces follow-ups in Slack for approval
 * 
 * Cadence:
 * - Day 2-3: First follow-up
 * - Day 7: Second follow-up
 * - Day 14: Third follow-up
 * - Day 21: Final follow-up, then mark cold
 */

import type { WebClient } from '@slack/web-api';
import type { KnownBlock } from '@slack/bolt';
import type { ResponsesAPIClient } from '../llm/responses.js';
import {
  getUnipileClient,
  getActiveEmailAccountId,
  type UnipileEmail,
} from '../tools/unipile.js';
import {
  getAllActiveLeads,
  getLeadsByFollowUpStage,
  getLeadsByThreads,
  getWarmLeadsForFollowUp,
  recordEmailSent,
  markLeadResponded,
  markLeadCold,
  type SalesLead,
} from '../db/sales-leads.js';
import { LEAD_FOLLOWUP_PROMPT } from './prompts.js';
import { getContentGenerationConfig } from '../config/models.js';
import { generateContent } from '../llm/content-generator.js';
import { getEmailHistoryContext } from './meeting-followup.js';
import type { DiscoveryConfig } from './config.js';

// =============================================================================
// TYPES
// =============================================================================

export interface FollowUpDue {
  lead: SalesLead;
  stage: 'first' | 'second' | 'third' | 'final';
  daysSinceLastEmail: number;
  isWarm: boolean;  // Opened but hasn't replied - high priority
}

export interface ResponseDetected {
  lead: SalesLead;
  responseEmail: UnipileEmail;
}

// =============================================================================
// CADENCE CONFIGURATION
// =============================================================================

const CADENCE = {
  first: { minDays: 2, maxFollowups: 0 },   // First follow-up after 2 days
  second: { minDays: 4, maxFollowups: 1 },  // Second follow-up 4 days after first
  third: { minDays: 7, maxFollowups: 2 },   // Third follow-up 7 days after second
  final: { minDays: 7, maxFollowups: 3 },   // Final follow-up 7 days after third
} as const;

// =============================================================================
// RESPONSE DETECTION
// =============================================================================

/**
 * Check for responses to tracked email threads
 * Returns leads where the recipient has replied
 */
export async function detectResponses(): Promise<ResponseDetected[]> {
  const client = getUnipileClient();
  const emailAccountId = await getActiveEmailAccountId();

  if (!client || !emailAccountId) {
    return [];
  }

  const activeLeads = getAllActiveLeads();
  const leadsWithThreads = activeLeads.filter(l => l.email_thread_id);

  if (leadsWithThreads.length === 0) {
    return [];
  }

  console.log(`[LeadFollowup] Checking ${leadsWithThreads.length} threads for responses...`);

  const responses: ResponseDetected[] = [];

  for (const lead of leadsWithThreads) {
    try {
      const threadEmails = await client.getEmailThread({
        account_id: emailAccountId,
        thread_id: lead.email_thread_id!,
      });

      // Check if any email in thread is FROM the lead (not from us)
      const responseEmail = threadEmails.find(email => {
        const fromEmail = email.from?.email?.toLowerCase();
        return fromEmail === lead.email.toLowerCase();
      });

      if (responseEmail) {
        // Check if this response is newer than our last email
        const responseDate = new Date(responseEmail.date);
        const lastEmailDate = lead.last_email_date ? new Date(lead.last_email_date) : null;

        if (!lastEmailDate || responseDate > lastEmailDate) {
          responses.push({ lead, responseEmail });
        }
      }
    } catch (error) {
      console.error(`[LeadFollowup] Failed to check thread ${lead.email_thread_id}:`, error);
    }
  }

  console.log(`[LeadFollowup] Detected ${responses.length} responses`);
  return responses;
}

/**
 * Process detected responses - mark leads as responded and notify Slack
 */
export async function processResponses(
  slackClient: WebClient,
  responses: ResponseDetected[],
  config: DiscoveryConfig
): Promise<void> {
  for (const { lead, responseEmail } of responses) {
    // Mark lead as responded
    markLeadResponded(lead.id, 'email');

    // Notify Slack
    const blocks: KnownBlock[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${lead.name || lead.email} replied*\n${lead.company ? `${lead.company} • ` : ''}Re: ${lead.meeting_title || 'Follow-up'}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `>${responseEmail.body?.split('\n').slice(0, 3).join('\n>') || 'No preview available'}`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View in Gmail' },
            url: `https://mail.google.com/mail/u/0/#inbox/${responseEmail.id}`,
            action_id: 'view_email_external',
          },
        ],
      },
    ];

    await slackClient.chat.postMessage({
      channel: config.slack.channelId,
      text: `${lead.name || lead.email} replied to your email`,
      blocks,
    });

    console.log(`[LeadFollowup] Notified Slack of response from ${lead.email}`);
  }
}

// =============================================================================
// FOLLOW-UP SCHEDULING
// =============================================================================

/**
 * Get leads that are due for a follow-up
 * Warm leads (opened but no reply) are prioritized
 */
export function getFollowUpsDue(): FollowUpDue[] {
  const stages = getLeadsByFollowUpStage();
  const warmLeadIds = new Set(getWarmLeadsForFollowUp().map(l => l.id));
  const due: FollowUpDue[] = [];

  const now = new Date();

  // Process each stage
  for (const lead of stages.firstFollowup) {
    const days = getDaysSinceLastEmail(lead, now);
    due.push({ lead, stage: 'first', daysSinceLastEmail: days, isWarm: warmLeadIds.has(lead.id) });
  }

  for (const lead of stages.secondFollowup) {
    const days = getDaysSinceLastEmail(lead, now);
    due.push({ lead, stage: 'second', daysSinceLastEmail: days, isWarm: warmLeadIds.has(lead.id) });
  }

  for (const lead of stages.thirdFollowup) {
    const days = getDaysSinceLastEmail(lead, now);
    due.push({ lead, stage: 'third', daysSinceLastEmail: days, isWarm: warmLeadIds.has(lead.id) });
  }

  for (const lead of stages.finalFollowup) {
    const days = getDaysSinceLastEmail(lead, now);
    due.push({ lead, stage: 'final', daysSinceLastEmail: days, isWarm: warmLeadIds.has(lead.id) });
  }

  // Sort: warm leads first, then by days since last email
  due.sort((a, b) => {
    if (a.isWarm && !b.isWarm) return -1;
    if (!a.isWarm && b.isWarm) return 1;
    return b.daysSinceLastEmail - a.daysSinceLastEmail;
  });

  return due;
}

function getDaysSinceLastEmail(lead: SalesLead, now: Date): number {
  if (!lead.last_email_date) return 0;
  const lastEmail = new Date(lead.last_email_date);
  return Math.floor((now.getTime() - lastEmail.getTime()) / (1000 * 60 * 60 * 24));
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
 * - Every follow-up must add insight
 * - First 8 words are everything
 * - Personality beats templates
 */
export async function generateFollowUpDraft(
  llm: ResponsesAPIClient,
  lead: SalesLead,
  stage: 'first' | 'second' | 'third' | 'final'
): Promise<{ subject: string; body: string }> {
  const stageNumber = { first: 1, second: 2, third: 3, final: 4 }[stage];
  const isWarmLead = lead.open_count > 0;

  try {
    // Get full email history for context
    const emailHistory = await getEmailHistoryContext(lead.email);
    
    // Format full email history
    let historyContext = '';
    if (emailHistory.recentEmails.length > 0) {
      historyContext = `\n\n=== FULL EMAIL HISTORY ===
${emailHistory.recentEmails.map(e => 
`--- ${e.date} | ${e.fromMe ? 'YOU SENT' : 'THEY SENT'} ---
Subject: ${e.subject}
${e.body}
`).join('\n')}`;
    }
    
    const prompt = LEAD_FOLLOWUP_PROMPT.replace('{followup_number}', stageNumber.toString());

    // Extract company name from email domain for web search
    const emailDomain = lead.email.split('@')[1];
    const companyName = lead.company || emailDomain?.replace('.com', '').replace('.co', '').replace('.io', '') || '';

    // ==========================================================================
    // STAGE 1: Use OpenAI with web search to gather company context
    // ==========================================================================
    let webContext = '';
    
    try {
      console.log(`[LeadFollowup] Stage 1: Gathering web context for ${companyName || 'prospect'}...`);
      
      const researchPrompt = `Search for recent news about "${companyName}" and return a brief summary (2-3 sentences) of anything relevant:
- Recent funding, acquisitions, or expansions
- New product launches or partnerships  
- Industry news affecting their business
- Competitor moves that matter to them

If no relevant news found, just say "No recent news found."`;

      const researchResponse = await llm.createResponse(researchPrompt, [], {
        reasoningEffort: 'low', // Just gathering facts
        useWebSearch: true,
      });
      
      webContext = researchResponse.outputText || '';
      if (webContext && !webContext.includes('No recent news found')) {
        console.log(`[LeadFollowup] Found web context: ${webContext.slice(0, 100)}...`);
        webContext = `\n\n=== RECENT NEWS/CONTEXT (from web search) ===\n${webContext}`;
      } else {
        webContext = '';
        console.log(`[LeadFollowup] No relevant web context found`);
      }
    } catch (error) {
      console.warn('[LeadFollowup] Web search failed, continuing without:', error);
      webContext = '';
    }

    // ==========================================================================
    // STAGE 2: Use Claude Opus 4.5 (high effort) for writing
    // ==========================================================================
    console.log(`[LeadFollowup] Stage 2: Generating ${stage} follow-up with Claude Opus 4.5 (effort: high)...`);

    const userPrompt = `Lead: ${lead.name || lead.email}
Company: ${companyName || 'Unknown'}
Original meeting: ${lead.meeting_title || 'Unknown'}
Meeting date: ${lead.meeting_date ? new Date(lead.meeting_date).toLocaleDateString() : 'Unknown'}
${webContext}

=== ORIGINAL MEETING NOTES ===
${lead.meeting_notes_summary || 'No summary available'}

=== FOLLOW-UP CONTEXT ===
Follow-up number: ${stageNumber} (${stage})
Days since last email: ${getDaysSinceLastEmail(lead, new Date())}
${isWarmLead ? `\n🔥 WARM LEAD: They opened your last email ${lead.open_count} time(s), last opened ${lead.last_opened_at ? new Date(lead.last_opened_at).toLocaleDateString() : 'recently'}. This suggests interest. Make it EASY to respond.` : ''}
${historyContext}

=== YOUR TASK ===
1. Generate follow-up #${stageNumber} with a SPECIFIC reason for emailing today
2. ${isWarmLead ? 'This is a WARM LEAD. Keep it short (1-2 sentences) with a simple yes/no question.' : 'Each follow-up must have a DIFFERENT angle. Dont repeat previous emails.'}
3. If web context is relevant, lead with it as your reason for emailing today.

Return JSON with "subject" and "body" fields.`;

    const result = await generateContent({
      systemPrompt: prompt,
      userPrompt,
      maxTokens: 1024, // Follow-ups should be shorter
      effort: 'high', // Use high effort for important messages
    }, llm);
    
    console.log(`[LeadFollowup] Follow-up generated by ${result.provider} (${result.model})`);
    
    const text = result.text || '';
    
    // Try to parse JSON response
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
          console.log(`[LeadFollowup] Generated ${stage} follow-up with subject: "${parsed.subject}"`);
          return {
            subject: parsed.subject,
            body: parsed.body,
          };
        }
      } catch (e) {
        // JSON parse failed, use text as body
        console.warn('[LeadFollowup] JSON parse failed:', e);
      }
    }
    
    // Fallback: use response as body with generated subject
    const subject = stage === 'final'
      ? `Underflow - Closing the loop`
      : `Underflow - Following up`;

    return { subject, body: text };
  } catch (error) {
    console.error('[LeadFollowup] Failed to generate draft:', error);
    
    // Return a simple fallback (these are placeholders, user will edit)
    const fallbacks = {
      first: 'Saw some relevant news about your space. Thought it might be useful.',
      second: 'Quick question about what you mentioned in our call. Is that still the main priority?',
      third: 'Know you\'re busy. Is this still on your radar or should I check back later?',
      final: 'Closing the loop. Reach out whenever timing is better.',
    };

    return {
      subject: `Underflow - ${stage === 'final' ? 'Closing the loop' : 'Quick follow-up'}`,
      body: fallbacks[stage],
    };
  }
}

// =============================================================================
// SLACK SURFACING
// =============================================================================

/**
 * Surface a follow-up due in Slack
 */
export async function surfaceFollowUp(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  followUp: FollowUpDue,
  config: DiscoveryConfig
): Promise<void> {
  const { lead, stage, daysSinceLastEmail, isWarm } = followUp;

  // Generate the draft
  const draft = await generateFollowUpDraft(llm, lead, stage);

  // Stage display names
  const stageNames = {
    first: '1st',
    second: '2nd',
    third: '3rd',
    final: 'Final',
  };

  // Warm indicator for leads who opened but haven't replied
  const warmIndicator = isWarm ? ' • *Opened your email*' : '';

  const blocks: KnownBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${stageNames[stage]} follow-up due: ${lead.name || lead.email}*\n${lead.company ? `${lead.company} • ` : ''}${daysSinceLastEmail} days since last contact${warmIndicator}`,
      },
    },
  ];

  // Show meeting context and open stats if available
  const contextParts: string[] = [];
  if (lead.meeting_title) {
    contextParts.push(`Original meeting: ${lead.meeting_title}`);
  }
  if (lead.open_count > 0) {
    contextParts.push(`Opened ${lead.open_count}x${lead.last_opened_at ? ` (last ${formatTimeAgo(new Date(lead.last_opened_at))})` : ''}`);
  }
  
  if (contextParts.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: contextParts.join(' • '),
      }],
    });
  }

  // Draft preview
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Draft:*\n>${draft.body.split('\n').join('\n>')}`,
    },
  });

  // Action buttons
  const actionElements: Array<{
    type: string;
    text: { type: string; text: string };
    style?: string;
    action_id: string;
    value?: string;
  }> = [
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Create Draft' },
      style: 'primary',
      action_id: 'lead_followup_send',
      value: JSON.stringify({
        leadId: lead.id,
        subject: draft.subject,
        body: draft.body,
        stage,
      }),
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Edit' },
      action_id: 'lead_followup_edit',
      value: JSON.stringify({
        leadId: lead.id,
        subject: draft.subject,
        body: draft.body,
        stage,
      }),
    },
    {
      type: 'button',
      text: { type: 'plain_text', text: 'Snooze 3 days' },
      action_id: 'lead_followup_snooze',
      value: JSON.stringify({ leadId: lead.id, days: 3 }),
    },
  ];

  // Add "Mark Cold" button for final follow-up
  if (stage === 'final') {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Mark Cold' },
      action_id: 'lead_mark_cold',
      value: lead.id,
    });
  } else {
    actionElements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Skip' },
      action_id: 'lead_followup_skip',
      value: lead.id,
    });
  }

  blocks.push({
    type: 'actions',
    elements: actionElements,
  } as KnownBlock);

  await slackClient.chat.postMessage({
    channel: config.slack.channelId,
    text: `Follow-up due: ${lead.name || lead.email}`,
    blocks,
  });

  console.log(`[LeadFollowup] Surfaced ${stage} follow-up for ${lead.email}`);
}

// =============================================================================
// MAIN DISCOVERY FUNCTIONS
// =============================================================================

/**
 * Run the follow-up cadence check
 * Called periodically (every few hours) by the scheduler
 */
export async function runFollowUpCadence(
  slackClient: WebClient,
  llm: ResponsesAPIClient,
  config: DiscoveryConfig
): Promise<void> {
  console.log('[LeadFollowup] Running follow-up cadence check...');

  // First, check for responses
  const responses = await detectResponses();
  if (responses.length > 0) {
    await processResponses(slackClient, responses, config);
  }

  // Then, get follow-ups that are due
  const followUpsDue = getFollowUpsDue();
  console.log(`[LeadFollowup] ${followUpsDue.length} follow-ups due`);

  // Surface each one (limit to avoid spam)
  const maxPerRun = 5;
  for (const followUp of followUpsDue.slice(0, maxPerRun)) {
    await surfaceFollowUp(slackClient, llm, followUp, config);
  }

  if (followUpsDue.length > maxPerRun) {
    console.log(`[LeadFollowup] ${followUpsDue.length - maxPerRun} more follow-ups pending`);
  }
}

/**
 * Run response detection only (more frequent check)
 */
export async function runResponseDetection(
  slackClient: WebClient,
  config: DiscoveryConfig
): Promise<void> {
  console.log('[LeadFollowup] Checking for responses...');

  const responses = await detectResponses();
  if (responses.length > 0) {
    await processResponses(slackClient, responses, config);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format a date as "X ago" (e.g., "2 hours ago", "3 days ago")
 */
function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'yesterday';
  return `${diffDays}d ago`;
}

