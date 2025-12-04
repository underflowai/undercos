/**
 * Webhook Event Handlers
 * 
 * Processes Unipile webhook events and surfaces them in Slack
 */

import type { WebClient } from '@slack/web-api';
import { env } from '../config/env.js';
import { getUnipileClient, getActiveAccountId } from '../tools/unipile.js';
import { getSentInvitation, removeSentInvitation } from '../tracking/invitations.js';

// Slack client will be set when the webhook server is initialized
let slackClient: WebClient | null = null;

export function setSlackClient(client: WebClient): void {
  slackClient = client;
}

// =============================================================================
// WEBHOOK EVENT TYPES
// =============================================================================

export interface WebhookEvent {
  event: string;
  account_id: string;
  account_type: string;
  webhook_name?: string;
  timestamp?: string;
  
  // For message_received
  chat_id?: string;
  message_id?: string;
  message?: string;
  sender?: {
    attendee_id: string;
    attendee_name: string;
    attendee_provider_id: string;
    attendee_profile_url?: string;
  };
  attendees?: Array<{
    attendee_id: string;
    attendee_name: string;
    attendee_provider_id: string;
    attendee_profile_url?: string;
  }>;
  account_info?: {
    type: string;
    feature: string;
    user_id: string;
  };
  
  // For new_relation
  user_full_name?: string;
  user_provider_id?: string;
  user_public_identifier?: string;
  user_profile_url?: string;
  user_picture_url?: string;
  
  // For mail events (delivery, bounce, etc.)
  email_id?: string;
  thread_id?: string;
  subject?: string;
  to?: string[];
  from?: string;
  delivery_status?: 'delivered' | 'bounced' | 'failed' | 'deferred';
  bounce_type?: 'hard' | 'soft';
  bounce_reason?: string;
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export async function handleWebhookEvent(event: WebhookEvent): Promise<void> {
  if (!slackClient) {
    console.warn('[Webhook] Slack client not initialized');
    return;
  }
  
  const channelId = env.DISCOVERY_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Webhook] No DISCOVERY_CHANNEL_ID configured');
    return;
  }
  
  switch (event.event) {
    case 'new_relation':
      await handleNewRelation(event, channelId);
      break;
      
    case 'message_received':
      await handleMessageReceived(event, channelId);
      break;
      
    case 'message_read':
    case 'message_delivered':
      // Ignore these events
      break;
      
    // Email events (from 'email' webhook source)
    case 'mail_sent':
      console.log(`[Webhook] Email sent: ${event.subject} (to: ${event.to?.join(', ')})`);
      // Could track delivery confirmation here
      break;
      
    case 'mail_received':
      await handleMailReceived(event, channelId);
      break;
      
    case 'mail_moved':
      // Email moved between folders
      console.log(`[Webhook] Email moved: ${event.subject}`);
      break;
      
    // Email tracking events (from 'email_tracking' webhook source)  
    case 'mail_opened':
      await handleEmailOpened(event, channelId);
      break;
      
    case 'mail_link_clicked':
      await handleEmailLinkClicked(event, channelId);
      break;
      
    default:
      console.log(`[Webhook] Unhandled event type: ${event.event}`);
  }
}

// =============================================================================
// NEW RELATION HANDLER (Connection Accepted)
// =============================================================================

async function handleNewRelation(event: WebhookEvent, channelId: string): Promise<void> {
  console.log(`[Webhook] Connection accepted: ${event.user_full_name}`);
  
  if (!slackClient) return;
  
  const profileUrl = event.user_profile_url || 
    (event.user_public_identifier ? `https://linkedin.com/in/${event.user_public_identifier}` : '');
  
  // Check if this was a tracked invitation (to avoid duplicate notifications from real-time detection)
  const tracked = getSentInvitation(event.user_provider_id || '');
  if (tracked?.notified) {
    console.log(`[Webhook] Already notified for ${event.user_full_name} via real-time detection`);
    return;
  }
  
  // Mark as notified and remove from tracking
  if (event.user_provider_id) {
    removeSentInvitation(event.user_provider_id);
  }
  
  const mention = env.DISCOVERY_MENTION_USER ? `<@${env.DISCOVERY_MENTION_USER}> ` : '';
  
  await slackClient.chat.postMessage({
    channel: channelId,
    text: `${mention}${event.user_full_name} accepted your connection request`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${event.user_full_name}* accepted your connection request`,
        },
        accessory: event.user_picture_url ? {
          type: 'image',
          image_url: event.user_picture_url,
          alt_text: event.user_full_name || 'Profile',
        } : undefined,
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: profileUrl ? `<${profileUrl}|View Profile>` : 'LinkedIn connection',
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Send Message', emoji: false },
            style: 'primary',
            action_id: 'linkedin_start_message',
            value: JSON.stringify({
              providerId: event.user_provider_id,
              name: event.user_full_name,
              profileUrl,
            }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Profile', emoji: false },
            url: profileUrl,
            action_id: 'linkedin_view_profile_link',
          },
        ],
      },
    ],
  });
}

// =============================================================================
// MESSAGE RECEIVED HANDLER
// =============================================================================

async function handleMessageReceived(event: WebhookEvent, channelId: string): Promise<void> {
  if (!slackClient || !event.sender || !event.message) return;
  
  // Check if this is our own message (sent from another device or API)
  const isOwnMessage = event.account_info?.user_id === event.sender.attendee_provider_id;
  
  if (isOwnMessage) {
    // This could be a connection acceptance (if message matches a sent connection note)
    await checkForConnectionAcceptance(event, channelId);
    return;
  }
  
  // It's an incoming message from someone else
  console.log(`[Webhook] New message from ${event.sender.attendee_name}: "${event.message.slice(0, 50)}..."`);
  
  const mention = env.DISCOVERY_MENTION_USER ? `<@${env.DISCOVERY_MENTION_USER}> ` : '';
  const profileUrl = event.sender.attendee_profile_url || '';
  
  // Truncate long messages
  const messagePreview = event.message.length > 200 
    ? event.message.slice(0, 200) + '...' 
    : event.message;
  
  await slackClient.chat.postMessage({
    channel: channelId,
    text: `${mention}New LinkedIn message from ${event.sender.attendee_name}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${event.sender.attendee_name}* sent you a message`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `>${messagePreview.replace(/\n/g, '\n>')}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `${new Date(event.timestamp || Date.now()).toLocaleString()}${profileUrl ? ` · <${profileUrl}|View Profile>` : ''}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Reply', emoji: false },
            style: 'primary',
            action_id: 'linkedin_reply',
            value: JSON.stringify({
              chatId: event.chat_id,
              senderId: event.sender.attendee_provider_id,
              senderName: event.sender.attendee_name,
              profileUrl,
            }),
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Thread', emoji: false },
            action_id: 'linkedin_view_thread',
            value: JSON.stringify({
              chatId: event.chat_id,
              senderName: event.sender.attendee_name,
            }),
          },
        ],
      },
    ],
  });
}

// =============================================================================
// REAL-TIME CONNECTION ACCEPTANCE DETECTION
// =============================================================================

// =============================================================================
// EMAIL EVENT HANDLERS
// =============================================================================

/**
 * Handle incoming email (mail_received)
 * This fires when we receive a new email - useful for detecting replies from leads
 */
async function handleMailReceived(event: WebhookEvent, channelId: string): Promise<void> {
  console.log(`[Webhook] Email received: ${event.subject} (from: ${event.from})`);
  
  // Check if this is a reply from a tracked lead
  if (event.thread_id) {
    try {
      const { getLeadsByThreads, markLeadResponded } = await import('../db/sales-leads.js');
      const leads = getLeadsByThreads([event.thread_id]);
      
      if (leads.length > 0) {
        const lead = leads[0];
        console.log(`[Webhook] Reply received from lead: ${lead.name || lead.email}`);
        
        // Mark lead as responded
        markLeadResponded(lead.id, 'email');
        
        // Notify in Slack
        if (slackClient) {
          await slackClient.chat.postMessage({
            channel: channelId,
            text: `${lead.name || lead.email} replied to your email`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*${lead.name || lead.email}* replied to your email`,
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Subject: "${event.subject || 'Unknown'}"${lead.company ? ` · ${lead.company}` : ''}`,
                  },
                ],
              },
            ],
          });
        }
      }
    } catch (error) {
      console.error('[Webhook] Failed to process email reply:', error);
    }
  }
}

/**
 * Handle email opened (from email_tracking webhook)
 * Records the open and notifies Slack (first open only to avoid noise)
 */
async function handleEmailOpened(event: WebhookEvent, channelId: string): Promise<void> {
  console.log(`[Webhook] Email opened: ${event.subject} (thread: ${event.thread_id})`);
  
  if (!event.thread_id) return;
  
  try {
    const { getLeadByThread, recordEmailOpen } = await import('../db/sales-leads.js');
    const lead = getLeadByThread(event.thread_id);
    
    if (lead) {
      const isFirstOpen = lead.open_count === 0;
      
      // Record the open
      recordEmailOpen(lead.id);
      
      // Only notify Slack on first open to avoid noise
      if (isFirstOpen && slackClient) {
        await slackClient.chat.postMessage({
          channel: channelId,
          text: `${lead.name || lead.email} opened your email`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*${lead.name || lead.email}* opened your email`,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `${lead.company ? `${lead.company} • ` : ''}${event.subject ? `"${event.subject}"` : 'Follow-up'}${lead.email_followup_count > 0 ? ` • Follow-up #${lead.email_followup_count}` : ''}`,
                },
              ],
            },
          ],
        });
        console.log(`[Webhook] Notified Slack of first email open from ${lead.email}`);
      } else if (!isFirstOpen) {
        console.log(`[Webhook] Email opened again (${lead.open_count + 1} times) by ${lead.email}`);
      }
    }
  } catch (error) {
    console.error('[Webhook] Failed to process email open:', error);
  }
}

/**
 * Handle email link clicked (from email_tracking webhook)
 * This is high engagement - notify Slack
 */
async function handleEmailLinkClicked(event: WebhookEvent, channelId: string): Promise<void> {
  console.log(`[Webhook] Email link clicked: ${event.subject} (thread: ${event.thread_id})`);
  
  if (!event.thread_id) return;
  
  try {
    const { getLeadByThread, recordEmailOpen } = await import('../db/sales-leads.js');
    const lead = getLeadByThread(event.thread_id);
    
    if (lead && slackClient) {
      // Also counts as an open
      recordEmailOpen(lead.id);
      
      await slackClient.chat.postMessage({
        channel: channelId,
        text: `${lead.name || lead.email} clicked a link in your email`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${lead.name || lead.email}* clicked a link in your email`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${lead.company ? `${lead.company} • ` : ''}High engagement signal`,
              },
            ],
          },
        ],
      });
      console.log(`[Webhook] Notified Slack of link click from ${lead.email}`);
    }
  } catch (error) {
    console.error('[Webhook] Failed to process link click:', error);
  }
}

// =============================================================================
// REAL-TIME CONNECTION ACCEPTANCE DETECTION
// =============================================================================

/**
 * Check if an outgoing message indicates a connection was just accepted
 * This happens when someone accepts a connection request that had a note attached
 */
async function checkForConnectionAcceptance(event: WebhookEvent, channelId: string): Promise<void> {
  if (!event.message || !event.sender) return;
  
  // Check if this message matches a tracked invitation
  const tracked = getSentInvitation(event.sender.attendee_provider_id);
  
  if (!tracked) {
    // Not a tracked invitation
    return;
  }
  
  // Check if the message matches the connection note we sent
  const messageMatches = tracked.note && event.message.includes(tracked.note.slice(0, 50));
  
  if (messageMatches && !tracked.notified) {
    console.log(`[Webhook] Real-time: ${event.sender.attendee_name} accepted connection (note matched)`);
    
    // Mark as notified to prevent duplicate from new_relation webhook
    tracked.notified = true;
    
    const profileUrl = event.sender.attendee_profile_url || '';
    const mention = env.DISCOVERY_MENTION_USER ? `<@${env.DISCOVERY_MENTION_USER}> ` : '';
    
    if (slackClient) {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: `${mention}${event.sender.attendee_name} accepted your connection request`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${event.sender.attendee_name}* accepted your connection request`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: profileUrl ? `<${profileUrl}|View Profile>` : 'LinkedIn connection',
              },
            ],
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Send Message', emoji: false },
                style: 'primary',
                action_id: 'linkedin_start_message',
                value: JSON.stringify({
                  providerId: event.sender.attendee_provider_id,
                  name: event.sender.attendee_name,
                  profileUrl,
                  chatId: event.chat_id,
                }),
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'View Profile', emoji: false },
                url: profileUrl,
                action_id: 'linkedin_view_profile_link',
              },
            ],
          },
        ],
      });
    }
  }
}

